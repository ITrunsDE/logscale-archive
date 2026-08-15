import type { Database } from "@archive/core";
import { claimNextExport, expireExports, runExportJob } from "@archive/core";

export async function processExportJobs(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const job = await claimNextExport(db);
  if (!job) {
    return false;
  }
  await runExportJob(db, job, env);
  return true;
}

export { expireExports };
