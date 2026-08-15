import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { loadConfig } from "@archive/config";
import { claimNextRun, createDatabase, isMaintenanceMode } from "@archive/core";
import { runAggregateArchiveJob } from "./aggregateArchiveJob.js";
import { expireExports, processExportJobs } from "./exportJob.js";
import { processScheduledBackup } from "./backupJob.js";
import { applyRetention } from "./retention.js";
import { runEventArchiveJob } from "./eventArchiveJob.js";
import { enqueueDueRuns } from "./scheduler.js";
import { canAcquireStorage } from "./storageGuard.js";

const HEALTH_FILE = process.env.WORKER_HEALTH_FILE ?? "/tmp/archive-worker-health";
const TICK_MS = Number(process.env.WORKER_TICK_MS ?? "2000");

export function touchHealth(path = HEALTH_FILE): void {
  writeFileSync(path, new Date().toISOString(), "utf8");
}

export type WorkerLoopDeps = {
  encryptionKey: Buffer;
  fetch?: typeof fetch;
  storageGuard?: import("./storageGuard.js").StorageGuardDeps;
  backup?: import("@archive/core").BackupDeps;
};

export async function runWorkerTick(
  db: ReturnType<typeof createDatabase>,
  deps: WorkerLoopDeps,
  workerId: string,
): Promise<boolean> {
  touchHealth();
  await applyRetention(db);
  await expireExports(db);
  if (await processExportJobs(db)) {
    return true;
  }
  if (!isMaintenanceMode()) {
    await processScheduledBackup(db, process.env, deps.backup);
  }
  await enqueueDueRuns(db);

  if (isMaintenanceMode()) {
    return false;
  }

  const storage = canAcquireStorage(deps.storageGuard);
  if (storage.decision === "block") {
    return false;
  }

  const run = await claimNextRun(db, workerId);
  if (!run) {
    return false;
  }
  const mode = await db.query<{ mode: string }>(
    `SELECT mode FROM query_versions WHERE id = $1`,
    [run.queryVersionId],
  );
  const archiveDeps = { encryptionKey: deps.encryptionKey, fetch: deps.fetch };
  if (mode.rows[0]?.mode === "aggregate") {
    await runAggregateArchiveJob(db, archiveDeps, run);
  } else {
    await runEventArchiveJob(db, archiveDeps, run);
  }
  return true;
}

async function main() {
  const config = loadConfig();
  if (config.role !== "worker") {
    throw new Error(`worker entrypoint requires APP_ROLE=worker, got ${config.role}`);
  }

  const db = createDatabase(config.databaseUrl);
  const workerId = process.env.WORKER_ID ?? randomUUID();
  const deps: WorkerLoopDeps = { encryptionKey: config.encryptionKey };

  touchHealth();
  const tick = async () => {
    try {
      await runWorkerTick(db, deps, workerId);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "worker tick failed");
    }
  };

  await tick();
  setInterval(tick, TICK_MS);
}

const isMain = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js");
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
