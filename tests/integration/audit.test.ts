import pg from "pg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@archive/config";
import {
  createDatabase,
  encryptSecret,
  encryptedSecretToBytes,
  ENCRYPTION_KEY_ID,
  migrateDatabase,
  sanitizeAuditMetadata,
  writeAuditEntry,
} from "@archive/core";
import { resetLoginRateLimiter } from "../../apps/web/src/auth/rate-limit.js";
import {
  recordExportRequestAudit,
  recordResultsSearchAudit,
} from "../../apps/web/src/routes/audit.js";
import { buildServer } from "../../apps/web/src/main.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://archive:change-me-local-only@127.0.0.1:5432/archive";

const SESSION_SECRET = "test-session-secret-at-least-32-characters-long";
const RECOVERY_SECRET = "test-recovery-secret-local-only";
const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_TOKEN = "audit-test-logscale-token-7f3c9a2b";

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
    RECOVERY_SECRET,
    ENCRYPTION_KEY,
    SECURE_COOKIES: "false",
    ...overrides,
  });
}

function parseSetCookie(setCookie: string | string[] | undefined): string | undefined {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) {
    return undefined;
  }
  return header.split(";")[0];
}

async function loginAsAdmin(app: Awaited<ReturnType<typeof buildServer>>["app"]) {
  const status = await app.inject({ method: "GET", url: "/api/auth/status" });
  if (status.json().needsBootstrap) {
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      payload: { username: "admin", password: "bootstrap-password-14" },
    });
    expect(bootstrap.statusCode).toBe(201);
    return {
      cookie: parseSetCookie(bootstrap.headers["set-cookie"])!,
      csrf: bootstrap.json().csrfToken as string,
    };
  }

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password: "bootstrap-password-14" },
  });
  expect(login.statusCode).toBe(200);
  return {
    cookie: parseSetCookie(login.headers["set-cookie"])!,
    csrf: login.json().csrfToken as string,
  };
}

describe("audit and configuration export", () => {
  beforeAll(async () => {
    await resetDatabase(DATABASE_URL);
    await migrateDatabase(DATABASE_URL);
  }, 60_000);

  afterEach(() => {
    resetLoginRateLimiter();
  });

  it("sanitizes forbidden audit metadata fields", () => {
    const metadata = sanitizeAuditMetadata({
      resultCount: 12,
      filters: { repository: "repo-a" },
      token: TEST_TOKEN,
      payload: [{ id: "event-1" }],
      nested: { password: "secret", resultCount: 3 },
    });

    expect(metadata).toEqual({
      resultCount: 12,
      filters: { repository: "repo-a" },
      nested: { resultCount: 3 },
    });
    expect(JSON.stringify(metadata)).not.toContain(TEST_TOKEN);
  });

  it("exports configuration without secrets and writes payload-free audit rows", async () => {
    applyEnv({});
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const encrypted = encryptSecret(TEST_TOKEN, config.encryptionKey);
    await db.query(
      `INSERT INTO logscale_connections
         (name, endpoint, repository, token_ciphertext, token_key_id)
       VALUES ('Primary', 'https://logscale.example', 'repo-a', $1, $2)
       RETURNING id`,
      [encryptedSecretToBytes(encrypted), ENCRYPTION_KEY_ID],
    );

    const connection = await db.query<{ id: string }>(
      "SELECT id FROM logscale_connections WHERE name = 'Primary'",
    );
    await db.query(
      `INSERT INTO query_versions
         (connection_id, name, version_number, query_text, mode, initial_start_at, active)
       VALUES ($1, 'events', 1, '#repo=repo-a', 'event', now(), true)`,
      [connection.rows[0]!.id],
    );

    const { app } = await buildServer();
    await app.ready();
    const { cookie } = await loginAsAdmin(app);

    const exported = await app.inject({
      method: "GET",
      url: "/api/admin/config/export?format=json",
      headers: { cookie },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain(TEST_TOKEN);
    expect(exported.body).not.toContain("token_ciphertext");
    expect(exported.json().connections[0]).toMatchObject({
      name: "Primary",
      endpoint: "https://logscale.example",
      repository: "repo-a",
    });

    const auditRows = await db.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata
       FROM audit_entries
       WHERE action = 'config.export'`,
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0]!.metadata).toMatchObject({
      format: "json",
      connectionCount: 1,
      queryVersionCount: 1,
    });
    expect(JSON.stringify(auditRows.rows[0]!.metadata)).not.toContain(TEST_TOKEN);

    logSpy.mockRestore();
    await app.close();
    await db.close();
  });

  it("previews imported configuration with disabled query versions and no tokens", async () => {
    applyEnv({});
    const { app } = await buildServer();
    await app.ready();
    const { cookie } = await loginAsAdmin(app);

    const preview = await app.inject({
      method: "POST",
      url: "/api/admin/config/import/preview",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        version: 1,
        exportedAt: "2026-01-01T00:00:00.000Z",
        connections: [
          {
            name: "Imported",
            endpoint: "https://import.example",
            repository: "repo-b",
            status: "unknown",
            token: TEST_TOKEN,
          },
        ],
        queryVersions: [
          {
            connectionEndpoint: "https://import.example",
            connectionRepository: "repo-b",
            name: "imports",
            versionNumber: 1,
            queryText: "#repo=repo-b",
            mode: "event",
            scheduleCron: null,
            scheduleTimezone: "UTC",
            initialStartAt: "2026-01-01T00:00:00.000Z",
            correctionWindowSeconds: 0,
            retentionDays: null,
            active: true,
          },
        ],
      },
    });

    expect(preview.statusCode).toBe(200);
    const body = preview.json();
    expect(body.preview.connections[0]).not.toHaveProperty("token");
    expect(body.preview.queryVersions[0].active).toBe(false);
    expect(JSON.stringify(body)).not.toContain(TEST_TOKEN);

    await app.close();
  });

  it("records export and search audit metadata without payloads", async () => {
    applyEnv({});
    const db = createDatabase(DATABASE_URL);
    const { app } = await buildServer();
    await app.ready();
    const { cookie } = await loginAsAdmin(app);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    const userId = me.json().user.id as string;

    const request = {
      session: {
        id: "session-id",
        userId,
        csrfSecret: "csrf",
        user: { id: userId, username: "admin", role: "admin" as const },
        expiresAt: new Date(Date.now() + 60_000),
      },
      ip: "127.0.0.1",
      headers: {},
    };

    await recordResultsSearchAudit(db, request as never, {
      resultCount: 4,
      filters: { repository: "repo-a", token: TEST_TOKEN, payload: [{ id: "x" }] },
    });
    await recordExportRequestAudit(db, request as never, {
      resultCount: 4,
      format: "csv",
      filters: { repository: "repo-a" },
    });

    const rows = await db.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata
       FROM audit_entries
       WHERE action IN ('results.search', 'exports.request')
       ORDER BY action`,
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.metadata).not.toHaveProperty("payload");
      expect(row.metadata).not.toHaveProperty("token");
      expect(JSON.stringify(row.metadata)).not.toContain(TEST_TOKEN);
    }
    expect(rows.rows[0]!.metadata).toMatchObject({ format: "csv", resultCount: 4 });
    expect(rows.rows[1]!.metadata).toMatchObject({ resultCount: 4 });

    await app.close();
    await db.close();
  });

  it("lists audit entries for admins", async () => {
    applyEnv({});
    const db = createDatabase(DATABASE_URL);
    await writeAuditEntry(db, {
      action: "config.import.preview",
      metadata: { connectionCount: 0, queryVersionCount: 0 },
    });

    const { app } = await buildServer();
    await app.ready();
    const { cookie } = await loginAsAdmin(app);

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/audit?action=config.import.preview",
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().entries.length).toBeGreaterThan(0);
    expect(listed.json().entries[0].metadata).not.toHaveProperty("payload");

    await app.close();
    await db.close();
  });
});
