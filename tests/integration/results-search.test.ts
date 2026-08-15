import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@archive/config";
import {
  canDownloadExport,
  createDatabase,
  createExport,
  createUser,
  deleteExport,
  encryptSecret,
  encryptedSecretToBytes,
  expireExports,
  exportFilePath,
  isExportPath,
  listSearchableQueryVersions,
  migrateDatabase,
  pathsIncludedInBackup,
  searchStoredResults,
} from "@archive/core";
import { resetLoginRateLimiter } from "../../apps/web/src/auth/rate-limit.js";
import { buildServer } from "../../apps/web/src/main.js";
import { processExportJobs } from "../../apps/worker/src/exportJob.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://archive:change-me-local-only@127.0.0.1:5432/archive";

const SESSION_SECRET = "test-session-secret-at-least-32-characters-long";
const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let exportDir = "";

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
    EXPORT_PATH: exportDir,
    BACKUP_PATH: join(tmpdir(), "archive-backup-test"),
    DATA_PATH: join(tmpdir(), "archive-data-test"),
    ...overrides,
  });
}

function parseSetCookie(setCookie: string | string[] | undefined): string | undefined {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return header?.split(";")[0];
}

async function login(
  app: Awaited<ReturnType<typeof buildServer>>["app"],
  username: string,
  password: string,
) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(login.statusCode).toBe(200);
  return {
    cookie: parseSetCookie(login.headers["set-cookie"])!,
    csrf: login.json().csrfToken as string,
    userId: login.json().user.id as string,
  };
}

let connectionCounter = 0;

async function seedArchivedEvents(db: ReturnType<typeof createDatabase>) {
  connectionCounter += 1;
  const suffix = connectionCounter;
  const encrypted = encryptSecret("results-search-token", Buffer.from(ENCRYPTION_KEY, "hex"));
  const connection = await db.query<{ id: string }>(
    `INSERT INTO logscale_connections
       (name, endpoint, repository, token_ciphertext, token_key_id, status)
     VALUES ($1, $2, $3, $4, 'env-v1', 'valid')
     RETURNING id`,
    [
      `SearchConn-${suffix}`,
      `https://logscale.example/${suffix}`,
      `repo-a-${suffix}`,
      encryptedSecretToBytes(encrypted),
    ],
  );
  const connectionId = connection.rows[0]!.id;

  const version = await db.query<{ id: string }>(
    `INSERT INTO query_versions
       (connection_id, name, version_number, query_text, mode, initial_start_at, active, test_passed_at)
     VALUES ($1, 'events', 1, '#repo=repo-a | tail()', 'event', '2026-01-01T00:00:00.000Z', true, now())
     RETURNING id`,
    [connectionId],
  );
  const queryVersionId = version.rows[0]!.id;

  const run = await db.query<{ id: string }>(
    `INSERT INTO query_runs
       (query_version_id, kind, status, window_start, window_end, result_count, finished_at)
     VALUES ($1, 'scheduled', 'complete', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 3, now())
     RETURNING id`,
    [queryVersionId],
  );
  const queryRunId = run.rows[0]!.id;

  const rows = [
    {
      id: "evt-1",
      ts: "2026-01-01T00:10:00.000Z",
      message: "alpha",
      severity: "info",
    },
    {
      id: "evt-2",
      ts: "2026-01-01T00:20:00.000Z",
      message: "beta",
      severity: "warn",
    },
    {
      id: "evt-3",
      ts: "2026-01-01T00:30:00.000Z",
      message: "gamma",
      severity: "info",
    },
  ];

  for (const row of rows) {
    await db.query(
      `INSERT INTO event_records
         (query_version_id, query_run_id, source_repo, source_event_id, event_timestamp, payload)
       VALUES ($1, $2, 'repo-a', $3, $4, $5::jsonb)`,
      [
        queryVersionId,
        queryRunId,
        row.id,
        row.ts,
        JSON.stringify({ message: row.message, severity: row.severity }),
      ],
    );
  }

  return { queryVersionId, queryRunId };
}

describe("archived results search and exports", () => {
  beforeAll(async () => {
    exportDir = mkdtempSync(join(tmpdir(), "archive-export-test-"));
    await resetDatabase(DATABASE_URL);
    await migrateDatabase(DATABASE_URL);
  }, 60_000);

  beforeEach(() => {
    rmSync(exportDir, { recursive: true, force: true });
    exportDir = mkdtempSync(join(tmpdir(), "archive-export-test-"));
  });

  afterEach(() => {
    resetLoginRateLimiter();
    vi.restoreAllMocks();
  });

  it("lists inactive query versions for archived search", async () => {
    applyEnv();
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedArchivedEvents(db);
    await db.query(`UPDATE query_versions SET active = false WHERE id = $1`, [queryVersionId]);

    const versions = await listSearchableQueryVersions(db);
    const match = versions.find((version) => version.id === queryVersionId);
    expect(match).toBeDefined();
    expect(match?.active).toBe(false);

    await db.close();
  });

  it("filters archived results by metadata, time, and JSON fields without LogScale", async () => {
    applyEnv();
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedArchivedEvents(db);

    const fetchSpy = vi.fn();
    const actor = { userId: "viewer-id", role: "viewer" as const };

    const all = await searchStoredResults(
      db,
      { queryVersionId, limit: 50, offset: 0 },
      actor,
    );
    expect(all.total).toBe(3);
    expect(all.columns).toContain("message");
    expect(all.rows[0]?.runStatus).toBe("complete");
    expect(fetchSpy).not.toHaveBeenCalled();

    const timeFiltered = await searchStoredResults(
      db,
      {
        queryVersionId,
        from: "2026-01-01T00:15:00.000Z",
        to: "2026-01-01T00:25:00.000Z",
      },
      actor,
    );
    expect(timeFiltered.total).toBe(1);
    expect(timeFiltered.rows[0]?.payload.message).toBe("beta");

    const jsonFiltered = await searchStoredResults(
      db,
      {
        queryVersionId,
        jsonFilters: [{ field: "severity", value: "info" }],
      },
      actor,
    );
    expect(jsonFiltered.total).toBe(2);

    await db.close();
  });

  it("records viewer search audit entries", async () => {
    applyEnv();
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedArchivedEvents(db);

    const viewer = await createUser(db, {
      username: "viewer-search",
      password: "viewer-password-14",
      role: "viewer",
    });

    const { app } = await buildServer();
    await app.ready();
    const session = await login(app, "viewer-search", "viewer-password-14");

    const search = await app.inject({
      method: "POST",
      url: "/api/results/search",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
      payload: {
        queryVersionId,
        jsonFilters: [{ field: "severity", value: "info" }],
      },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().results.total).toBe(2);

    const audit = await db.query<{ action: string; actor_user_id: string; metadata: Record<string, unknown> }>(
      `SELECT action, actor_user_id, metadata
       FROM audit_entries
       WHERE action = 'results.search'
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    expect(audit.rows[0]?.actor_user_id).toBe(viewer.id);
    expect(audit.rows[0]?.metadata).toMatchObject({ resultCount: 2 });

    await app.close();
    await db.close();
  });

  it("restricts export downloads to requester or admin and expires files", async () => {
    applyEnv();
    loadConfig();
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedArchivedEvents(db);

    const requester = await createUser(db, {
      username: "export-owner",
      password: "viewer-password-14",
      role: "viewer",
    });
    const other = await createUser(db, {
      username: "export-other",
      password: "viewer-password-14",
      role: "viewer",
    });

    const job = await createExport(db, {
      queryVersionId,
      format: "csv",
      filters: { queryVersionId },
      requestedByUserId: requester.id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await processExportJobs(db);
    const completed = await db.query<{ file_path: string | null; status: string }>(
      `SELECT file_path, status FROM exports WHERE id = $1`,
      [job.id],
    );
    expect(completed.rows[0]?.status).toBe("complete");
    const filePath = completed.rows[0]?.file_path;
    expect(filePath).toBeTruthy();
    expect(existsSync(filePath!)).toBe(true);
    expect(isExportPath(filePath!)).toBe(true);
    expect(pathsIncludedInBackup().every((path) => !filePath!.startsWith(path))).toBe(true);

    const { app } = await buildServer();
    await app.ready();
    const ownerSession = await login(app, "export-owner", "viewer-password-14");
    const otherSession = await login(app, "export-other", "viewer-password-14");

    const ownerDownload = await app.inject({
      method: "GET",
      url: `/api/exports/${job.id}/download`,
      headers: { cookie: ownerSession.cookie },
    });
    expect(ownerDownload.statusCode).toBe(200);

    const blocked = await app.inject({
      method: "GET",
      url: `/api/exports/${job.id}/download`,
      headers: { cookie: otherSession.cookie },
    });
    expect(blocked.statusCode).toBe(403);

    const expiredCount = await expireExports(db, new Date(Date.now() + 120_000));
    expect(expiredCount).toBe(1);
    expect(existsSync(filePath!)).toBe(false);

    const refreshed = await db.query<{ status: string }>(
      `SELECT status FROM exports WHERE id = $1`,
      [job.id],
    );
    expect(refreshed.rows[0]?.status).toBe("expired");
    expect(canDownloadExport(job, requester.id, "viewer")).toBe(true);

    await app.close();
    await db.close();
  });

  it("writes export files under EXPORT_PATH only", async () => {
    applyEnv();
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedArchivedEvents(db);
    const admin = await createUser(db, {
      username: "export-admin",
      password: "viewer-password-14",
      role: "admin",
    });

    const job = await createExport(db, {
      queryVersionId,
      format: "ndjson",
      filters: { queryVersionId },
      requestedByUserId: admin.id,
    });

    const expected = exportFilePath(job.id, "ndjson");
    await processExportJobs(db);
    expect(existsSync(expected)).toBe(true);
    expect(isExportPath(expected)).toBe(true);

    await db.close();
  });

  it("deletes export row and file", async () => {
    applyEnv();
    loadConfig();
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedArchivedEvents(db);
    const owner = await createUser(db, {
      username: "export-deleter",
      password: "viewer-password-14",
      role: "viewer",
    });

    const job = await createExport(db, {
      queryVersionId,
      format: "csv",
      filters: { queryVersionId },
      requestedByUserId: owner.id,
    });
    await processExportJobs(db);
    const path = exportFilePath(job.id, "csv");
    expect(existsSync(path)).toBe(true);

    const { app } = await buildServer();
    await app.ready();
    const session = await login(app, "export-deleter", "viewer-password-14");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/exports/${job.id}`,
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
    });
    expect(deleted.statusCode).toBe(204);
    expect(existsSync(path)).toBe(false);
    expect(await deleteExport(db, job.id)).toBe("not_found");

    await app.close();
    await db.close();
  });
});
