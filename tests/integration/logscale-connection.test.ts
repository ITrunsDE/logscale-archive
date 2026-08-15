import pg from "pg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@archive/config";
import {
  createDatabase,
  createUser,
  decryptSecret,
  encryptedSecretFromBytes,
  migrateDatabase,
} from "@archive/core";
import { resetLoginRateLimiter } from "../../apps/web/src/auth/rate-limit.js";
import { buildServer } from "../../apps/web/src/main.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://archive:change-me-local-only@127.0.0.1:5432/archive";

const SESSION_SECRET = "test-session-secret-at-least-32-characters-long";
const RECOVERY_SECRET = "test-recovery-secret-local-only";
const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_TOKEN = "integration-logscale-token-9f2d1c";

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

function mockLogscaleFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/v1/status")) {
      return new Response(JSON.stringify({ version: "1.201.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/v1/repositories/repo-a")) {
      return new Response(JSON.stringify({ name: "repo-a" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/v1/self")) {
      return new Response(
        JSON.stringify({
          permissions: ["read"],
          expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
}

describe("logscale connection routes", () => {
  beforeAll(async () => {
    await resetDatabase(DATABASE_URL);
    await migrateDatabase(DATABASE_URL);
  }, 60_000);

  afterEach(() => {
    resetLoginRateLimiter();
    vi.unstubAllGlobals();
  });

  it("stores encrypted tokens and never returns plaintext from the API", async () => {
    applyEnv({});
    vi.stubGlobal("fetch", mockLogscaleFetch());
    const config = loadConfig(process.env);
    const { app } = await buildServer();
    await app.ready();
    const { cookie, csrf } = await loginAsAdmin(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/logscale-connections",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      payload: {
        name: "Primary",
        endpoint: "https://logscale.example",
        repository: "repo-a",
        token: TEST_TOKEN,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain(TEST_TOKEN);
    expect(created.json().connection).toMatchObject({
      name: "Primary",
      endpoint: "https://logscale.example",
      repository: "repo-a",
      status: "valid",
    });
    expect(created.json().validation).toMatchObject({
      ok: true,
      repositoryAccessible: true,
    });
    expect(created.json().connection).not.toHaveProperty("token");

    const db = createDatabase(DATABASE_URL);
    const stored = await db.query<{ token_ciphertext: Buffer }>(
      "SELECT token_ciphertext FROM logscale_connections WHERE name = 'Primary'",
    );
    const decrypted = decryptSecret(
      encryptedSecretFromBytes(stored.rows[0]!.token_ciphertext),
      config.encryptionKey,
    );
    expect(decrypted).toBe(TEST_TOKEN);

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/logscale-connections",
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.json())).not.toContain(TEST_TOKEN);

    await db.close();
    await app.close();
  });

  it("updates a connection and validates immediately, keeping token when omitted", async () => {
    applyEnv({});
    vi.stubGlobal("fetch", mockLogscaleFetch());
    const config = loadConfig(process.env);
    const { app } = await buildServer();
    await app.ready();
    const { cookie, csrf } = await loginAsAdmin(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/logscale-connections",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      payload: {
        name: "Editable",
        endpoint: "https://logscale-edit.example",
        repository: "repo-a",
        token: TEST_TOKEN,
      },
    });
    expect(created.statusCode).toBe(201);
    const connectionId = created.json().connection.id as string;

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/admin/logscale-connections/${connectionId}`,
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      payload: {
        name: "Editable Renamed",
        endpoint: "https://cloud.community.humio.com",
        repository: "repo-a",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().connection).toMatchObject({
      name: "Editable Renamed",
      endpoint: "https://cloud.community.humio.com",
      repository: "repo-a",
      status: "valid",
    });
    expect(updated.json().validation.ok).toBe(true);
    expect(JSON.stringify(updated.json())).not.toContain(TEST_TOKEN);

    const db = createDatabase(DATABASE_URL);
    const stored = await db.query<{ token_ciphertext: Buffer }>(
      "SELECT token_ciphertext FROM logscale_connections WHERE id = $1",
      [connectionId],
    );
    expect(
      decryptSecret(encryptedSecretFromBytes(stored.rows[0]!.token_ciphertext), config.encryptionKey),
    ).toBe(TEST_TOKEN);

    await db.close();
    await app.close();
  });

  it("validates a connection and records permission warnings", async () => {
    applyEnv({});
    vi.stubGlobal("fetch", mockLogscaleFetch());

    const { app } = await buildServer();
    await app.ready();
    const { cookie, csrf } = await loginAsAdmin(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/logscale-connections",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      payload: {
        name: "Validated",
        endpoint: "https://logscale-validated.example",
        repository: "repo-a",
        token: TEST_TOKEN,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().connection.status).toBe("valid");
    expect(created.json().validation).toMatchObject({
      ok: true,
      repositoryAccessible: true,
      serverVersion: "1.201.0",
    });
    const connectionId = created.json().connection.id as string;

    const validated = await app.inject({
      method: "POST",
      url: `/api/admin/logscale-connections/${connectionId}/validate`,
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      payload: {},
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.json().validation).toMatchObject({
      ok: true,
      repositoryAccessible: true,
      serverVersion: "1.201.0",
    });
    expect(validated.json().connection.status).toBe("valid");
    expect(JSON.stringify(validated.json())).not.toContain(TEST_TOKEN);

    await app.close();
  });

  it("rejects validation when repository is inaccessible", async () => {
    applyEnv({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/status")) {
          return new Response(JSON.stringify({ version: "1.201.0" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/v1/repositories/repo-a")) {
          return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as typeof fetch,
    );

    const { app } = await buildServer();
    await app.ready();
    const { cookie, csrf } = await loginAsAdmin(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/logscale-connections",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      payload: {
        name: "Blocked",
        endpoint: "https://logscale-blocked.example",
        repository: "repo-a",
        token: TEST_TOKEN,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().connection.status).toBe("invalid");
    expect(created.json().validation.ok).toBe(false);
    expect(created.json().validation.repositoryAccessible).toBe(false);
    const connectionId = created.json().connection.id as string;

    const validated = await app.inject({
      method: "POST",
      url: `/api/admin/logscale-connections/${connectionId}/validate`,
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      payload: {},
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.json().validation.ok).toBe(false);
    expect(validated.json().validation.repositoryAccessible).toBe(false);
    expect(validated.json().connection.status).toBe("invalid");

    await app.close();
  });

  it("warns when token permissions exceed read-only access", async () => {
    applyEnv({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/status")) {
          return new Response(JSON.stringify({ version: "1.201.0" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/v1/repositories/repo-a")) {
          return new Response(JSON.stringify({ name: "repo-a" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/api/v1/self")) {
          return new Response(JSON.stringify({ permissions: ["read", "write"] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as typeof fetch,
    );

    const { app } = await buildServer();
    await app.ready();
    const { cookie, csrf } = await loginAsAdmin(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/logscale-connections",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      payload: {
        name: "Overprivileged",
        endpoint: "https://logscale-overprivileged.example",
        repository: "repo-a",
        token: TEST_TOKEN,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().connection.status).toBe("warning");
    expect(created.json().validation.ok).toBe(false);
    expect(created.json().validation.permissionWarnings.length).toBeGreaterThan(0);
    const connectionId = created.json().connection.id as string;

    const validated = await app.inject({
      method: "POST",
      url: `/api/admin/logscale-connections/${connectionId}/validate`,
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      payload: {},
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.json().validation.ok).toBe(false);
    expect(validated.json().validation.permissionWarnings.length).toBeGreaterThan(0);
    expect(validated.json().connection.status).toBe("warning");

    await app.close();
  });

  it("forbids viewers from managing connections", async () => {
    applyEnv({});
    const db = createDatabase(DATABASE_URL);
    await createUser(db, {
      username: "viewer",
      password: "viewer-password-14",
      role: "viewer",
    });

    const { app } = await buildServer();
    await app.ready();
    await loginAsAdmin(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "viewer", password: "viewer-password-14" },
    });
    const viewerCookie = parseSetCookie(login.headers["set-cookie"])!;

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/logscale-connections",
      headers: { cookie: viewerCookie },
    });
    expect(listed.statusCode).toBe(403);

    await db.close();
    await app.close();
  });
});
