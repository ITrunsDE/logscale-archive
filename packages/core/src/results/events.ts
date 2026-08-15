import { writeAuditEntry } from "../audit/writeAuditEntry.js";
import type { Database } from "../db/repositories.js";
import type { QueryRunKind } from "../jobs/leases.js";
import { LogScaleClient } from "../logscale/client.js";
import type { FetchFn, LogScaleClientConfig } from "../logscale/types.js";
import { formatFailureMetadata, hasResultCapWarning } from "../logscale/warnings.js";
import { validateEventResults } from "../queries/validateQuery.js";
import { decryptSecret, encryptedSecretFromBytes } from "../security/encryption.js";

export type ArchiveWindow = {
  start: string;
  end: string;
};

export type ArchiveOutcome = {
  ok: boolean;
  eventCount: number;
  retryable: boolean;
  error?: string;
  split?: boolean;
};

export type EventArchiveHooks = {
  afterPagePersisted?: (ctx: { pageIndex: number; runId: string; inserted: number }) => void | Promise<void>;
  beforePageInsert?: (ctx: { pageIndex: number; runId: string }) => void | Promise<void>;
};

export type EventArchiveDeps = {
  encryptionKey: Buffer;
  fetch?: FetchFn;
  pageSize?: number;
  pollAttempts?: number;
  pollIntervalMs?: number;
  minWindowDurationMs?: number;
  splitWindow?: (window: ArchiveWindow) => [ArchiveWindow, ArchiveWindow];
  hooks?: EventArchiveHooks;
  createClient?: (config: LogScaleClientConfig) => LogScaleClient;
};

type RunContextRow = {
  run_id: string;
  query_version_id: string;
  kind: QueryRunKind;
  query_text: string;
  endpoint: string;
  repository: string;
  token_ciphertext: Buffer;
};

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_POLL_ATTEMPTS = 30;
const DEFAULT_POLL_INTERVAL_MS = 20;
const DEFAULT_MIN_WINDOW_MS = 60_000;

function isRetryableArchiveError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError") {
    return true;
  }
  return /timed out|status 429|status 502|status 503|status 504|network|fetch failed/i.test(
    error.message,
  );
}

function eventTimestamp(event: Record<string, unknown>): string {
  const raw = event["@timestamp"] ?? event._time ?? event.timestamp;
  if (raw != null) {
    const parsed = Date.parse(String(raw));
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

function createLogScaleClient(
  deps: EventArchiveDeps,
  connection: Pick<RunContextRow, "endpoint" | "repository">,
  token: string,
): LogScaleClient {
  const config: LogScaleClientConfig = {
    endpoint: connection.endpoint,
    repository: connection.repository,
    token,
    fetch: deps.fetch,
  };
  return deps.createClient ? deps.createClient(config) : new LogScaleClient(config);
}

async function loadRunContext(db: Database, runId: string): Promise<RunContextRow | null> {
  const result = await db.query<RunContextRow>(
    `SELECT qr.id AS run_id, qr.query_version_id, qr.kind,
            qv.query_text, lc.endpoint, lc.repository, lc.token_ciphertext
     FROM query_runs qr
     JOIN query_versions qv ON qv.id = qr.query_version_id
     JOIN logscale_connections lc ON lc.id = qv.connection_id
     WHERE qr.id = $1`,
    [runId],
  );
  return result.rows[0] ?? null;
}

async function persistPage(
  db: Database,
  ctx: RunContextRow,
  runId: string,
  pageIndex: number,
  events: unknown[],
  hooks?: EventArchiveHooks,
): Promise<number> {
  const validation = validateEventResults(events);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.errors.join("; ")), { retryable: false });
  }

  const inserted = await db.withTransaction(async (client) => {
    await hooks?.beforePageInsert?.({ pageIndex, runId });

    let count = 0;
    for (const event of events) {
      const record = event as Record<string, unknown>;
      const sourceEventId = String(record["@id"]);
      const sourceRepo = String(record["#repo"]);
      const result = await client.query(
        `INSERT INTO event_records
           (query_version_id, query_run_id, source_repo, source_event_id, event_timestamp, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT ON CONSTRAINT event_identity DO NOTHING`,
        [
          ctx.query_version_id,
          runId,
          sourceRepo,
          sourceEventId,
          eventTimestamp(record),
          JSON.stringify(record),
        ],
      );
      count += result.rowCount ?? 0;
    }

    await client.query(
      `UPDATE query_runs
       SET result_count = (
         SELECT COUNT(*) FROM event_records WHERE query_run_id = $1
       )
       WHERE id = $1`,
      [runId],
    );

    return count;
  });

  try {
    await hooks?.afterPagePersisted?.({ pageIndex, runId, inserted });
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      retryable: true,
    });
  }

  return inserted;
}

async function markRunComplete(
  db: Database,
  runId: string,
  queryVersionId: string,
  kind: QueryRunKind,
  window: ArchiveWindow,
  eventCount: number,
): Promise<void> {
  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE query_runs
       SET status = 'complete', failure_reason = NULL, result_count = $2, finished_at = now()
       WHERE id = $1`,
      [runId, eventCount],
    );

    const parent = await client.query<{ parent_run_id: string | null }>(
      `SELECT parent_run_id FROM query_runs WHERE id = $1`,
      [runId],
    );
    const parentRunId = parent.rows[0]?.parent_run_id;
    if (parentRunId) {
      await maybeAdvanceSplitWatermark(client, runId);
    } else if (kind === "scheduled") {
      await client.query(
        `UPDATE query_schedules
         SET watermark_at = $2, updated_at = now()
         WHERE query_version_id = $1`,
        [queryVersionId, window.end],
      );
    } else if (kind === "backfill") {
      await client.query(
        `UPDATE backfill_windows
         SET status = 'complete', updated_at = now()
         WHERE query_version_id = $1
           AND window_start = $2::timestamptz
           AND window_end = $3::timestamptz`,
        [queryVersionId, window.start, window.end],
      );
    }
  });

  await writeAuditEntry(db, {
    action: "event_archive.complete",
    metadata: {
      runId,
      queryVersionId,
      kind,
      eventCount,
      windowStart: window.start,
      windowEnd: window.end,
    },
  });
}

async function maybeAdvanceSplitWatermark(
  client: Pick<Database, "query">,
  runId: string,
): Promise<void> {
  const rootResult = await client.query<{
    id: string;
    window_start: Date;
    window_end: Date;
    query_version_id: string;
    kind: QueryRunKind;
  }>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_run_id, window_start, window_end, query_version_id, kind
       FROM query_runs WHERE id = $1
       UNION ALL
       SELECT qr.id, qr.parent_run_id, qr.window_start, qr.window_end, qr.query_version_id, qr.kind
       FROM query_runs qr
       JOIN ancestors a ON a.parent_run_id = qr.id
     )
     SELECT id, window_start, window_end, query_version_id, kind
     FROM ancestors
     WHERE parent_run_id IS NULL`,
    [runId],
  );
  const root = rootResult.rows[0];
  if (!root) {
    return;
  }

  const pending = await client.query<{ count: string }>(
    `WITH RECURSIVE tree AS (
       SELECT id, status FROM query_runs WHERE id = $1
       UNION ALL
       SELECT qr.id, qr.status FROM query_runs qr JOIN tree t ON qr.parent_run_id = t.id
     )
     SELECT COUNT(*)::text AS count FROM tree WHERE status IN ('pending', 'running', 'failed')`,
    [root.id],
  );
  if (Number(pending.rows[0]?.count ?? 0) > 0) {
    return;
  }

  if (root.kind === "scheduled") {
    await client.query(
      `UPDATE query_schedules
       SET watermark_at = $2, updated_at = now()
       WHERE query_version_id = $1`,
      [root.query_version_id, root.window_end.toISOString()],
    );
  } else if (root.kind === "backfill") {
    await client.query(
      `UPDATE backfill_windows
       SET status = 'complete', updated_at = now()
       WHERE query_version_id = $1
         AND window_start = $2
         AND window_end = $3`,
      [root.query_version_id, root.window_start, root.window_end],
    );
  }

  await client.query(
    `UPDATE query_runs
     SET status = 'complete', finished_at = now()
     WHERE id = $1 AND status = 'split'`,
    [root.id],
  );
}

async function markRunSplit(
  db: Database,
  runId: string,
  queryVersionId: string,
  kind: QueryRunKind,
  window: ArchiveWindow,
  warnings: string[],
): Promise<void> {
  const message = formatFailureMetadata(warnings);
  await db.query(
    `UPDATE query_runs
     SET status = 'split', failure_reason = $2, finished_at = now()
     WHERE id = $1`,
    [runId, message],
  );

  await writeAuditEntry(db, {
    action: "event_archive.split",
    metadata: {
      runId,
      queryVersionId,
      kind,
      windowStart: window.start,
      windowEnd: window.end,
      warnings: warnings.slice(0, 5),
    },
  });
}

async function createSplitChildRuns(
  db: Database,
  parentRunId: string,
  queryVersionId: string,
  kind: QueryRunKind,
  children: [ArchiveWindow, ArchiveWindow],
): Promise<void> {
  for (const child of children) {
    await db.query(
      `INSERT INTO query_runs (query_version_id, kind, status, window_start, window_end, parent_run_id)
       VALUES ($1, $2, 'pending', $3, $4, $5)`,
      [queryVersionId, kind, child.start, child.end, parentRunId],
    );
  }
}

function windowDurationMs(window: ArchiveWindow): number {
  return Date.parse(window.end) - Date.parse(window.start);
}

async function handleResultCap(
  db: Database,
  deps: EventArchiveDeps,
  ctx: RunContextRow,
  runId: string,
  window: ArchiveWindow,
  warnings: string[],
): Promise<ArchiveOutcome> {
  const minDuration = deps.minWindowDurationMs ?? DEFAULT_MIN_WINDOW_MS;
  if (windowDurationMs(window) <= minDuration) {
    const message = formatFailureMetadata(warnings);
    await markRunFailed(db, runId, ctx.query_version_id, ctx.kind, window, message, false);
    return { ok: false, eventCount: 0, retryable: false, error: message };
  }

  const split = deps.splitWindow;
  if (!split) {
    const message = formatFailureMetadata(warnings);
    await markRunFailed(db, runId, ctx.query_version_id, ctx.kind, window, message, false);
    return { ok: false, eventCount: 0, retryable: false, error: message };
  }

  const children = split(window);
  await markRunSplit(db, runId, ctx.query_version_id, ctx.kind, window, warnings);
  await createSplitChildRuns(db, runId, ctx.query_version_id, ctx.kind, children);
  return { ok: false, eventCount: 0, retryable: false, split: true, error: formatFailureMetadata(warnings) };
}

async function markRunFailed(
  db: Database,
  runId: string,
  queryVersionId: string,
  kind: QueryRunKind,
  window: ArchiveWindow,
  message: string,
  retryable: boolean,
): Promise<void> {
  const status = retryable ? "pending" : "failed";
  await db.query(
    `UPDATE query_runs
     SET status = $2, failure_reason = $3, finished_at = CASE WHEN $4 THEN NULL ELSE now() END
     WHERE id = $1`,
    [runId, status, message.slice(0, 500), retryable],
  );

  await writeAuditEntry(db, {
    action: retryable ? "event_archive.retry" : "event_archive.failed",
    metadata: {
      runId,
      queryVersionId,
      kind,
      retryable,
      windowStart: window.start,
      windowEnd: window.end,
      error: message.slice(0, 200),
    },
  });
}

export async function archiveEventWindow(
  db: Database,
  deps: EventArchiveDeps,
  runId: string,
  window: ArchiveWindow,
): Promise<ArchiveOutcome> {
  const ctx = await loadRunContext(db, runId);
  if (!ctx) {
    return { ok: false, eventCount: 0, retryable: false, error: "run_not_found" };
  }

  const token = decryptSecret(
    encryptedSecretFromBytes(ctx.token_ciphertext),
    deps.encryptionKey,
  );
  const client = createLogScaleClient(deps, ctx, token);
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const pollAttempts = deps.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let jobId: string | undefined;
  let totalEvents = 0;

  try {
    const job = await client.createQueryJob({
      query: ctx.query_text,
      start: window.start,
      end: window.end,
    });
    jobId = job.id;

    let status = job.status;
    let warnings: string[] = [];
    for (let attempt = 0; attempt < pollAttempts && status === "running"; attempt += 1) {
      await sleep(pollIntervalMs);
      const poll = await client.pollQueryJob(job.id);
      status = poll.status;
      if (poll.warnings?.length) {
        warnings = poll.warnings;
      }
    }
    if (status !== "done") {
      const message = "Query job did not complete successfully";
      await markRunFailed(db, runId, ctx.query_version_id, ctx.kind, window, message, true);
      return { ok: false, eventCount: totalEvents, retryable: true, error: message };
    }

    if (hasResultCapWarning(warnings)) {
      return handleResultCap(db, deps, ctx, runId, window, warnings);
    }

    let offset = 0;
    let pageIndex = 0;
    let done = false;

    while (!done) {
      const page = await client.getResultPage(jobId, offset, pageSize);
      if (page.events.length > 0) {
        await persistPage(db, ctx, runId, pageIndex, page.events, deps.hooks);
        totalEvents += page.events.length;
      }
      done = page.done || page.events.length === 0;
      offset += page.events.length;
      pageIndex += 1;
    }

    const stored = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM event_records WHERE query_run_id = $1`,
      [runId],
    );
    const eventCount = Number(stored.rows[0]?.count ?? totalEvents);

    await markRunComplete(db, runId, ctx.query_version_id, ctx.kind, window, eventCount);
    return { ok: true, eventCount, retryable: false };
  } catch (error) {
    const retryable =
      (error as { retryable?: boolean }).retryable === true ||
      isRetryableArchiveError(error);
    const message = error instanceof Error ? error.message : "Event archive failed";
    await markRunFailed(db, runId, ctx.query_version_id, ctx.kind, window, message, retryable);
    return { ok: false, eventCount: totalEvents, retryable, error: message };
  } finally {
    if (jobId) {
      await client.deleteQueryJob(jobId).catch(() => {});
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
