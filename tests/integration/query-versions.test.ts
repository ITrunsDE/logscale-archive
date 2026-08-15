import pg from "pg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@archive/config";
import {
  activateQueryVersion,
  createDatabase,
  createQueryDraft,
  decryptSecret,
  encryptSecret,
  encryptedSecretFromBytes,
  encryptedSecretToBytes,
  migrateDatabase,
  testQueryVersion,
  validateAggregateResults,
  validateEventResults,
  validateQueryText,
} from "@archive/core";
import { resetLoginRateLimiter } from "../../apps/web/src/auth/rate-limit.js";
import { buildServer } from "../../apps/web/src/main.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://archive:change-me-local-only@127.0.0.1:5432/archive";

const SESSION_SECRET = "test-session-secret-at-least-32-characters-long";
const RECOVERY_SECRET = "test-recovery-secret-local-only";
const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_TOKEN = "integration-query-token-7a4b2e";

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

let connectionCounter = 0;

async function seedConnection(db: ReturnType<typeof createDatabase>): Promise<string> {
  connectionCounter += 1;
  const suffix = connectionCounter;
  const encrypted = encryptSecret(TEST_TOKEN, Buffer.from(ENCRYPTION_KEY, "hex"));
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO logscale_connections
       (name, endpoint, repository, token_ciphertext, token_key_id, status)
     VALUES ($1, $2, $3, $4, 'env-v1', 'valid')
     RETURNING id`,
    [
      `Primary-${suffix}`,
      `https://logscale.example/${suffix}`,
      `repo-a-${suffix}`,
      encryptedSecretToBytes(encrypted),
    ],
  );
  return inserted.rows[0]!.id;
}

function mockQueryJobFetch(events: unknown[]): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (method === "POST" && url.includes("/queryjobs") && !url.match(/queryjobs\/[^/]+$/)) {
      return new Response(JSON.stringify({ id: "job-1", state: "running" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "GET" && url.includes("/queryjobs/job-1") && !url.includes("/results")) {
      return new Response(JSON.stringify({ id: "job-1", state: "done" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "GET" && url.includes("/results")) {
      return new Response(
        JSON.stringify({ events, offset: 0, limit: 20, total: events.length, done: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
}

describe("query validation", () => {
  it("rejects head() and limiting tail(n)", () => {
    expect(validateQueryText("#repo=repo-a | head(10)", "event").ok).toBe(false);
    expect(validateQueryText("#repo=repo-a | tail(50)", "event").ok).toBe(false);
    expect(validateQueryText("#repo=repo-a | tail()", "event").ok).toBe(true);
  });

  it("requires fixed window for aggregate queries", () => {
    expect(validateQueryText("#repo=repo-a | count()", "aggregate").ok).toBe(false);
    expect(validateQueryText("#repo=repo-a | timeChart(span=1h, function=count())", "aggregate").ok).toBe(
      true,
    );
  });

  it("requires @id and #repo on event results", () => {
    expect(validateEventResults([{ message: "missing fields" }]).ok).toBe(false);
    expect(
      validateEventResults([{ "@id": "ev-1", "#repo": "repo-a", message: "ok" }]).ok,
    ).toBe(true);
  });

  it("requires aggregate results within the sample window", () => {
    const windowStart = "2026-01-01T00:00:00.000Z";
    const windowEnd = "2026-01-01T01:00:00.000Z";
    expect(
      validateAggregateResults([{ _time: "2026-01-01T00:30:00.000Z", _count: 1 }], windowStart, windowEnd)
        .ok,
    ).toBe(true);
    expect(
      validateAggregateResults([{ _time: "2026-01-02T00:00:00.000Z", _count: 1 }], windowStart, windowEnd)
        .ok,
    ).toBe(false);
  });
});

describe("query versions", () => {
  beforeAll(async () => {
    await resetDatabase(DATABASE_URL);
    await migrateDatabase(DATABASE_URL);
  }, 60_000);

  afterEach(() => {
    resetLoginRateLimiter();
    vi.unstubAllGlobals();
  });

  it("persists draft fields and does not create a schedule", async () => {
    applyEnv({});
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const connectionId = await seedConnection(db);

    const { version } = await createQueryDraft(db, {
      connectionId,
      name: "events",
      queryText: "#repo=repo-a",
      mode: "event",
      scheduleCron: "0 * * * *",
      scheduleTimezone: "Europe/Berlin",
      initialStartAt: "2026-01-01T00:00:00.000Z",
      correctionWindowSeconds: 120,
      retentionDays: 30,
    });

    expect(version).toMatchObject({
      connectionId,
      name: "events",
      versionNumber: 1,
      queryText: "#repo=repo-a",
      mode: "event",
      scheduleCron: "0 * * * *",
      scheduleTimezone: "Europe/Berlin",
      initialStartAt: "2026-01-01T00:00:00.000Z",
      correctionWindowSeconds: 120,
      retentionDays: 30,
      active: false,
      testPassedAt: null,
    });

    const schedule = await db.query("SELECT * FROM query_schedules WHERE query_version_id = $1", [
      version.id,
    ]);
    expect(schedule.rows).toHaveLength(0);

    await db.close();
    void config;
  });

  it("keeps the active version when a later invalid draft is saved", async () => {
    applyEnv({});
    const db = createDatabase(DATABASE_URL);
    const connectionId = await seedConnection(db);

    const active = await createQueryDraft(db, {
      connectionId,
      name: "events",
      queryText: "#repo=repo-a",
      mode: "event",
      initialStartAt: "2026-01-01T00:00:00.000Z",
      scheduleCron: "0 * * * *",
    });
    await db.query(`UPDATE query_versions SET test_passed_at = now(), active = true WHERE id = $1`, [
      active.version.id,
    ]);
    await db.query(
      `INSERT INTO query_schedules (query_version_id, next_run_at, paused)
       VALUES ($1, now(), false)`,
      [active.version.id],
    );

    await expect(
      createQueryDraft(db, {
        connectionId,
        name: "events",
        queryText: "#repo=repo-a | head(5)",
        mode: "event",
        initialStartAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ message: "invalid_query" });

    const rows = await db.query<{ id: string; active: boolean; version_number: number }>(
      `SELECT id, active, version_number
       FROM query_versions
       WHERE connection_id = $1 AND name = 'events'
       ORDER BY version_number`,
      [connectionId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ id: active.version.id, active: true, version_number: 1 });

    await db.close();
  });

  it("runs tests through LogScaleClient and requires passing test before activation", async () => {
    applyEnv({});
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const connectionId = await seedConnection(db);

    const { version } = await createQueryDraft(db, {
      connectionId,
      name: "events",
      queryText: "#repo=repo-a",
      mode: "event",
      initialStartAt: "2026-01-01T00:00:00.000Z",
      scheduleCron: "0 * * * *",
    });

    const failing = await testQueryVersion(
      db,
      { encryptionKey: config.encryptionKey, fetch: mockQueryJobFetch([{ message: "no id" }]) },
      version.id,
      { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" },
    );
    expect(failing.ok).toBe(false);
    expect(failing.errors.join(" ")).toContain("@id");

    await expect(activateQueryVersion(db, version.id)).rejects.toMatchObject({ message: "test_required" });

    const passing = await testQueryVersion(
      db,
      {
        encryptionKey: config.encryptionKey,
        fetch: mockQueryJobFetch([{ "@id": "ev-1", "#repo": "repo-a", message: "ok" }]),
      },
      version.id,
      { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" },
    );
    expect(passing.ok).toBe(true);
    expect(passing.sampleEvents).toHaveLength(1);

    await activateQueryVersion(db, version.id);
    const active = await db.query<{ active: boolean }>(
      "SELECT active FROM query_versions WHERE id = $1",
      [version.id],
    );
    expect(active.rows[0]!.active).toBe(true);

    const schedule = await db.query<{ paused: boolean }>(
      "SELECT paused FROM query_schedules WHERE query_version_id = $1",
      [version.id],
    );
    expect(schedule.rows[0]!.paused).toBe(false);

    await db.close();
  });

  it("exposes query routes and keeps prior active version after invalid draft via API", async () => {
    applyEnv({});
    vi.stubGlobal(
      "fetch",
      mockQueryJobFetch([{ "@id": "ev-1", "#repo": "repo-a", message: "ok" }]),
    );

    const db = createDatabase(DATABASE_URL);
    const connectionId = await seedConnection(db);
    const { app } = await buildServer();
    await app.ready();
    const { cookie, csrf } = await loginAsAdmin(app);

    const draft = await app.inject({
      method: "POST",
      url: "/api/admin/query-versions/drafts",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      payload: {
        connectionId,
        name: "events",
        queryText: "#repo=repo-a",
        mode: "event",
        scheduleCron: "0 * * * *",
        initialStartAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(draft.statusCode).toBe(201);
    const versionId = draft.json().version.id as string;

    const tested = await app.inject({
      method: "POST",
      url: `/api/admin/query-versions/${versionId}/test`,
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      payload: {
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-01T01:00:00.000Z",
      },
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json().result.ok).toBe(true);

    const activated = await app.inject({
      method: "POST",
      url: `/api/admin/query-versions/${versionId}/activate`,
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      payload: {},
    });
    expect(activated.statusCode).toBe(200);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/admin/query-versions/drafts",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      payload: {
        connectionId,
        name: "events",
        queryText: "#repo=repo-a | tail(10)",
        mode: "event",
        initialStartAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(invalid.statusCode).toBe(400);

    const listed = await app.inject({
      method: "GET",
      url: `/api/admin/query-versions?connectionId=${connectionId}&name=events`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().versions).toHaveLength(1);
    expect(listed.json().versions[0].active).toBe(true);
    expect(listed.json().versions[0].id).toBe(versionId);

    const storedToken = await db.query<{ token_ciphertext: Buffer }>(
      "SELECT token_ciphertext FROM logscale_connections WHERE id = $1",
      [connectionId],
    );
    const decrypted = decryptSecret(
      encryptedSecretFromBytes(storedToken.rows[0]!.token_ciphertext),
      loadConfig(process.env).encryptionKey,
    );
    expect(decrypted).toBe(TEST_TOKEN);

    await app.close();
    await db.close();
  });
});
