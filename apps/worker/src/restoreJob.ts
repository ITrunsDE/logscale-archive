import type { Database } from "@archive/core";
import { restoreBackup, type RestoreInput, type RestoreOutcome } from "@archive/core";

export async function runRestoreJob(
  db: Database,
  input: RestoreInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestoreOutcome> {
  return restoreBackup(db, input, { env });
}
