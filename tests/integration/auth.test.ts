import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@archive/config";
import {
  createDatabase,
  createRecoveryAdmin,
  createSession,
  getPasswordPolicy,
  migrateDatabase,
  resolveSession,
  revokeSession,
  updatePasswordPolicy,
  validatePassword,
} from "@archive/core";
import { resetLoginRateLimiter } from "../../apps/web/src/auth/rate-limit.js";
import { buildServer } from "../../apps/web/src/main.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://archive:change-me-local-only@127.0.0.1:5432/archive";

const SESSION_SECRET = "test-session-secret-at-least-32-characters-long";
const RECOVERY_SECRET = "test-recovery-secret-local-only";
const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

function applyEnv(overrides: Record<string, string>): void {
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

describe("auth integration", () => {
  beforeAll(async () => {
    await resetDatabase(DATABASE_URL);
    await migrateDatabase(DATABASE_URL);
  }, 60_000);

  afterEach(() => {
    resetLoginRateLimiter();
  });

  it("bootstraps the first admin and establishes a session", async () => {
    applyEnv({});
    const { app } = await buildServer();
    await app.ready();

    const status = await app.inject({ method: "GET", url: "/api/auth/status" });
    expect(status.json()).toEqual({ needsBootstrap: true });

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      payload: { username: "admin", password: "bootstrap-password-14" },
    });
    expect(bootstrap.statusCode).toBe(201);
    expect(bootstrap.json().user).toMatchObject({ username: "admin", role: "admin" });
    expect(bootstrap.json().user).not.toHaveProperty("password_hash");
    expect(bootstrap.json()).toHaveProperty("csrfToken");

    const cookie = parseSetCookie(bootstrap.headers["set-cookie"]);
    expect(cookie).toBeDefined();

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookie! },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe("admin");

    await app.close();
  });

  it("denies viewers on admin routes", async () => {
    applyEnv({});
    const { app } = await buildServer();
    await app.ready();

    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "bootstrap-password-14" },
    });
    const adminCookie = parseSetCookie(adminLogin.headers["set-cookie"])!;
    const adminCsrf = adminLogin.json().csrfToken as string;

    const createViewer = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
      payload: {
        username: "viewer1",
        password: "viewer-password-14",
        role: "viewer",
      },
    });
    expect(createViewer.statusCode).toBe(201);

    const viewerLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "viewer1", password: "viewer-password-14" },
    });
    const viewerCookie = parseSetCookie(viewerLogin.headers["set-cookie"])!;

    const denied = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: viewerCookie },
    });
    expect(denied.statusCode).toBe(403);

    await app.close();
  });

  it("revokes sessions on logout and blocks reuse", async () => {
    applyEnv({});
    const { app } = await buildServer();
    await app.ready();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "bootstrap-password-14" },
    });
    const cookie = parseSetCookie(login.headers["set-cookie"])!;
    const csrf = login.json().csrfToken as string;

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, "x-csrf-token": csrf },
    });
    expect(logout.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(401);

    await app.close();
  });

  it("persists configurable minimum password length", async () => {
    const db = createDatabase(DATABASE_URL);
    try {
      const updated = await updatePasswordPolicy(db, {
        minLength: 16,
        requireUpper: false,
        requireLower: false,
        requireDigit: false,
        requireSymbol: false,
        historyCount: 0,
      });
      expect(updated.minLength).toBe(16);

      const policy = await getPasswordPolicy(db);
      const errors = validatePassword("short-password", policy);
      expect(errors.some((message) => message.includes("16"))).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("recovery invalidates existing sessions and writes audit entry", async () => {
    applyEnv({});
    const db = createDatabase(DATABASE_URL);
    const { app } = await buildServer();
    await app.ready();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "bootstrap-password-14" },
    });
    const cookie = parseSetCookie(login.headers["set-cookie"])!;

    const beforeMe = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(beforeMe.statusCode).toBe(200);

    const recovery = await createRecoveryAdmin(db, {
      username: "admin",
      password: "recovery-password-16",
      recoverySecret: RECOVERY_SECRET,
      expectedRecoverySecret: RECOVERY_SECRET,
    });
    expect(recovery.sessionsRevoked).toBeGreaterThan(0);

    const afterMe = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(afterMe.statusCode).toBe(401);

    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_entries WHERE action = 'recovery.admin_reset'`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);

    await app.close();
    await db.close();
  });

  it("requires secure cookies when non-localhost mode is enabled", async () => {
    applyEnv({ APP_BIND: "0.0.0.0", SECURE_COOKIES: "true" });
    const config = loadConfig(process.env);
    expect(config.secureCookies).toBe(true);

    const { app } = await buildServer();
    await app.ready();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "recovery-password-16" },
    });
    expect(login.statusCode).toBe(200);

    const setCookie = login.headers["set-cookie"];
    const header = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie ?? "");
    expect(header.toLowerCase()).toContain("secure");

    await app.close();
  });

  it("rejects mutating requests without CSRF token", async () => {
    applyEnv({ SECURE_COOKIES: "false" });
    const { app } = await buildServer();
    await app.ready();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "recovery-password-16" },
    });
    const cookie = parseSetCookie(login.headers["set-cookie"])!;

    const denied = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    expect(denied.statusCode).toBe(403);

    await app.close();
  });

  it("rate limits failed login attempts", async () => {
    applyEnv({ SECURE_COOKIES: "false" });
    const { app } = await buildServer();
    await app.ready();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "wrong-password-value" },
      });
      expect(failed.statusCode).toBe(401);
    }

    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "wrong-password-value" },
    });
    expect(locked.statusCode).toBe(429);

    await app.close();
  });

  it("never exposes password hashes from list users", async () => {
    applyEnv({ SECURE_COOKIES: "false" });
    const { app } = await buildServer();
    await app.ready();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "recovery-password-16" },
    });
    const cookie = parseSetCookie(login.headers["set-cookie"])!;
    const csrf = login.json().csrfToken as string;

    const users = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie, "x-csrf-token": csrf },
    });
    expect(users.statusCode).toBe(200);
    for (const user of users.json().users) {
      expect(user).not.toHaveProperty("password_hash");
      expect(user).not.toHaveProperty("token_hash");
    }

    await app.close();
  });

  it("lets a signed-in user change their password and keeps the current session", async () => {
    applyEnv({ SECURE_COOKIES: "false" });
    const { app } = await buildServer();
    await app.ready();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "recovery-password-16" },
    });
    const cookie = parseSetCookie(login.headers["set-cookie"])!;
    const csrf = login.json().csrfToken as string;

    const other = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "recovery-password-16" },
    });
    const otherCookie = parseSetCookie(other.headers["set-cookie"])!;

    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
        currentPassword: "recovery-password-16",
        newPassword: "changed-password-20",
      },
    });
    expect(changed.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);

    const otherMe = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: otherCookie },
    });
    expect(otherMe.statusCode).toBe(401);

    const loginNew = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "changed-password-20" },
    });
    expect(loginNew.statusCode).toBe(200);

    await app.close();
  });

  it("lets an admin set or generate a user password and revokes all sessions", async () => {
    applyEnv({ SECURE_COOKIES: "false" });
    const { app } = await buildServer();
    await app.ready();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "changed-password-20" },
    });
    const cookie = parseSetCookie(login.headers["set-cookie"])!;
    const csrf = login.json().csrfToken as string;

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
        username: "reset-target",
        password: "viewer-password-14",
        role: "viewer",
      },
    });
    expect(created.statusCode).toBe(201);
    const userId = created.json().user.id as string;

    const viewerLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "reset-target", password: "viewer-password-14" },
    });
    const viewerCookie = parseSetCookie(viewerLogin.headers["set-cookie"])!;

    const setPassword = await app.inject({
      method: "POST",
      url: `/api/admin/users/${userId}/password`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { password: "viewer-password-99" },
    });
    expect(setPassword.statusCode).toBe(200);
    expect(setPassword.json()).toEqual({ ok: true });

    const viewerAfter = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: viewerCookie },
    });
    expect(viewerAfter.statusCode).toBe(401);

    const generated = await app.inject({
      method: "POST",
      url: `/api/admin/users/${userId}/password`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { generate: true },
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().generatedPassword).toEqual(expect.any(String));
    expect(generated.json().generatedPassword.length).toBeGreaterThanOrEqual(12);

    const loginGenerated = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "reset-target",
        password: generated.json().generatedPassword,
      },
    });
    expect(loginGenerated.statusCode).toBe(200);

    await app.close();
  });

  it("deletes non-admin users but protects the admin account", async () => {
    applyEnv({ SECURE_COOKIES: "false" });
    const { app } = await buildServer();
    await app.ready();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "changed-password-20" },
    });
    const cookie = parseSetCookie(login.headers["set-cookie"])!;
    const csrf = login.json().csrfToken as string;

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { username: "delete-target", password: "viewer-password-14", role: "viewer" },
    });
    const userId = created.json().user.id as string;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${userId}`,
      headers: { cookie, "x-csrf-token": csrf },
    });
    expect(deleted.statusCode).toBe(204);

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie },
    });
    expect(listed.json().users).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: userId })]));

    const adminId = listed.json().users.find((entry: { username: string }) => entry.username === "admin").id;
    const protectedDelete = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${adminId}`,
      headers: { cookie, "x-csrf-token": csrf },
    });
    expect(protectedDelete.statusCode).toBe(403);

    await app.close();
  });

  it("resolves sessions only while active", async () => {
    const db = createDatabase(DATABASE_URL);
    try {
      const user = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE username = 'admin' LIMIT 1",
      );
      const userId = user.rows[0]!.id;
      const session = await createSession(db, userId);
      const active = await resolveSession(db, session.sessionId, session.token);
      expect(active).not.toBeNull();

      await revokeSession(db, session.sessionId);
      const revoked = await resolveSession(db, session.sessionId, session.token);
      expect(revoked).toBeNull();
    } finally {
      await db.close();
    }
  });
});
