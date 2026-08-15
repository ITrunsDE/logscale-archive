import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db/repositories.js";
import type { QueryMode } from "../queries/validateQuery.js";
import type { UserRole } from "../auth/users.js";

export type SearchActor = {
  userId: string;
  role: UserRole;
};

export type JsonFieldFilter = {
  field: string;
  value: string;
};

export type StoredResultFilters = {
  queryVersionId: string;
  from?: string;
  to?: string;
  jsonFilters?: JsonFieldFilter[];
  limit?: number;
  offset?: number;
};

export type StoredResultRow = {
  id: string;
  queryRunId: string;
  timestamp: string;
  metadata: Record<string, unknown>;
  payload: Record<string, unknown>;
  runStatus: string | null;
};

export type PaginatedResults = {
  mode: QueryMode;
  columns: string[];
  rows: StoredResultRow[];
  total: number;
  limit: number;
  offset: number;
};

export type ExportFormat = "csv" | "ndjson";

export type CreateExportRequest = {
  queryVersionId: string;
  format: ExportFormat;
  filters: StoredResultFilters;
  requestedByUserId: string;
  expiresAt?: Date;
};

export type ExportJob = {
  id: string;
  queryVersionId: string;
  format: ExportFormat;
  filters: StoredResultFilters;
  status: "pending" | "running" | "complete" | "failed" | "expired";
  filePath: string | null;
  resultCount: number | null;
  errorMessage: string | null;
  expiresAt: string;
  createdAt: string;
  finishedAt: string | null;
  requestedByUserId: string;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

type ExportRow = {
  id: string;
  requested_by_user_id: string;
  query_version_id: string;
  format: ExportFormat;
  filters: StoredResultFilters;
  status: ExportJob["status"];
  file_path: string | null;
  result_count: string | null;
  error_message: string | null;
  expires_at: Date;
  created_at: Date;
  finished_at: Date | null;
};

function clampLimit(limit?: number): number {
  if (!limit || limit < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(limit, MAX_LIMIT);
}

function detectColumns(rows: StoredResultRow[], fixed: string[]): string[] {
  const keys = new Set(fixed);
  for (const row of rows) {
    for (const key of Object.keys(row.payload)) {
      keys.add(key);
    }
  }
  return [...keys];
}

function buildJsonFilterClauses(
  jsonFilters: JsonFieldFilter[] | undefined,
  columnPrefix: string,
  params: unknown[],
): string {
  if (!jsonFilters?.length) {
    return "";
  }
  return jsonFilters
    .map((filter) => {
      params.push(filter.field);
      const fieldIndex = params.length;
      params.push(filter.value);
      const valueIndex = params.length;
      return ` AND ${columnPrefix}->>$${fieldIndex} = $${valueIndex}`;
    })
    .join("");
}

export function exportRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.EXPORT_PATH ?? "/var/archive/exports";
}

export function exportFilePath(
  exportId: string,
  format: ExportFormat,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(exportRoot(env), `${exportId}.${format}`);
}

/** Database backup paths exclude export volume files by design. */
export function pathsIncludedInBackup(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.DATA_PATH, env.BACKUP_PATH].filter((value): value is string => Boolean(value));
}

export function isExportPath(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return path.startsWith(exportRoot(env));
}

function toExportJob(row: ExportRow): ExportJob {
  return {
    id: row.id,
    queryVersionId: row.query_version_id,
    format: row.format,
    filters: row.filters,
    status: row.status,
    filePath: row.file_path,
    resultCount: row.result_count === null ? null : Number(row.result_count),
    errorMessage: row.error_message,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    requestedByUserId: row.requested_by_user_id,
  };
}

async function getQueryMode(db: Database, queryVersionId: string): Promise<QueryMode> {
  const result = await db.query<{ mode: QueryMode }>(
    `SELECT mode FROM query_versions WHERE id = $1`,
    [queryVersionId],
  );
  const mode = result.rows[0]?.mode;
  if (!mode) {
    throw new Error("query_version_not_found");
  }
  return mode;
}

export async function searchStoredResults(
  db: Database,
  filters: StoredResultFilters,
  _actor: SearchActor,
): Promise<PaginatedResults> {
  const mode = await getQueryMode(db, filters.queryVersionId);
  const limit = clampLimit(filters.limit);
  const offset = filters.offset ?? 0;
  const params: unknown[] = [filters.queryVersionId, filters.from ?? null, filters.to ?? null];
  const jsonClause = buildJsonFilterClauses(filters.jsonFilters, "payload", params);

  if (mode === "event") {
    const count = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM event_records
       WHERE query_version_id = $1
         AND ($2::timestamptz IS NULL OR event_timestamp >= $2)
         AND ($3::timestamptz IS NULL OR event_timestamp < $3)
         ${jsonClause}`,
      params,
    );

    const limitIndex = params.length + 1;
    const offsetIndex = params.length + 2;
    const rows = await db.query<{
      id: string;
      query_run_id: string;
      event_timestamp: Date;
      source_repo: string;
      source_event_id: string;
      payload: Record<string, unknown>;
      run_status: string | null;
    }>(
      `SELECT er.id, er.query_run_id, er.event_timestamp, er.source_repo, er.source_event_id,
              er.payload, qr.status AS run_status
       FROM event_records er
       JOIN query_runs qr ON qr.id = er.query_run_id
       WHERE er.query_version_id = $1
         AND ($2::timestamptz IS NULL OR er.event_timestamp >= $2)
         AND ($3::timestamptz IS NULL OR er.event_timestamp < $3)
         ${jsonClause}
       ORDER BY er.event_timestamp ASC, er.id ASC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      [...params, limit, offset],
    );

    const mapped = rows.rows.map((row) => ({
      id: row.id,
      queryRunId: row.query_run_id,
      timestamp: row.event_timestamp.toISOString(),
      metadata: {
        source_repo: row.source_repo,
        source_event_id: row.source_event_id,
        event_timestamp: row.event_timestamp.toISOString(),
      },
      payload: row.payload,
      runStatus: row.run_status,
    }));

    return {
      mode,
      columns: detectColumns(mapped, ["event_timestamp", "source_repo", "source_event_id"]),
      rows: mapped,
      total: Number(count.rows[0]?.count ?? 0),
      limit,
      offset,
    };
  }

  const count = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM aggregate_snapshots
     WHERE query_version_id = $1
       AND ($2::timestamptz IS NULL OR window_start >= $2)
       AND ($3::timestamptz IS NULL OR window_end <= $3)
       ${jsonClause}`,
    params,
  );

  const limitIndex = params.length + 1;
  const offsetIndex = params.length + 2;
  const rows = await db.query<{
    id: string;
    query_run_id: string;
    window_start: Date;
    window_end: Date;
    repository: string;
    dimensions: Record<string, unknown>;
    payload: Record<string, unknown>;
    run_status: string | null;
  }>(
    `SELECT ag.id, ag.query_run_id, ag.window_start, ag.window_end, ag.repository,
            ag.dimensions, ag.payload, qr.status AS run_status
     FROM aggregate_snapshots ag
     JOIN query_runs qr ON qr.id = ag.query_run_id
     WHERE ag.query_version_id = $1
       AND ($2::timestamptz IS NULL OR ag.window_start >= $2)
       AND ($3::timestamptz IS NULL OR ag.window_end <= $3)
       ${jsonClause}
     ORDER BY ag.window_start ASC, ag.id ASC
     LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    [...params, limit, offset],
  );

  const mapped = rows.rows.map((row) => ({
    id: row.id,
    queryRunId: row.query_run_id,
    timestamp: row.window_start.toISOString(),
    metadata: {
      repository: row.repository,
      window_start: row.window_start.toISOString(),
      window_end: row.window_end.toISOString(),
      dimensions: row.dimensions,
    },
    payload: row.payload,
    runStatus: row.run_status,
  }));

  return {
    mode,
    columns: detectColumns(mapped, ["window_start", "window_end", "repository"]),
    rows: mapped,
    total: Number(count.rows[0]?.count ?? 0),
    limit,
    offset,
  };
}

export async function searchAllStoredResults(
  db: Database,
  filters: StoredResultFilters,
): Promise<PaginatedResults> {
  const pageSize = MAX_LIMIT;
  let offset = 0;
  let total = 0;
  let mode: QueryMode = "event";
  let columns: string[] = [];
  const rows: StoredResultRow[] = [];

  for (;;) {
    const page = await searchStoredResults(
      db,
      { ...filters, limit: pageSize, offset },
      { userId: "export", role: "admin" },
    );
    mode = page.mode;
    columns = page.columns;
    total = page.total;
    rows.push(...page.rows);
    offset += page.rows.length;
    if (offset >= total || page.rows.length === 0) {
      break;
    }
  }

  return { mode, columns, rows, total, limit: total, offset: 0 };
}

export async function createExport(
  db: Database,
  request: CreateExportRequest,
): Promise<ExportJob> {
  const expiresAt = request.expiresAt ?? new Date(Date.now() + EXPORT_TTL_MS);
  const filters = {
    ...request.filters,
    queryVersionId: request.queryVersionId,
  };

  const inserted = await db.query<ExportRow>(
    `INSERT INTO exports
       (requested_by_user_id, query_version_id, format, filters, status, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, 'pending', $5)
     RETURNING id, requested_by_user_id, query_version_id, format, filters, status,
               file_path, result_count, error_message, expires_at, created_at, finished_at`,
    [
      request.requestedByUserId,
      request.queryVersionId,
      request.format,
      JSON.stringify(filters),
      expiresAt,
    ],
  );

  return toExportJob(inserted.rows[0]!);
}

export async function listExports(
  db: Database,
  userId: string,
  role: UserRole,
): Promise<ExportJob[]> {
  const result =
    role === "admin"
      ? await db.query<ExportRow>(
          `SELECT id, requested_by_user_id, query_version_id, format, filters, status,
                  file_path, result_count, error_message, expires_at, created_at, finished_at
           FROM exports
           ORDER BY created_at DESC`,
        )
      : await db.query<ExportRow>(
          `SELECT id, requested_by_user_id, query_version_id, format, filters, status,
                  file_path, result_count, error_message, expires_at, created_at, finished_at
           FROM exports
           WHERE requested_by_user_id = $1
           ORDER BY created_at DESC`,
          [userId],
        );

  return result.rows.map(toExportJob);
}

export async function getExport(db: Database, exportId: string): Promise<ExportJob | null> {
  const result = await db.query<ExportRow>(
    `SELECT id, requested_by_user_id, query_version_id, format, filters, status,
            file_path, result_count, error_message, expires_at, created_at, finished_at
     FROM exports
     WHERE id = $1`,
    [exportId],
  );
  const row = result.rows[0];
  return row ? toExportJob(row) : null;
}

export function canDownloadExport(
  job: ExportJob,
  userId: string,
  role: UserRole,
): boolean {
  return role === "admin" || job.requestedByUserId === userId;
}

export async function claimNextExport(db: Database): Promise<ExportJob | null> {
  return db.withTransaction(async (client) => {
    const candidate = await client.query<ExportRow>(
      `SELECT id, requested_by_user_id, query_version_id, format, filters, status,
              file_path, result_count, error_message, expires_at, created_at, finished_at
       FROM exports
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    const row = candidate.rows[0];
    if (!row) {
      return null;
    }

    await client.query(`UPDATE exports SET status = 'running' WHERE id = $1`, [row.id]);
    return toExportJob({ ...row, status: "running" });
  });
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeExportFile(
  path: string,
  format: ExportFormat,
  results: PaginatedResults,
): void {
  mkdirSync(exportRoot(), { recursive: true });
  if (format === "ndjson") {
    const lines = results.rows.map((row) =>
      JSON.stringify({ ...row.metadata, ...row.payload }),
    );
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    return;
  }

  const header = results.columns.join(",");
  const body = results.rows
    .map((row) => {
      const record = { ...row.metadata, ...row.payload };
      return results.columns.map((column) => csvEscape(record[column])).join(",");
    })
    .join("\n");
  writeFileSync(path, `${header}\n${body}\n`, "utf8");
}

export async function runExportJob(
  db: Database,
  job: ExportJob,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExportJob> {
  try {
    const results = await searchAllStoredResults(db, job.filters);
    const path = exportFilePath(job.id, job.format, env);
    writeExportFile(path, job.format, results);
    const updated = await db.query<ExportRow>(
      `UPDATE exports
       SET status = 'complete', file_path = $2, result_count = $3, finished_at = now()
       WHERE id = $1
       RETURNING id, requested_by_user_id, query_version_id, format, filters, status,
                 file_path, result_count, error_message, expires_at, created_at, finished_at`,
      [job.id, path, results.total],
    );
    return toExportJob(updated.rows[0]!);
  } catch (error) {
    const message = error instanceof Error ? error.message : "export_failed";
    const updated = await db.query<ExportRow>(
      `UPDATE exports
       SET status = 'failed', error_message = $2, finished_at = now()
       WHERE id = $1
       RETURNING id, requested_by_user_id, query_version_id, format, filters, status,
                 file_path, result_count, error_message, expires_at, created_at, finished_at`,
      [job.id, message],
    );
    return toExportJob(updated.rows[0]!);
  }
}

export async function expireExports(
  db: Database,
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const expired = await db.query<{ id: string; file_path: string | null }>(
    `UPDATE exports
     SET status = 'expired'
     WHERE status <> 'expired' AND expires_at <= $1
     RETURNING id, file_path`,
    [now],
  );

  for (const row of expired.rows) {
    if (row.file_path && isExportPath(row.file_path, env)) {
      try {
        unlinkSync(row.file_path);
      } catch {
        // file may already be gone
      }
    }
  }

  return expired.rowCount ?? expired.rows.length;
}

export async function listSearchableQueryVersions(db: Database): Promise<
  Array<{
    id: string;
    name: string;
    versionNumber: number;
    mode: QueryMode;
    connectionName: string;
    repository: string;
  }>
> {
  const result = await db.query<{
    id: string;
    name: string;
    version_number: number;
    mode: QueryMode;
    connection_name: string;
    repository: string;
  }>(
    `SELECT qv.id, qv.name, qv.version_number, qv.mode,
            lc.name AS connection_name, lc.repository
     FROM query_versions qv
     JOIN logscale_connections lc ON lc.id = qv.connection_id
     WHERE qv.active = true
     ORDER BY lc.name ASC, qv.name ASC, qv.version_number DESC`,
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    versionNumber: row.version_number,
    mode: row.mode,
    connectionName: row.connection_name,
    repository: row.repository,
  }));
}
