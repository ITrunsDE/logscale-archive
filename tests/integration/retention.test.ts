import pg from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@archive/config";
import {
  claimNextRun,
  createDatabase,
  encryptSecret,
  encryptedSecretToBytes,
  migrateDatabase,
} from "@archive/core";
import {
  createBackfill,
  getBackfillStatus,
  pauseBackfill,
  resumeBackfill,
} from "../../apps/worker/src/backfill.js";
import { applyRetention } from "../../apps/worker/src/retention.js";
import { canAcquireStorage } from "../../apps/worker/src/storageGuard.js";
import { runWorkerTick } from "../../apps/worker/src/main.js";
import { buildServer } from "../../apps/web/src/main.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://archive:change-me-local-only@127.0.0.1:5432/archive";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SESSION_SECRET = "test-session-secret-at-least-32-characters-long";

async function resetDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO archive;
      GRANT ALL ON SCHEMA public TO public;
    `);
  } finally {
    await client.end();
  }
}

function applyEnv(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, {
    APP_ROLE: "worker",
    DATABASE_URL,
    ENCRYPTION_KEY,
    SESSION_SECRET,
    DATA_PATH: "/tmp/archive-data",
    EXPORT_PATH: "/tmp/archive-export",
    BACKUP_PATH: "/tmp/archive-backup",
    ...overrides,
  });
}

function parseSetCookie(setCookie: string | string[] | undefined): string | undefined {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return header?.split(";")[0];
}

let connectionCounter = 0;

async function seedQueryVersion(
  db: ReturnType<typeof createDatabase>,
  options: { retentionDays?: number | null; active?: boolean } = {},
) {
  connectionCounter += 1;
  const suffix = connectionCounter;
  const encrypted = encryptSecret("retention-token", Buffer.from(ENCRYPTION_KEY, "hex"));
  const connection = await db.query<{ id: string }>(
    `INSERT INTO logscale_connections
       (name, endpoint, repository, token_ciphertext, token_key_id, status)
     VALUES ($1, $2, $3, $4, 'env-v1', 'valid')
     RETURNING id`,
    [
      `RetentionConn-${suffix}`,
      `https://logscale.example/${suffix}`,
      `repo-retention-${suffix}`,
      encryptedSecretToBytes(encrypted),
    ],
  );
  const connectionId = connection.rows[0]!.id;

  const version = await db.query<{ id: string }>(
    `INSERT INTO query_versions
       (connection_id, name, version_number, query_text, mode, initial_start_at, retention_days, active, test_passed_at)
     VALUES ($1, 'events', 1, '#repo=repo | tail()', 'event', '2026-01-01T00:00:00.000Z', $2, $3, now())
     RETURNING id`,
    [connectionId, options.retentionDays ?? null, options.active ?? true],
  );
  const queryVersionId = version.rows[0]!.id;

  await db.query(
    `INSERT INTO query_schedules (query_version_id, next_run_at, watermark_at, paused)
     VALUES ($1, NULL, '2026-01-01T00:00:00.000Z', false)`,
    [queryVersionId],
  );

  return queryVersionId;
}

async function seedEventRecord(
  db: ReturnType<typeof createDatabase>,
  queryVersionId: string,
  eventTimestamp: string,
  sourceEventId: string,
) {
  const windowStart = eventTimestamp;
  const windowEnd = new Date(Date.parse(eventTimestamp) + 3_600_000).toISOString();
  const run = await db.query<{ id: string }>(
    `INSERT INTO query_runs (query_version_id, kind, status, window_start, window_end)
     VALUES ($1, 'scheduled', 'complete', $2, $3)
     RETURNING id`,
    [queryVersionId, windowStart, windowEnd],
  );
  await db.query(
    `INSERT INTO event_records
       (query_version_id, query_run_id, source_repo, source_event_id, event_timestamp, payload)
     VALUES ($1, $2, 'repo', $3, $4, '{"@id":"x"}'::jsonb)`,
    [queryVersionId, run.rows[0]!.id, sourceEventId, eventTimestamp],
  );
}

describe("retention integration", () => {
  beforeAll(async () => {
    await resetDatabase(DATABASE_URL);
    await migrateDatabase(DATABASE_URL);
  }, 60_000);

  beforeEach(() => {
    connectionCounter = 0;
    applyEnv();
  });

  afterEach(async () => {
    const db = createDatabase(DATABASE_URL);
    await db.query(`TRUNCATE TABLE
      audit_entries, event_records, aggregate_snapshots, query_runs, backfill_windows,
      retention_holds, query_schedules, query_versions, logscale_connections, users, sessions
      RESTART IDENTITY CASCADE`);
    await db.close();
  });

  it("creates resumable UTC day backfill windows for arbitrary dates", async () => {
    const db = createDatabase(DATABASE_URL);
    const queryVersionId = await seedQueryVersion(db);

    await createBackfill(db, queryVersionId, "2025-11-30T18:00:00.000Z", "2025-12-02T06:00:00.000Z");

    let status = await getBackfillStatus(db, queryVersionId);
    expect(status.windows).toHaveLength(3);
    expect(status.pending).toBe(3);

    await pauseBackfill(db, queryVersionId);
    status = await getBackfillStatus(db, queryVersionId);
    expect(status.paused).toBe(3);
    expect(status.pending).toBe(0);

    await resumeBackfill(db, queryVersionId);
    status = await getBackfillStatus(db, queryVersionId);
    expect(status.pending).toBe(3);

    await db.close();
  });

  it("keeps held records when retention runs", async () => {
    const db = createDatabase(DATABASE_URL);
    const heldVersionId = await seedQueryVersion(db, { retentionDays: 7 });
    await seedEventRecord(db, heldVersionId, "2020-01-01T00:00:00.000Z", "held-event");

    const admin = await db.query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('admin', 'hash', 'admin') RETURNING id`,
    );
    await db.query(
      `INSERT INTO retention_holds (query_version_id, reason, created_by_user_id)
       VALUES ($1, 'legal hold', $2)`,
      [heldVersionId, admin.rows[0]!.id],
    );

    const outcome = await applyRetention(db, new Date("2026-01-01T00:00:00.000Z"));
    expect(outcome.deletedEvents).toBe(0);

    const remaining = await db.query(`SELECT 1 FROM event_records WHERE query_version_id = $1`, [
      heldVersionId,
    ]);
    expect(remaining.rows).toHaveLength(1);

    await db.close();
  });

  it("deletes expired records only for eligible query versions", async () => {
    const db = createDatabase(DATABASE_URL);
    const eligibleId = await seedQueryVersion(db, { retentionDays: 30 });
    const noPolicyId = await seedQueryVersion(db, { retentionDays: null });
    const heldId = await seedQueryVersion(db, { retentionDays: 30 });

    await seedEventRecord(db, eligibleId, "2020-01-01T00:00:00.000Z", "eligible-old");
    await seedEventRecord(db, eligibleId, "2026-01-15T00:00:00.000Z", "eligible-new");
    await seedEventRecord(db, noPolicyId, "2020-01-01T00:00:00.000Z", "no-policy-old");
    await seedEventRecord(db, heldId, "2020-01-01T00:00:00.000Z", "held-old");

    const admin = await db.query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('admin2', 'hash', 'admin') RETURNING id`,
    );
    await db.query(
      `INSERT INTO retention_holds (query_version_id, reason, created_by_user_id)
       VALUES ($1, 'hold', $2)`,
      [heldId, admin.rows[0]!.id],
    );

    const outcome = await applyRetention(db, new Date("2026-02-01T00:00:00.000Z"));
    expect(outcome.deletedEvents).toBe(1);

    const eligibleOld = await db.query(
      `SELECT 1 FROM event_records WHERE query_version_id = $1 AND source_event_id = 'eligible-old'`,
      [eligibleId],
    );
    const eligibleNew = await db.query(
      `SELECT 1 FROM event_records WHERE query_version_id = $1 AND source_event_id = 'eligible-new'`,
      [eligibleId],
    );
    const noPolicy = await db.query(
      `SELECT 1 FROM event_records WHERE query_version_id = $1 AND source_event_id = 'no-policy-old'`,
      [noPolicyId],
    );
    const held = await db.query(
      `SELECT 1 FROM event_records WHERE query_version_id = $1 AND source_event_id = 'held-old'`,
      [heldId],
    );

    expect(eligibleOld.rows).toHaveLength(0);
    expect(eligibleNew.rows).toHaveLength(1);
    expect(noPolicy.rows).toHaveLength(1);
    expect(held.rows).toHaveLength(1);

    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_entries WHERE action = 'retention.delete.batch'`,
    );
    expect(audit.rows).toHaveLength(1);

    await db.close();
  });

  it("blocks new worker jobs when disk usage is critical", async () => {
    applyEnv({ APP_ROLE: "worker" });
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const queryVersionId = await seedQueryVersion(db);

    await db.query(
      `INSERT INTO query_runs (query_version_id, kind, status, window_start, window_end)
       VALUES ($1, 'scheduled', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z')`,
      [queryVersionId],
    );

    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const worked = await runWorkerTick(
      db,
      {
        encryptionKey: config.encryptionKey,
        fetch: fetchImpl,
        storageGuard: {
          paths: ["/data"],
          statfs: () => ({ blocks: 100, bsize: 1024, bfree: 5 }),
        },
        backup: {
          dumpDatabase: async (_url, filePath) => {
            await import("node:fs/promises").then((fs) => fs.writeFile(filePath, "-- test dump\n"));
          },
        },
      },
      "worker-storage-block",
    );

    expect(worked).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();

    const run = await db.query<{ status: string }>(
      `SELECT status FROM query_runs WHERE query_version_id = $1`,
      [queryVersionId],
    );
    expect(run.rows[0]!.status).toBe("pending");

    await db.close();
  });

  it("audits retention holds and exposes storage on status API", async () => {
    applyEnv({ APP_ROLE: "web", APP_BIND: "127.0.0.1", APP_PORT: "0", SECURE_COOKIES: "false" });
    const db = createDatabase(DATABASE_URL);
    const queryVersionId = await seedQueryVersion(db, { retentionDays: 30 });

    const { app } = await buildServer();
    await app.ready();

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      payload: { username: "admin", password: "bootstrap-password-14" },
    });
    const cookie = parseSetCookie(bootstrap.headers["set-cookie"])!;
    const csrf = bootstrap.json().csrfToken as string;

    const hold = await app.inject({
      method: "POST",
      url: "/api/admin/retention/holds",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { queryVersionId, reason: "audit test" },
    });
    expect(hold.statusCode).toBe(201);

    const status = await app.inject({
      method: "GET",
      url: "/api/admin/system/status",
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().storage).toHaveProperty("decision");

    const publicStatus = await app.inject({ method: "GET", url: "/api/status" });
    expect(publicStatus.json().storage.decision).toBeDefined();

    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_entries WHERE action = 'retention.hold'`,
    );
    expect(audit.rows).toHaveLength(1);

    await app.close();
    await db.close();
  });

  it("classifies storage decisions at 80 and 90 percent", () => {
    const warn = canAcquireStorage({
      paths: ["/v1"],
      statfs: () => ({ blocks: 100, bsize: 1, bfree: 15 }),
    });
    expect(warn.decision).toBe("warn");

    const block = canAcquireStorage({
      paths: ["/v1"],
      statfs: () => ({ blocks: 100, bsize: 1, bfree: 5 }),
    });
    expect(block.decision).toBe("block");
  });
});
