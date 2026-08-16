import type { ArchiveOutcome, Database, EventArchiveDeps, QueryRun } from "@archive/core";
import { archiveEventWindow } from "@archive/core";
import { DEFAULT_MIN_WINDOW_MS, splitWindow } from "./windowSplitter.js";

export async function runEventArchiveJob(
  db: Database,
  deps: EventArchiveDeps,
  run: QueryRun,
): Promise<ArchiveOutcome> {
  return archiveEventWindow(db, {
    ...deps,
    splitWindow,
    minWindowDurationMs: deps.minWindowDurationMs ?? DEFAULT_MIN_WINDOW_MS,
  }, run.id, {
    start: run.windowStart,
    end: run.windowEnd,
  });
}
