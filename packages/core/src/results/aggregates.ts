import { createHash } from "node:crypto";
import { writeAuditEntry } from "../audit/writeAuditEntry.js";
import type { Database } from "../db/repositories.js";
import type { QueryRunKind } from "../jobs/leases.js";
import { LogScaleClient } from "../logscale/client.js";
import type { FetchFn, LogScaleClientConfig } from "../logscale/types.js";
import { formatFailureMetadata, hasResultCapWarning } from "../logscale/warnings.js";
import { validateAggregateResults } from "../queries/validateQuery.js";
import { decryptSecret, encryptedSecretFromBytes } from "../security/encryption.js";

export type AggregateWindow = {
  start: string;
  end: string;
};

export type AggregateSnapshotInput = {
  queryVersionId: string;
  queryRunId: string;
  repository: string;
  windowStart: string;
  windowEnd: string;
  dimensions: Record<string, unknown>;
  payload: unknown[];
};

export type SnapshotRevision = {
  id: string;
  revision: number;
  created: boolean;
};

export type AggregateArchiveOutcome = {
  ok: boolean;
  revision?: number;
  retryable: boolean;
  error?: string;
};

export type AggregateArchiveDeps = {
  encryptionKey: Buffer;
  fetch?: FetchFn;
  pageSize?: number;
  pollAttempts?: number;
  pollIntervalMs?: number;
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

function canonicalDimensions(dimensions: Record<string, unknown>): {
  dimensions: Record<string, unknown>;
  hash: string;
} {
  const sorted = sortKeys(dimensions);
  const json = JSON.stringify(sorted);
  return {
    dimensions: sorted,
    hash: createHash("sha256").update(json).digest("hex"),
  };
}

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  return sorted;
}

function stablePayloadJson(payload: unknown[]): string {
  return JSON.stringify(payload);
}

function createLogScaleClient(
  deps: AggregateArchiveDeps,
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

export async function storeAggregateSnapshot(
  db: Database,
  input: AggregateSnapshotInput,
): Promise<SnapshotRevision> {
  const { dimensions, hash } = canonicalDimensions(input.dimensions);
  const payloadJson = stablePayloadJson(input.payload);

  const existing = await db.query<{
    id: string;
    revision: number;
    payload: unknown;
  }>(
    `SELECT id, revision, payload
     FROM aggregate_snapshots
     WHERE query_version_id = $1
       AND repository = $2
       AND window_start = $3::timestamptz
       AND window_end = $4::timestamptz
       AND dimensions_hash = $5
     ORDER BY revision DESC
     LIMIT 1`,
    [input.queryVersionId, input.repository, input.windowStart, input.windowEnd, hash],
  );

  const latest = existing.rows[0];
  if (latest && stablePayloadJson(latest.payload as unknown[]) === payloadJson) {
    return { id: latest.id, revision: latest.revision, created: false };
  }

  const revision = latest ? latest.revision + 1 : 1;
  const inserted = await db.query<{ id: string; revision: number }>(
    `INSERT INTO aggregate_snapshots
       (query_version_id, query_run_id, repository, window_start, window_end,
        dimensions, dimensions_hash, revision, payload)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb, $7, $8, $9::jsonb)
     RETURNING id, revision`,
    [
      input.queryVersionId,
      input.queryRunId,
      input.repository,
      input.windowStart,
      input.windowEnd,
      JSON.stringify(dimensions),
      hash,
      revision,
      payloadJson,
    ],
  );

  const row = inserted.rows[0]!;
  return { id: row.id, revision: row.revision, created: true };
}

async function markRunComplete(
  db: Database,
  runId: string,
  queryVersionId: string,
  kind: QueryRunKind,
  window: AggregateWindow,
  revision: number,
): Promise<void> {
  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE query_runs
       SET status = 'complete', failure_reason = NULL, result_count = $2, finished_at = now()
       WHERE id = $1`,
      [runId, revision],
    );

    if (kind === "scheduled") {
      await client.query(
        `UPDATE query_schedules
         SET watermark_at = $2, updated_at = now()
         WHERE query_version_id = $1`,
        [queryVersionId, window.end],
      );
    }
  });

  await writeAuditEntry(db, {
    action: "aggregate_archive.complete",
    metadata: {
      runId,
      queryVersionId,
      kind,
      revision,
      windowStart: window.start,
      windowEnd: window.end,
    },
  });
}

async function markRunFailed(
  db: Database,
  runId: string,
  queryVersionId: string,
  kind: QueryRunKind,
  window: AggregateWindow,
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
    action: retryable ? "aggregate_archive.retry" : "aggregate_archive.failed",
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

export async function archiveAggregateWindow(
  db: Database,
  deps: AggregateArchiveDeps,
  runId: string,
  window: AggregateWindow,
  dimensions: Record<string, unknown> = {},
): Promise<AggregateArchiveOutcome> {
  const ctx = await loadRunContext(db, runId);
  if (!ctx) {
    return { ok: false, retryable: false, error: "run_not_found" };
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

  try {
    const job = await client.createQueryJob({
      query: ctx.query_text,
      start: window.start,
      end: window.end,
    });
    jobId = job.id;

    let poll = await client.pollQueryJob(job.id);
    for (let attempt = 0; attempt < pollAttempts && poll.status === "running"; attempt += 1) {
      await sleep(pollIntervalMs);
      poll = await client.pollQueryJob(job.id);
    }

    if (poll.status !== "done") {
      const message = poll.error ?? "Query job did not complete successfully";
      await markRunFailed(db, runId, ctx.query_version_id, ctx.kind, window, message, true);
      return { ok: false, retryable: true, error: message };
    }

    const warnings = poll.warnings ?? [];
    if (hasResultCapWarning(warnings)) {
      const message = formatFailureMetadata(warnings);
      await markRunFailed(db, runId, ctx.query_version_id, ctx.kind, window, message, false);
      return { ok: false, retryable: false, error: message };
    }

    const results: unknown[] = [];
    let offset = 0;
    let done = false;
    while (!done) {
      const page = await client.getResultPage(jobId, offset, pageSize);
      results.push(...page.events);
      done = page.done || page.events.length === 0;
      offset += page.events.length;
    }

    const validation = validateAggregateResults(results, window.start, window.end);
    if (!validation.ok) {
      const message = validation.errors.join("; ");
      await markRunFailed(db, runId, ctx.query_version_id, ctx.kind, window, message, false);
      return { ok: false, retryable: false, error: message };
    }

    const snapshot = await storeAggregateSnapshot(db, {
      queryVersionId: ctx.query_version_id,
      queryRunId: runId,
      repository: ctx.repository,
      windowStart: window.start,
      windowEnd: window.end,
      dimensions,
      payload: results,
    });

    await markRunComplete(
      db,
      runId,
      ctx.query_version_id,
      ctx.kind,
      window,
      snapshot.revision,
    );
    return { ok: true, revision: snapshot.revision, retryable: false };
  } catch (error) {
    const retryable = isRetryableArchiveError(error);
    const message = error instanceof Error ? error.message : "Aggregate archive failed";
    await markRunFailed(db, runId, ctx.query_version_id, ctx.kind, window, message, retryable);
    return { ok: false, retryable, error: message };
  } finally {
    if (jobId) {
      await client.deleteQueryJob(jobId).catch(() => {});
    }
  }
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
