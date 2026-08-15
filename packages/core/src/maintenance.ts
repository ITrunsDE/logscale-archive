import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import type { Database } from "./db/repositories.js";
import { reconnectDatabase } from "./db/repositories.js";
import { revokeAllSessions } from "./auth/sessions.js";
import { writeAuditEntry } from "./audit/writeAuditEntry.js";

export type BackupRunStatus = "pending" | "running" | "complete" | "failed";

export type BackupRun = {
  id: string;
  status: BackupRunStatus;
  filePath: string | null;
  checksum: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type RestoreOutcome = {
  restoredBackupId: string;
  safetyBackupId: string;
  sessionsRevoked: number;
  integrityOk: boolean;
};

export type MaintenanceState = {
  active: boolean;
  reason?: string;
  enteredAt?: string;
};

export type BackupDeps = {
  spawn?: typeof nodeSpawn;
  env?: NodeJS.ProcessEnv;
  dumpDatabase?: (databaseUrl: string, filePath: string) => Promise<void>;
  restoreDatabase?: (databaseUrl: string, filePath: string) => Promise<void>;
};

type BackupRow = {
  id: string;
  status: BackupRunStatus;
  file_path: string | null;
  checksum: string | null;
  error_message: string | null;
  created_at: Date;
  finished_at: Date | null;
};

function envValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function maintenancePath(env: NodeJS.ProcessEnv): string {
  return join(envValue(env, "DATA_PATH"), ".maintenance.json");
}

function mapBackupRow(row: BackupRow): BackupRun {
  return {
    id: row.id,
    status: row.status,
    filePath: row.file_path,
    checksum: row.checksum,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export function getMaintenanceState(env: NodeJS.ProcessEnv = process.env): MaintenanceState {
  const path = maintenancePath(env);
  if (!existsSync(path)) {
    return { active: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { reason?: string; enteredAt?: string };
    return { active: true, reason: parsed.reason, enteredAt: parsed.enteredAt };
  } catch {
    return { active: true };
  }
}

export function isMaintenanceMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return getMaintenanceState(env).active;
}

export async function enterMaintenanceMode(
  reason: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = maintenancePath(env);
  await mkdir(envValue(env, "DATA_PATH"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ reason, enteredAt: new Date().toISOString() }),
    "utf8",
  );
}

export function exitMaintenanceMode(env: NodeJS.ProcessEnv = process.env): void {
  const path = maintenancePath(env);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

async function runCommand(
  command: string,
  args: string[],
  deps: BackupDeps,
): Promise<void> {
  const spawnFn = deps.spawn ?? nodeSpawn;
  await new Promise<void>((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

export async function listBackupRuns(db: Database, limit = 20): Promise<BackupRun[]> {
  const result = await db.query<BackupRow>(
    `SELECT id, status, file_path, checksum, error_message, created_at, finished_at
     FROM backup_runs
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map(mapBackupRow);
}

export async function getBackupRun(db: Database, id: string): Promise<BackupRun | null> {
  const result = await db.query<BackupRow>(
    `SELECT id, status, file_path, checksum, error_message, created_at, finished_at
     FROM backup_runs WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapBackupRow(result.rows[0]) : null;
}

export async function createBackup(db: Database, deps: BackupDeps = {}): Promise<BackupRun> {
  const env = deps.env ?? process.env;
  const backupRoot = envValue(env, "BACKUP_PATH");
  const databaseUrl = envValue(env, "DATABASE_URL");
  await mkdir(backupRoot, { recursive: true });

  const inserted = await db.query<BackupRow>(
    `INSERT INTO backup_runs (status) VALUES ('pending')
     RETURNING id, status, file_path, checksum, error_message, created_at, finished_at`,
  );
  const run = inserted.rows[0]!;
  const filePath = join(backupRoot, `${run.id}.sql`);

  await db.query(`UPDATE backup_runs SET status = 'running', file_path = $2 WHERE id = $1`, [
    run.id,
    filePath,
  ]);

  try {
    if (deps.dumpDatabase) {
      await deps.dumpDatabase(databaseUrl, filePath);
    } else {
      await runCommand("pg_dump", ["--no-owner", "--no-acl", "--file", filePath, databaseUrl], deps);
    }
    const checksum = await sha256File(filePath);
    await db.query(
      `UPDATE backup_runs
       SET status = 'complete', checksum = $2, finished_at = now(), error_message = NULL
       WHERE id = $1`,
      [run.id, checksum],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "backup failed";
    await db.query(
      `UPDATE backup_runs SET status = 'failed', finished_at = now(), error_message = $2 WHERE id = $1`,
      [run.id, message],
    );
    throw error;
  }

  return (await getBackupRun(db, run.id))!;
}

export async function getLatestCompleteBackup(db: Database): Promise<BackupRun | null> {
  const result = await db.query<BackupRow>(
    `SELECT id, status, file_path, checksum, error_message, created_at, finished_at
     FROM backup_runs
     WHERE status = 'complete'
     ORDER BY finished_at DESC NULLS LAST
     LIMIT 1`,
  );
  return result.rows[0] ? mapBackupRow(result.rows[0]) : null;
}

export async function assertRecentBackupBeforeMigration(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const tableExists = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`,
    );
    if (!tableExists.rows[0]?.exists) {
      return;
    }

    const { rows: applied } = await client.query<{ id: string }>(
      "SELECT id FROM schema_migrations ORDER BY id",
    );
    if (applied.length === 0) {
      return;
    }

    const migrationsDir = new URL("../migrations", import.meta.url);
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
    const appliedSet = new Set(applied.map((row) => row.id));
    const pending = files.some((file) => !appliedSet.has(file.replace(/\.sql$/, "")));
    if (!pending) {
      return;
    }

    const maxAgeMs = Number(env.BACKUP_MAX_AGE_MS ?? String(7 * 24 * 60 * 60 * 1000));
    const { rows } = await client.query<{ finished_at: Date | null }>(
      `SELECT finished_at FROM backup_runs
       WHERE status = 'complete'
       ORDER BY finished_at DESC NULLS LAST
       LIMIT 1`,
    );
    const finishedAt = rows[0]?.finished_at;
    if (!finishedAt || Date.now() - finishedAt.getTime() > maxAgeMs) {
      throw new Error("Recent successful backup required before schema migration");
    }
  } finally {
    await client.end();
  }
}

async function terminateOtherSessions(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()`,
    );
  } finally {
    await client.end();
  }
}

async function verifyIntegrity(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SELECT 1");
    const tables = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('users', 'schema_migrations', 'backup_runs')`,
    );
    return tables.rows[0]?.count === "3";
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

export type RestoreInput = {
  backupId: string;
  confirmation: string;
  actorUserId?: string | null;
  ip?: string | null;
};

export async function restoreBackup(
  db: Database,
  input: RestoreInput,
  deps: BackupDeps = {},
): Promise<RestoreOutcome> {
  const env = deps.env ?? process.env;
  const instanceName = env.INSTANCE_NAME;
  if (!instanceName) {
    throw new Error("INSTANCE_NAME is not configured");
  }
  if (input.confirmation !== instanceName) {
    throw new Error("Restore confirmation mismatch");
  }

  const backup = await getBackupRun(db, input.backupId);
  if (!backup || backup.status !== "complete" || !backup.filePath) {
    throw new Error("Backup not found");
  }
  if (!existsSync(backup.filePath)) {
    throw new Error("Backup file missing");
  }

  const databaseUrl = envValue(env, "DATABASE_URL");
  const safetyBackup = await createBackup(db, deps);
  await enterMaintenanceMode(`restore:${input.backupId}`, env);

  try {
    await db.close();
    await terminateOtherSessions(databaseUrl);
    if (deps.restoreDatabase) {
      await deps.restoreDatabase(databaseUrl, backup.filePath);
    } else {
      await runCommand(
        "psql",
        [databaseUrl, "--file", backup.filePath, "--set", "ON_ERROR_STOP=on"],
        deps,
      );
    }
    const integrityOk = await verifyIntegrity(databaseUrl);
    if (!integrityOk) {
      throw new Error("Post-restore integrity check failed");
    }

    await reconnectDatabase(db, databaseUrl);
    const sessionsRevoked = await revokeAllSessions(db);
    await writeAuditEntry(db, {
      actorUserId: input.actorUserId ?? null,
      action: "restore.complete",
      ip: input.ip ?? null,
      metadata: {
        restoredBackupId: input.backupId,
        safetyBackupId: safetyBackup.id,
        sessionsRevoked,
        integrityOk,
      },
    });

    return {
      restoredBackupId: input.backupId,
      safetyBackupId: safetyBackup.id,
      sessionsRevoked,
      integrityOk,
    };
  } finally {
    exitMaintenanceMode(env);
  }
}

export type JobStats = {
  queryRuns: Record<string, number>;
  exports: Record<string, number>;
  backups: Record<string, number>;
};

export async function getJobStats(db: Database): Promise<JobStats> {
  const [queryRuns, exports, backups] = await Promise.all([
    db.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM query_runs GROUP BY status`,
    ),
    db.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM exports GROUP BY status`,
    ),
    db.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM backup_runs GROUP BY status`,
    ),
  ]);

  const toMap = (rows: Array<{ status: string; count: string }>) =>
    Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));

  return {
    queryRuns: toMap(queryRuns.rows),
    exports: toMap(exports.rows),
    backups: toMap(backups.rows),
  };
}

export async function listAppliedMigrations(db: Database): Promise<string[]> {
  const result = await db.query<{ id: string }>(`SELECT id FROM schema_migrations ORDER BY id`);
  return result.rows.map((row) => row.id);
}

export async function checkDatabaseHealth(db: Database): Promise<boolean> {
  try {
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export function checkWorkerHealth(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  lastSeen: string | null;
} {
  const path = env.WORKER_HEALTH_FILE ?? "/tmp/archive-worker-health";
  if (!existsSync(path)) {
    return { ok: false, lastSeen: null };
  }
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    const lastSeen = readFileSync(path, "utf8").trim();
    return { ok: age <= 15_000, lastSeen };
  } catch {
    return { ok: false, lastSeen: null };
  }
}
