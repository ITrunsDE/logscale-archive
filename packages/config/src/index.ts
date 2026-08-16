export type AppRole = "web" | "worker";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type OperationsLogConfig =
  | { transport: "stdout"; level: LogLevel }
  | { transport: "logscale"; level: LogLevel; endpoint: string; ingestToken: string };

export type OperationsLogger = {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  flush(): Promise<void>;
};

type LogFields = Record<string, string | number | boolean | undefined>;

export type RuntimeConfig = {
  role: AppRole;
  bindHost: string;
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  recoverySecret?: string;
  encryptionKey: Buffer;
  encryptionKeyId: string;
  eventTailLimit: number;
  displayTimezone: string;
  secureCookies: boolean;
  operationsLog: OperationsLogConfig;
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

function eventTailLimit(env: NodeJS.ProcessEnv): number {
  const value = Number(env.LOGSCALE_EVENT_TAIL_LIMIT ?? "1000");
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("LOGSCALE_EVENT_TAIL_LIMIT must be a positive integer");
  }
  return value;
}

function displayTimezone(env: NodeJS.ProcessEnv): string {
  const timezone = env.DISPLAY_TIMEZONE ?? "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
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

function loadOperationsLogConfig(env: NodeJS.ProcessEnv): OperationsLogConfig {
  const level = (env.LOG_LEVEL ?? "info") as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(level)) {
    throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  }
  const transport = env.LOG_TRANSPORT ?? "stdout";
  if (transport === "stdout") {
    return { transport, level };
  }
  if (transport !== "logscale") {
    throw new Error("LOG_TRANSPORT must be stdout or logscale");
  }
  const endpoint = required("LOGSCALE_LOG_ENDPOINT", env).replace(/\/+$/, "");
  const ingestToken = required("LOGSCALE_LOG_INGEST_TOKEN", env);
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error();
    }
  } catch {
    throw new Error("LOGSCALE_LOG_ENDPOINT must be an HTTP(S) URL");
  }
  return { transport, level, endpoint, ingestToken };
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
    eventTailLimit: eventTailLimit(env),
    displayTimezone: displayTimezone(env),
    secureCookies,
    operationsLog: loadOperationsLogConfig(env),
  };
}

const LOG_LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const APP_NAME = "logscale-archive";
const MAX_BATCH = 100;
const MAX_BUFFER = 1_000;
const FLUSH_MS = 1_000;
const FAILURE_REPORT_MS = 60_000;

export function createOperationsLogger(
  service: "web" | "worker",
  config: OperationsLogConfig,
  fetchImpl: typeof fetch = fetch,
): OperationsLogger {
  const pending: Record<string, unknown>[] = [];
  let flushing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFailureAt = 0;

  const schedule = () => {
    if (config.transport !== "logscale" || timer || pending.length === 0) {
      return;
    }
    timer = setTimeout(() => void flush(), FLUSH_MS);
    timer.unref?.();
  };

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (config.transport !== "logscale" || flushing || pending.length === 0) {
      return;
    }
    flushing = true;
    const batch = pending.splice(0, MAX_BATCH);
    try {
      const response = await fetchImpl(`${config.endpoint}/api/v1/ingest/json`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.ingestToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
    } catch (error) {
      const now = Date.now();
      if (now - lastFailureAt >= FAILURE_REPORT_MS) {
        lastFailureAt = now;
        console.warn(JSON.stringify({
          timestamp: new Date(now).toISOString(),
          level: "warn",
          app: APP_NAME,
          service,
          event: "operations_log.ingest_failed",
          error: error instanceof Error ? error.message : "request_failed",
        }));
      }
    } finally {
      flushing = false;
      if (pending.length >= MAX_BATCH) {
        void flush();
      } else {
        schedule();
      }
    }
  };

  const log = (level: LogLevel, event: string, fields: LogFields = {}) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[config.level]) {
      return;
    }
    const entry = { timestamp: new Date().toISOString(), level, app: APP_NAME, service, event, ...fields };
    console[level === "debug" ? "debug" : level](JSON.stringify(entry));
    if (config.transport === "logscale") {
      if (pending.length < MAX_BUFFER) {
        pending.push(entry);
      }
      if (pending.length >= MAX_BATCH) {
        void flush();
      } else {
        schedule();
      }
    }
  };

  return {
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
    flush,
  };
}
