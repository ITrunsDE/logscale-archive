import type { Database } from "../db/repositories.js";

export type QueryRunKind = "scheduled" | "backfill" | "test";
export type QueryRunStatus = "pending" | "running" | "complete" | "failed" | "split" | "cancelled";

export type QueryRun = {
  id: string;
  queryVersionId: string;
  kind: QueryRunKind;
  status: QueryRunStatus;
  windowStart: string;
  windowEnd: string;
  parentRunId: string | null;
  failureReason: string | null;
  resultCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

type QueryRunRow = {
  id: string;
  query_version_id: string;
  kind: QueryRunKind;
  status: QueryRunStatus;
  window_start: Date;
  window_end: Date;
  parent_run_id: string | null;
  failure_reason: string | null;
  result_count: string;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
};

function toQueryRun(row: QueryRunRow): QueryRun {
  return {
    id: row.id,
    queryVersionId: row.query_version_id,
    kind: row.kind,
    status: row.status,
    windowStart: row.window_start.toISOString(),
    windowEnd: row.window_end.toISOString(),
    parentRunId: row.parent_run_id,
    failureReason: row.failure_reason,
    resultCount: Number(row.result_count),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export type ClaimNextRunOptions = {
  globalConcurrency?: number;
};

export async function claimNextRun(
  db: Database,
  workerId: string,
  options: ClaimNextRunOptions = {},
): Promise<QueryRun | null> {
  const globalConcurrency = options.globalConcurrency ?? 1;
  void workerId;

  return db.withTransaction(async (client) => {
    const running = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM query_runs WHERE status = 'running'`,
    );
    if (Number(running.rows[0]?.count ?? 0) >= globalConcurrency) {
      return null;
    }

    const candidate = await client.query<QueryRunRow>(
      `SELECT qr.id, qr.query_version_id, qr.kind, qr.status, qr.window_start, qr.window_end,
              qr.parent_run_id, qr.failure_reason, qr.result_count, qr.started_at, qr.finished_at, qr.created_at
       FROM query_runs qr
       JOIN query_versions qv ON qv.id = qr.query_version_id
       WHERE qr.status = 'pending'
         AND qr.kind IN ('scheduled', 'backfill')
         AND qv.active = true
         AND NOT EXISTS (
           SELECT 1 FROM query_runs active
           WHERE active.query_version_id = qr.query_version_id
             AND active.status = 'running'
         )
       ORDER BY CASE qr.kind WHEN 'scheduled' THEN 0 WHEN 'backfill' THEN 1 ELSE 2 END,
                qr.created_at
       FOR UPDATE OF qr SKIP LOCKED
       LIMIT 1`,
    );

    const row = candidate.rows[0];
    if (!row) {
      return null;
    }

    await client.query(
      `UPDATE query_runs
       SET status = 'running', started_at = COALESCE(started_at, now()), failure_reason = NULL
       WHERE id = $1`,
      [row.id],
    );

    return toQueryRun({ ...row, status: "running" });
  });
}

/**
 * Reset query runs left in `running` after worker crash/deploy.
 * Safe under global concurrency 1 (single active worker). Event inserts are idempotent.
 */
export async function reclaimOrphanedQueryRuns(
  db: Database,
  startedBefore: Date,
): Promise<number> {
  const result = await db.query(
    `UPDATE query_runs
     SET status = 'pending',
         started_at = NULL,
         failure_reason = 'orphaned running run reclaimed'
     WHERE status = 'running'
       AND started_at IS NOT NULL
       AND started_at < $1`,
    [startedBefore],
  );
  return result.rowCount ?? 0;
}

export async function getQueryRun(db: Database, runId: string): Promise<QueryRun | null> {
  const result = await db.query<QueryRunRow>(
    `SELECT id, query_version_id, kind, status, window_start, window_end,
            parent_run_id, failure_reason, result_count, started_at, finished_at, created_at
     FROM query_runs
     WHERE id = $1`,
    [runId],
  );
  const row = result.rows[0];
  return row ? toQueryRun(row) : null;
}

export type QueryRunListItem = {
  id: string;
  queryName: string;
  versionNumber: number;
  kind: QueryRunKind;
  status: QueryRunStatus;
  failureReason: string | null;
  windowStart: string;
  windowEnd: string;
  finishedAt: string | null;
  createdAt: string;
};

export type QueryRunFailure = QueryRunListItem;

const LISTABLE_RUN_STATUSES: QueryRunStatus[] = [
  "pending",
  "running",
  "complete",
  "failed",
  "split",
  "cancelled",
];

export function isListableQueryRunStatus(value: string): value is QueryRunStatus {
  return (LISTABLE_RUN_STATUSES as string[]).includes(value);
}

export async function listQueryRunsByStatus(
  db: Database,
  status: QueryRunStatus,
  limit = 50,
): Promise<QueryRunListItem[]> {
  const result = await db.query<{
    id: string;
    query_name: string;
    version_number: number;
    kind: QueryRunKind;
    status: QueryRunStatus;
    failure_reason: string | null;
    window_start: Date;
    window_end: Date;
    finished_at: Date | null;
    created_at: Date;
  }>(
    `SELECT qr.id, qv.name AS query_name, qv.version_number, qr.kind, qr.status, qr.failure_reason,
            qr.window_start, qr.window_end, qr.finished_at, qr.created_at
     FROM query_runs qr
     JOIN query_versions qv ON qv.id = qr.query_version_id
     WHERE qr.status = $1
     ORDER BY coalesce(qr.finished_at, qr.created_at) DESC
     LIMIT $2`,
    [status, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    queryName: row.query_name,
    versionNumber: row.version_number,
    kind: row.kind,
    status: row.status,
    failureReason: row.failure_reason,
    windowStart: row.window_start.toISOString(),
    windowEnd: row.window_end.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function listFailedQueryRuns(
  db: Database,
  limit = 50,
): Promise<QueryRunListItem[]> {
  return listQueryRunsByStatus(db, "failed", limit);
}
