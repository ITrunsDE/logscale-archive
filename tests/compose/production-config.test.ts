import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "@archive/config";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const COMPOSE_FILE = resolve(ROOT, "infra/compose.yaml");
const PRODUCTION_FILE = resolve(ROOT, "infra/compose.production.yaml");
const NGINX_FILE = resolve(ROOT, "infra/nginx/nginx.conf.example");
const POSTGRES_OVERRIDE = resolve(ROOT, "infra/compose.postgres.yaml");

const BASE_ENV = {
  APP_ROLE: "web",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
} as const;

function serviceBlock(compose: string, service: string): string {
  return compose.split(new RegExp(`\\n {2}${service}:`))[1]?.split(/\n {2}[a-z]/)[0] ?? "";
}

describe("production compose and config", () => {
  it("binds web to localhost by default", () => {
    const compose = readFileSync(COMPOSE_FILE, "utf8");
    expect(compose).toMatch(/127\.0\.0\.1:8080:8080/);
  });

  it("does not publish postgres in base compose", () => {
    const compose = readFileSync(COMPOSE_FILE, "utf8");
    const postgresBlock = serviceBlock(compose, "postgres");
    expect(postgresBlock.length).toBeGreaterThan(0);
    expect(postgresBlock).not.toMatch(/ports:/);
    expect(postgresBlock).not.toMatch(/5432/);
  });

  it("documents that compose.postgres.yaml is local-dev only", () => {
    const override = readFileSync(POSTGRES_OVERRIDE, "utf8");
    expect(override).toMatch(/127\.0\.0\.1:5432:5432/);
    const production = readFileSync(PRODUCTION_FILE, "utf8");
    expect(production).not.toMatch(/5432:5432/);
  });

  it("requires secrets in production overrides without dev defaults", () => {
    const production = readFileSync(PRODUCTION_FILE, "utf8");
    const webBlock = serviceBlock(production, "web");
    expect(webBlock).toMatch(/DATABASE_URL: \$\{DATABASE_URL:\?DATABASE_URL is required\}/);
    expect(webBlock).toMatch(/SESSION_SECRET: \$\{SESSION_SECRET:\?SESSION_SECRET is required\}/);
    expect(webBlock).toMatch(/RECOVERY_SECRET: \$\{RECOVERY_SECRET:\?RECOVERY_SECRET is required\}/);
    expect(webBlock).toMatch(/ENCRYPTION_KEY: \$\{ENCRYPTION_KEY:\?ENCRYPTION_KEY is required\}/);
    expect(webBlock).not.toMatch(/change-me/);
    expect(webBlock).toMatch(/BACKUP_PATH: \/data\/backups/);
  });

  it("documents external PostgreSQL with TLS in production overrides", () => {
    const production = readFileSync(PRODUCTION_FILE, "utf8");
    expect(production).toMatch(/sslmode=require/);
    expect(production).toMatch(/REQUIRE_DB_TLS/);
  });

  it("rejects external DATABASE_URL without TLS when REQUIRE_DB_TLS is enabled", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        DATABASE_URL: "postgres://user:pass@db.example.com:5432/archive",
        REQUIRE_DB_TLS: "true",
      }),
    ).toThrow(/sslmode=require/);
  });

  it("allows bundled postgres hostname without TLS when REQUIRE_DB_TLS is enabled", () => {
    const config = loadConfig({
      ...BASE_ENV,
      DATABASE_URL: "postgres://archive:secret@postgres:5432/archive",
      REQUIRE_DB_TLS: "true",
    });
    expect(config.databaseUrl).toContain("@postgres:5432");
  });

  it("nginx profile does not expose worker or database", () => {
    const compose = readFileSync(COMPOSE_FILE, "utf8");
    const nginxBlock = serviceBlock(compose, "nginx");
    expect(nginxBlock).toMatch(/profiles: \["nginx"\]/);
    expect(nginxBlock).not.toMatch(/worker:/);
    expect(nginxBlock).not.toMatch(/postgres:/);
    expect(nginxBlock).not.toMatch(/5432/);

    const nginxConf = readFileSync(NGINX_FILE, "utf8");
    expect(nginxConf).toMatch(/archive_web/);
    expect(nginxConf).not.toMatch(/server worker:/);
    expect(nginxConf).not.toMatch(/server postgres:/);
    expect(nginxConf).not.toMatch(/5432/);
  });
});
