import type { Database } from "@archive/core";
import { createBackup, getLatestCompleteBackup, type BackupDeps } from "@archive/core";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FAIL_RETRY_MS = 60 * 60 * 1000;
const DEFAULT_STALE_RUNNING_MS = 30 * 60 * 1000;

export async function clearStaleBackupRuns(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const staleMs = Number(env.BACKUP_STALE_RUNNING_MS ?? String(DEFAULT_STALE_RUNNING_MS));
  const result = await db.query(
    `UPDATE backup_runs
     SET status = 'failed',
         finished_at = now(),
         error_message = coalesce(error_message, 'stale running backup cleared')
     WHERE status IN ('pending', 'running')
       AND created_at < now() - ($1::double precision * interval '1 millisecond')`,
    [staleMs],
  );
  return result.rowCount ?? 0;
}

export async function processScheduledBackup(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  deps: BackupDeps = {},
): Promise<boolean> {
  await clearStaleBackupRuns(db, env);

  const intervalMs = Number(env.BACKUP_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS));
  const failRetryMs = Number(env.BACKUP_FAIL_RETRY_MS ?? String(DEFAULT_FAIL_RETRY_MS));
  const latest = await getLatestCompleteBackup(db);
  if (latest?.finishedAt) {
    const age = Date.now() - new Date(latest.finishedAt).getTime();
    if (age < intervalMs) {
      return false;
    }
  } else {
    const lastFailed = await db.query<{ finished_at: string }>(
      `SELECT finished_at
       FROM backup_runs
       WHERE status = 'failed' AND finished_at IS NOT NULL
       ORDER BY finished_at DESC
       LIMIT 1`,
    );
    const finishedAt = lastFailed.rows[0]?.finished_at;
    if (finishedAt) {
      const age = Date.now() - new Date(finishedAt).getTime();
      if (age < failRetryMs) {
        return false;
      }
    }
  }

  const running = await db.query<{ id: string }>(
    `SELECT id FROM backup_runs WHERE status IN ('pending', 'running') LIMIT 1`,
  );
  if (running.rows[0]) {
    return false;
  }

  await createBackup(db, { env, ...deps });
  return true;
}
