import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimNextRun: vi.fn(),
  applyRetention: vi.fn(),
  expireExports: vi.fn(),
  processExportJobs: vi.fn(),
  processScheduledBackup: vi.fn(),
  enqueueDueRuns: vi.fn(),
  canAcquireStorage: vi.fn(),
  runEventArchiveJob: vi.fn(),
}));

vi.mock("@archive/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@archive/core")>()),
  claimNextRun: mocks.claimNextRun,
  isMaintenanceMode: () => false,
  reclaimOrphanedQueryRuns: vi.fn(),
}));
vi.mock("../../apps/worker/src/retention.js", () => ({ applyRetention: mocks.applyRetention }));
vi.mock("../../apps/worker/src/exportJob.js", () => ({
  expireExports: mocks.expireExports,
  processExportJobs: mocks.processExportJobs,
}));
vi.mock("../../apps/worker/src/backupJob.js", () => ({ processScheduledBackup: mocks.processScheduledBackup }));
vi.mock("../../apps/worker/src/scheduler.js", () => ({ enqueueDueRuns: mocks.enqueueDueRuns }));
vi.mock("../../apps/worker/src/storageGuard.js", () => ({ canAcquireStorage: mocks.canAcquireStorage }));
vi.mock("../../apps/worker/src/eventArchiveJob.js", () => ({ runEventArchiveJob: mocks.runEventArchiveJob }));

import { runWorkerTick, type WorkerLoopDeps } from "../../apps/worker/src/main.js";

it("logs the query name and version when a run starts", async () => {
  mocks.claimNextRun.mockResolvedValue({
    id: "run-1",
    queryVersionId: "version-1",
    kind: "scheduled",
    status: "running",
    windowStart: "2026-01-01T00:00:00.000Z",
    windowEnd: "2026-01-01T01:00:00.000Z",
  });
  mocks.processExportJobs.mockResolvedValue(false);
  mocks.canAcquireStorage.mockReturnValue({ decision: "allow" });
  mocks.runEventArchiveJob.mockResolvedValue({ ok: true, retryable: false });
  const db = { query: vi.fn().mockResolvedValue({ rows: [{ mode: "event", name: "events", version_number: 3 }] }) };
  const logger: NonNullable<WorkerLoopDeps["logger"]> = {
    debug: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  await runWorkerTick(db as never, { encryptionKey: Buffer.alloc(32), logger }, "worker-1");

  expect(logger.info).toHaveBeenCalledWith("query_run.started", {
    runId: "run-1",
    queryVersionId: "version-1",
    queryName: "events",
    versionNumber: 3,
    kind: "scheduled",
    mode: "event",
  });
});
