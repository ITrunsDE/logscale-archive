import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@archive/config";
import {
  createBackup,
  createDatabase,
  createUser,
  enterMaintenanceMode,
  exitMaintenanceMode,
  getBackupRun,
  isMaintenanceMode,
  migrateDatabase,
  restoreBackup,
  type BackupDeps,
} from "@archive/core";
import { resetLoginRateLimiter } from "../../apps/web/src/auth/rate-limit.js";
import { buildServer } from "../../apps/web/src/main.js";
import { processScheduledBackup } from "../../apps/worker/src/backupJob.js";
import { runWorkerTick } from "../../apps/worker/src/main.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://archive:change-me-local-only@127.0.0.1:5432/archive";

const SESSION_SECRET = "test-session-secret-at-least-32-characters-long";
const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const INSTANCE_NAME = "archive-test-instance";

let backupDir = "";
let dataDir = "";
let healthFile = "";

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
    APP_ROLE: "web",
    APP_BIND: "127.0.0.1",
    APP_PORT: "0",
    DATABASE_URL,
    SESSION_SECRET,
    ENCRYPTION_KEY,
    SECURE_COOKIES: "false",
    EXPORT_PATH: join(tmpdir(), "archive-export-backup-test"),
    BACKUP_PATH: backupDir,
    DATA_PATH: dataDir,
    INSTANCE_NAME,
    WORKER_HEALTH_FILE: healthFile,
    BACKUP_INTERVAL_MS: "0",
    ...overrides,
  });
}

function parseSetCookie(setCookie: string | string[] | undefined): string | undefined {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return header?.split(";")[0];
}

async function seedAdmin(db: ReturnType<typeof createDatabase>) {
  const existing = await db.query(`SELECT id FROM users WHERE username = 'admin'`);
  if (existing.rows[0]) {
    return;
  }
  await createUser(db, {
    username: "admin",
    password: "bootstrap-password-14",
    role: "admin",
  });
}

async function dumpAuditEntries(url: string, filePath: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const audits = await client.query<{ action: string; metadata: unknown }>(
      `SELECT action, metadata FROM audit_entries ORDER BY action`,
    );
    const lines = ["DELETE FROM audit_entries;"];
    for (const row of audits.rows) {
      lines.push(
        `INSERT INTO audit_entries (action, metadata) VALUES ('${row.action.replace(/'/g, "''")}', '${JSON.stringify(row.metadata).replace(/'/g, "''")}'::jsonb);`,
      );
    }
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  } finally {
    await client.end();
  }
}

async function restoreAuditEntries(url: string, filePath: string): Promise<void> {
  const sql = await import("node:fs/promises").then((fs) => fs.readFile(filePath, "utf8"));
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function backupDeps(): BackupDeps {
  return {
    env: process.env,
    dumpDatabase: dumpAuditEntries,
    restoreDatabase: restoreAuditEntries,
  };
}

async function markerCount(db: ReturnType<typeof createDatabase>, action: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_entries WHERE action = $1`,
    [action],
  );
  return Number(result.rows[0]!.count);
}

describe("backup and restore", () => {
  beforeAll(async () => {
    backupDir = mkdtempSync(join(tmpdir(), "archive-backup-int-"));
    dataDir = mkdtempSync(join(tmpdir(), "archive-data-int-"));
    healthFile = join(tmpdir(), `worker-health-${Date.now()}.txt`);
    applyEnv();
    await resetDatabase(DATABASE_URL);
    await migrateDatabase(DATABASE_URL);
  });

  beforeEach(() => {
    applyEnv();
    exitMaintenanceMode();
  });

  afterEach(() => {
    exitMaintenanceMode();
    resetLoginRateLimiter();
    vi.restoreAllMocks();
  });

  it("creates scheduled backup with status and checksum", async () => {
    applyEnv({ APP_ROLE: "worker", BACKUP_INTERVAL_MS: "0" });
    const db = createDatabase(DATABASE_URL);
    await seedAdmin(db);

    const ran = await processScheduledBackup(db, process.env, backupDeps());
    expect(ran).toBe(true);

    const backups = await db.query<{ status: string; checksum: string | null }>(
      `SELECT status, checksum FROM backup_runs ORDER BY created_at DESC LIMIT 1`,
    );
    expect(backups.rows[0]?.status).toBe("complete");
    expect(backups.rows[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);

    await db.close();
  });

  it("rejects restore when confirmation does not match instance name", async () => {
    const db = createDatabase(DATABASE_URL);
    await seedAdmin(db);
    const backup = await createBackup(db, backupDeps());

    await expect(
      restoreBackup(
        db,
        {
          backupId: backup.id,
          confirmation: "wrong-instance",
        },
        backupDeps(),
      ),
    ).rejects.toThrow("Restore confirmation mismatch");

    await db.close();
  });

  it("blocks worker job acquisition during maintenance", async () => {
    applyEnv({ APP_ROLE: "worker" });
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    await seedAdmin(db);

    const version = await db.query<{ id: string }>(
      `INSERT INTO logscale_connections (name, endpoint, repository, token_ciphertext, token_key_id, status)
       VALUES ('c', 'https://example.test', 'repo', '\\x00', 'env-v1', 'valid')
       RETURNING id`,
    );
    const queryVersion = await db.query<{ id: string }>(
      `INSERT INTO query_versions
         (connection_id, name, version_number, query_text, mode, initial_start_at, active, test_passed_at)
       VALUES ($1, 'q', 1, '#repo=repo | tail()', 'event', '2026-01-01T00:00:00.000Z', true, now())
       RETURNING id`,
      [version.rows[0]!.id],
    );
    await db.query(
      `INSERT INTO query_runs (query_version_id, kind, status, window_start, window_end)
       VALUES ($1, 'scheduled', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z')`,
      [queryVersion.rows[0]!.id],
    );

    await enterMaintenanceMode("test lock");
    expect(isMaintenanceMode()).toBe(true);

    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const worked = await runWorkerTick(
      db,
      { encryptionKey: config.encryptionKey, fetch: fetchImpl },
      "worker-maint",
    );
    expect(worked).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();

    await db.close();
  });

  it("creates safety backup and restores pre-restore state", async () => {
    const db = createDatabase(DATABASE_URL);
    await seedAdmin(db);

    await db.query(
      `INSERT INTO audit_entries (action, metadata) VALUES ('pre-restore-marker-a', '{"phase":"before"}')`,
    );
    const backup = await createBackup(db, backupDeps());

    await db.query(
      `INSERT INTO audit_entries (action, metadata) VALUES ('pre-restore-marker-b', '{"phase":"after-backup"}')`,
    );
    expect(await markerCount(db, "pre-restore-marker-b")).toBe(1);

    const outcome = await restoreBackup(
      db,
      {
        backupId: backup.id,
        confirmation: INSTANCE_NAME,
      },
      backupDeps(),
    );
    expect(outcome.integrityOk).toBe(true);

    expect(await markerCount(db, "pre-restore-marker-a")).toBe(1);
    expect(await markerCount(db, "pre-restore-marker-b")).toBe(0);

    const safety = await getBackupRun(db, outcome.safetyBackupId);
    expect(safety?.status).toBe("complete");

    const safetyContents = await import("node:fs/promises").then((fs) =>
      fs.readFile(safety!.filePath!, "utf8"),
    );
    expect(safetyContents).toContain("pre-restore-marker-b");

    await db.close();
  });

  it("exposes operations status and restore mismatch via API", async () => {
    applyEnv({ APP_ROLE: "web", APP_BIND: "127.0.0.1", APP_PORT: "0", SECURE_COOKIES: "false" });
    const db = createDatabase(DATABASE_URL);
    await seedAdmin(db);
    await createBackup(db, backupDeps());
    const backup = await db.query<{ id: string }>(
      `SELECT id FROM backup_runs WHERE status = 'complete' ORDER BY created_at DESC LIMIT 1`,
    );

    const { app } = await buildServer();
    await app.ready();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "bootstrap-password-14" },
    });
    const cookie = parseSetCookie(login.headers["set-cookie"])!;
    const csrf = login.json().csrfToken as string;

    const status = await app.inject({
      method: "GET",
      url: "/api/admin/operations/status",
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().database.ok).toBe(true);
    expect(status.json().backups.length).toBeGreaterThan(0);

    writeFileSync(healthFile, new Date().toISOString(), "utf8");
    const statusWithWorker = await app.inject({
      method: "GET",
      url: "/api/admin/operations/status",
      headers: { cookie },
    });
    expect(statusWithWorker.json().worker.ok).toBe(true);

    const mismatch = await app.inject({
      method: "POST",
      url: "/api/admin/operations/restore",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { backupId: backup.rows[0]!.id, confirmation: "wrong-name" },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toBe("confirmation_mismatch");

    await app.close();
    await db.close();
  });

  it("blocks viewer API during maintenance", async () => {
    applyEnv({ APP_ROLE: "web", APP_BIND: "127.0.0.1", APP_PORT: "0", SECURE_COOKIES: "false" });
    const db = createDatabase(DATABASE_URL);
    await seedAdmin(db);
    const viewerExists = await db.query(`SELECT id FROM users WHERE username = 'viewer'`);
    if (!viewerExists.rows[0]) {
      await createUser(db, {
        username: "viewer",
        password: "viewer-password-14",
        role: "viewer",
      });
    }

    const { app } = await buildServer();
    await app.ready();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "viewer", password: "viewer-password-14" },
    });
    const cookie = parseSetCookie(login.headers["set-cookie"])!;

    await enterMaintenanceMode("viewer block test");
    const blocked = await app.inject({
      method: "GET",
      url: "/api/results/query-versions",
      headers: { cookie },
    });
    expect(blocked.statusCode).toBe(503);

    await app.close();
    await db.close();
  });
});

describe("backup and restore teardown", () => {
  it("cleans temp dirs", () => {
    rmSync(backupDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
