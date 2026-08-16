import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createOperationsLogger, loadConfig, type OperationsLogger } from "@archive/config";
import {
  claimNextRun,
  createDatabase,
  isMaintenanceMode,
  reclaimOrphanedQueryRuns,
} from "@archive/core";
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
  logger?: OperationsLogger;
  /** Runs with started_at before this are treated as orphans from a previous worker. */
  bootAt?: Date;
  eventTailLimit?: number;
};

export function logArchiveOutcome(
  logger: Pick<OperationsLogger, "info" | "warn">,
  runId: string,
  mode: "event" | "aggregate",
  outcome: { ok: boolean; retryable: boolean; split?: boolean },
): void {
  const split = outcome.split === true;
  logger[!outcome.ok && !split ? "warn" : "info"]("query_run.finished", {
    runId,
    mode,
    ok: outcome.ok || split,
    retryable: outcome.retryable,
    split,
  });
}

export async function runWorkerTick(
  db: ReturnType<typeof createDatabase>,
  deps: WorkerLoopDeps,
  workerId: string,
): Promise<boolean> {
  touchHealth();
  if (deps.bootAt) {
    await reclaimOrphanedQueryRuns(db, deps.bootAt);
  }
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
  const mode = await db.query<{ mode: string; name: string; version_number: number }>(
    `SELECT mode, name, version_number FROM query_versions WHERE id = $1`,
    [run.queryVersionId],
  );
  const archiveMode = mode.rows[0]?.mode === "aggregate" ? "aggregate" : "event";
  deps.logger?.info("query_run.started", {
    runId: run.id,
    queryVersionId: run.queryVersionId,
    queryName: mode.rows[0]?.name,
    versionNumber: mode.rows[0]?.version_number,
    kind: run.kind,
    mode: archiveMode,
  });
  const archiveDeps = {
    encryptionKey: deps.encryptionKey,
    eventTailLimit: deps.eventTailLimit,
    fetch: deps.fetch,
    hooks: deps.logger
      ? {
          afterPagePersisted: ({ pageIndex, inserted }: { pageIndex: number; inserted: number }) => {
            deps.logger?.debug("query_run.page_persisted", { runId: run.id, pageIndex, inserted });
          },
        }
      : undefined,
  };
  const outcome = archiveMode === "aggregate"
    ? await runAggregateArchiveJob(db, archiveDeps, run)
    : await runEventArchiveJob(db, archiveDeps, run);
  if (deps.logger) {
    logArchiveOutcome(deps.logger, run.id, archiveMode, outcome);
  }
  return true;
}

async function main() {
  const config = loadConfig();
  if (config.role !== "worker") {
    throw new Error(`worker entrypoint requires APP_ROLE=worker, got ${config.role}`);
  }

  const db = createDatabase(config.databaseUrl);
  const logger = createOperationsLogger("worker", config.operationsLog);
  const workerId = process.env.WORKER_ID ?? randomUUID();
  const bootAt = new Date();
  const deps: WorkerLoopDeps = {
    encryptionKey: config.encryptionKey,
    eventTailLimit: config.eventTailLimit,
    bootAt,
    logger,
  };

  const reclaimed = await reclaimOrphanedQueryRuns(db, bootAt);
  if (reclaimed > 0) {
    logger.info("worker.orphaned_runs_reclaimed", { count: reclaimed });
  }
  logger.info("worker.started");

  touchHealth();
  const tick = async () => {
    try {
      await runWorkerTick(db, deps, workerId);
    } catch (error) {
      logger.error("worker.tick_failed", { error: error instanceof Error ? error.name : "unknown" });
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
