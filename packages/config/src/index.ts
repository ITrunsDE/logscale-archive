export type AppRole = "web" | "worker";

export type RuntimeConfig = {
  role: AppRole;
  bindHost: string;
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  recoverySecret?: string;
  encryptionKey: Buffer;
  encryptionKeyId: string;
  secureCookies: boolean;
};

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function isLocalBindHost(bindHost: string): boolean {
  return bindHost === "127.0.0.1" || bindHost === "localhost" || bindHost === "::1";
}

function parseEncryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const hex = required("ENCRYPTION_KEY", env);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

function assertDatabaseTls(databaseUrl: string, env: NodeJS.ProcessEnv): void {
  if (env.REQUIRE_DB_TLS !== "true") {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl.replace(/^postgres:\/\//, "postgresql://"));
  } catch {
    throw new Error("DATABASE_URL must be a valid URL when REQUIRE_DB_TLS is enabled");
  }
  const host = parsed.hostname;
  if (host === "postgres" || host === "localhost" || host === "127.0.0.1") {
    return;
  }
  const sslmode = parsed.searchParams.get("sslmode");
  if (!sslmode || !["require", "verify-ca", "verify-full"].includes(sslmode)) {
    throw new Error(
      "External DATABASE_URL must include sslmode=require (or verify-ca/verify-full) when REQUIRE_DB_TLS is enabled",
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const role = (env.APP_ROLE ?? "web") as AppRole;
  if (role !== "web" && role !== "worker") {
    throw new Error(`Invalid APP_ROLE: ${role}`);
  }

  const bindHost = env.APP_BIND ?? "127.0.0.1";
  const secureCookies =
    env.SECURE_COOKIES === "true" ||
    (env.SECURE_COOKIES !== "false" && !isLocalBindHost(bindHost));

  const sessionSecret =
    role === "web"
      ? required("SESSION_SECRET", env)
      : (env.SESSION_SECRET ?? "worker-session-secret-unused");

  const databaseUrl = required("DATABASE_URL", env);
  assertDatabaseTls(databaseUrl, env);

  return {
    role,
    bindHost,
    port: Number(env.APP_PORT ?? "8080"),
    databaseUrl,
    sessionSecret,
    recoverySecret: env.RECOVERY_SECRET,
    encryptionKey: parseEncryptionKey(env),
    encryptionKeyId: env.ENCRYPTION_KEY_ID ?? "env-v1",
    secureCookies,
  };
}
