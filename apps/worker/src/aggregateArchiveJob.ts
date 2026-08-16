import type { AggregateArchiveDeps, AggregateArchiveOutcome, Database, QueryRun } from "@archive/core";
import { archiveAggregateWindow } from "@archive/core";

export async function runAggregateArchiveJob(
  db: Database,
  deps: AggregateArchiveDeps,
  run: QueryRun,
): Promise<AggregateArchiveOutcome> {
  return archiveAggregateWindow(db, deps, run.id, {
    start: run.windowStart,
    end: run.windowEnd,
  });
}
