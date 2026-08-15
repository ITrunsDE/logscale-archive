import type { AggregateArchiveDeps, Database, EventArchiveDeps, QueryRun } from "@archive/core";
import { archiveAggregateWindow } from "@archive/core";

export async function runAggregateArchiveJob(
  db: Database,
  deps: AggregateArchiveDeps,
  run: QueryRun,
): Promise<void> {
  await archiveAggregateWindow(db, deps, run.id, {
    start: run.windowStart,
    end: run.windowEnd,
  });
}
