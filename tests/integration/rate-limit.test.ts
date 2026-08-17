import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../../apps/web/src/main.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://archive:change-me-local-only@127.0.0.1:5432/archive";

const SESSION_SECRET = "test-session-secret-at-least-32-characters-long";
const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MAX_REQUESTS_PER_MINUTE = 100;

function applyEnv(): void {
  Object.assign(process.env, {
    APP_ROLE: "web",
    APP_BIND: "127.0.0.1",
    APP_PORT: "0",
    DATABASE_URL,
    SESSION_SECRET,
    ENCRYPTION_KEY,
    SECURE_COOKIES: "false",
  });
}

describe("http rate limiting", () => {
  let app: Awaited<ReturnType<typeof buildServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("rejects further requests from the same IP after the per-minute cap", async () => {
    applyEnv();
    ({ app } = await buildServer());
    await app.ready();

    for (let i = 0; i < MAX_REQUESTS_PER_MINUTE; i += 1) {
      const allowed = await app.inject({ method: "GET", url: "/healthz" });
      expect(allowed.statusCode).toBe(200);
    }

    const limited = await app.inject({ method: "GET", url: "/healthz" });
    expect(limited.statusCode).toBe(429);
  });
});
