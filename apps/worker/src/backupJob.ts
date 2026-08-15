import type { Database } from "@archive/core";
import { createBackup, getLatestCompleteBackup, type BackupDeps } from "@archive/core";

export async function processScheduledBackup(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  deps: BackupDeps = {},
): Promise<boolean> {
  const intervalMs = Number(env.BACKUP_INTERVAL_MS ?? String(24 * 60 * 60 * 1000));
  const latest = await getLatestCompleteBackup(db);
  if (latest?.finishedAt) {
    const age = Date.now() - new Date(latest.finishedAt).getTime();
    if (age < intervalMs) {
      return false;
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
