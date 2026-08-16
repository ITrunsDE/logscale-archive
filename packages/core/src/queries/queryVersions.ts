import type { Database } from "../db/repositories.js";
import { decryptSecret, encryptedSecretFromBytes } from "../security/encryption.js";
import { LogScaleClient } from "../logscale/client.js";
import type { FetchFn, LogScaleClientConfig } from "../logscale/types.js";
import {
  validateAggregateResults,
  validateEventResults,
  validateQueryText,
  type QueryMode,
} from "./validateQuery.js";

export type QueryVersion = {
  id: string;
  connectionId: string;
  name: string;
  versionNumber: number;
  queryText: string;
  mode: QueryMode;
  scheduleCron: string | null;
  scheduleTimezone: string;
  initialStartAt: string;
  correctionWindowSeconds: number;
  retentionDays: number | null;
  active: boolean;
  testPassedAt: string | null;
  createdAt: string;
  nextRunAt: string | null;
};

export const DEFAULT_SCHEDULE_CRON = "0 * * * *";
export const DEFAULT_SCHEDULE_TIMEZONE = "UTC";

export function normalizeScheduleCron(cron: string | null | undefined): string {
  const trimmed = cron?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_SCHEDULE_CRON;
}

export type CreateQueryDraftInput = {
  connectionId: string;
  name: string;
  queryText: string;
  mode: QueryMode;
  scheduleCron?: string | null;
  scheduleTimezone?: string;
  initialStartAt: string;
  correctionWindowSeconds?: number;
  retentionDays?: number | null;
};

export type SampleWindow = {
  start: string;
  end: string;
};

export type QueryTestResult = {
  ok: boolean;
  errors: string[];
  eventCount: number;
  sampleEvents: unknown[];
};

type QueryVersionRow = {
  id: string;
  connection_id: string;
  name: string;
  version_number: number;
  query_text: string;
  mode: QueryMode;
  schedule_cron: string | null;
  schedule_timezone: string;
  initial_start_at: Date;
  correction_window_seconds: number;
  retention_days: number | null;
  active: boolean;
  test_passed_at: Date | null;
  created_at: Date;
};

type ConnectionRow = {
  endpoint: string;
  repository: string;
  token_ciphertext: Buffer;
};

export type QueryVersionsDeps = {
  encryptionKey: Buffer;
  fetch?: FetchFn;
  createClient?: (config: LogScaleClientConfig) => LogScaleClient;
};

function asIso(value: Date | string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toQueryVersion(row: QueryVersionRow, nextRunAt: string | null = null): QueryVersion {
  return {
    id: row.id,
    connectionId: row.connection_id,
    name: row.name,
    versionNumber: row.version_number,
    queryText: row.query_text,
    mode: row.mode,
    scheduleCron: row.schedule_cron,
    scheduleTimezone: row.schedule_timezone,
    initialStartAt: asIso(row.initial_start_at) ?? new Date(0).toISOString(),
    correctionWindowSeconds: row.correction_window_seconds,
    retentionDays: row.retention_days,
    active: row.active,
    testPassedAt: asIso(row.test_passed_at),
    createdAt: asIso(row.created_at) ?? new Date(0).toISOString(),
    nextRunAt,
  };
}

async function loadVersion(db: Database, id: string): Promise<QueryVersionRow | null> {
  const result = await db.query<QueryVersionRow>(
    `SELECT id, connection_id, name, version_number, query_text, mode,
            schedule_cron, schedule_timezone, initial_start_at, correction_window_seconds,
            retention_days, active, test_passed_at, created_at
     FROM query_versions
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function nextVersionNumber(
  db: Database,
  connectionId: string,
  name: string,
): Promise<number> {
  const result = await db.query<{ max: number | null }>(
    `SELECT MAX(version_number) AS max
     FROM query_versions
     WHERE connection_id = $1 AND name = $2`,
    [connectionId, name],
  );
  return (result.rows[0]?.max ?? 0) + 1;
}

async function loadConnection(
  db: Database,
  connectionId: string,
): Promise<ConnectionRow | null> {
  const result = await db.query<ConnectionRow>(
    `SELECT endpoint, repository, token_ciphertext
     FROM logscale_connections
     WHERE id = $1`,
    [connectionId],
  );
  return result.rows[0] ?? null;
}

function createLogScaleClient(
  deps: QueryVersionsDeps,
  connection: ConnectionRow,
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

export type QueryNameSummary = {
  name: string;
  active: boolean;
};

export async function listQueryNames(
  db: Database,
  connectionId: string,
): Promise<QueryNameSummary[]> {
  const result = await db.query<{ name: string; active: boolean }>(
    `SELECT name, bool_or(active) AS active
     FROM query_versions
     WHERE connection_id = $1
     GROUP BY name
     ORDER BY name ASC`,
    [connectionId],
  );
  return result.rows.map((row) => ({ name: row.name, active: row.active }));
}

export async function listQueryVersions(
  db: Database,
  connectionId: string,
  name: string,
): Promise<QueryVersion[]> {
  const result = await db.query<
    QueryVersionRow & {
      next_run_at: Date | null;
      schedule_paused: boolean | null;
    }
  >(
    `SELECT qv.id, qv.connection_id, qv.name, qv.version_number, qv.query_text, qv.mode,
            qv.schedule_cron, qv.schedule_timezone, qv.initial_start_at, qv.correction_window_seconds,
            qv.retention_days, qv.active, qv.test_passed_at, qv.created_at,
            qs.next_run_at, qs.paused AS schedule_paused
     FROM query_versions qv
     LEFT JOIN query_schedules qs ON qs.query_version_id = qv.id
     WHERE qv.connection_id = $1 AND qv.name = $2
     ORDER BY qv.version_number DESC`,
    [connectionId, name],
  );
  return result.rows.map((row) => {
    const nextRunAt =
      row.schedule_paused === true ? null : asIso(row.next_run_at);
    return toQueryVersion(row, nextRunAt);
  });
}

export async function createQueryDraft(
  db: Database,
  input: CreateQueryDraftInput,
): Promise<{ version: QueryVersion; validation: { ok: boolean; errors: string[] } }> {
  const validation = validateQueryText(input.queryText, input.mode);
  if (!validation.ok) {
    throw Object.assign(new Error("invalid_query"), { validation });
  }

  const connection = await loadConnection(db, input.connectionId);
  if (!connection) {
    throw Object.assign(new Error("connection_not_found"));
  }

  const versionNumber = await nextVersionNumber(db, input.connectionId, input.name);
  const scheduleCron = normalizeScheduleCron(input.scheduleCron);
  const scheduleTimezone = input.scheduleTimezone?.trim() || DEFAULT_SCHEDULE_TIMEZONE;
  const inserted = await db.query<QueryVersionRow>(
    `INSERT INTO query_versions
       (connection_id, name, version_number, query_text, mode, schedule_cron, schedule_timezone,
        initial_start_at, correction_window_seconds, retention_days, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false)
     RETURNING id, connection_id, name, version_number, query_text, mode,
               schedule_cron, schedule_timezone, initial_start_at, correction_window_seconds,
               retention_days, active, test_passed_at, created_at`,
    [
      input.connectionId,
      input.name.trim(),
      versionNumber,
      input.queryText,
      input.mode,
      scheduleCron,
      scheduleTimezone,
      input.initialStartAt,
      input.correctionWindowSeconds ?? 0,
      input.retentionDays ?? null,
    ],
  );

  return { version: toQueryVersion(inserted.rows[0]!), validation };
}

export async function testQueryVersion(
  db: Database,
  deps: QueryVersionsDeps,
  id: string,
  sampleWindow: SampleWindow,
): Promise<QueryTestResult> {
  const row = await loadVersion(db, id);
  if (!row) {
    throw Object.assign(new Error("not_found"));
  }

  const textValidation = validateQueryText(row.query_text, row.mode);
  if (!textValidation.ok) {
    return { ok: false, errors: textValidation.errors, eventCount: 0, sampleEvents: [] };
  }

  const connection = await loadConnection(db, row.connection_id);
  if (!connection) {
    return { ok: false, errors: ["Connection not found"], eventCount: 0, sampleEvents: [] };
  }

  const token = decryptSecret(
    encryptedSecretFromBytes(connection.token_ciphertext),
    deps.encryptionKey,
  );
  const client = createLogScaleClient(deps, connection, token);

  const run = await db.query<{ id: string }>(
    `INSERT INTO query_runs
       (query_version_id, kind, status, window_start, window_end)
     VALUES ($1, 'test', 'running', $2, $3)
     RETURNING id`,
    [id, sampleWindow.start, sampleWindow.end],
  );
  const runId = run.rows[0]!.id;

  let jobId: string | undefined;
  try {
    const job = await client.createQueryJob({
      query: row.query_text,
      start: sampleWindow.start,
      end: sampleWindow.end,
    });
    jobId = job.id;

    let status = job.status;
    for (let attempt = 0; attempt < 60 && status === "running"; attempt += 1) {
      await sleep(500);
      const polled = await client.pollQueryJob(job.id);
      status = polled.status;
      if (status === "failed" || status === "cancelled") {
        const errors = [polled.error ?? `Query job ended with status ${status}`];
        await finishTestRun(db, runId, "failed", errors[0]!);
        return { ok: false, errors, eventCount: 0, sampleEvents: [] };
      }
    }
    if (status !== "done") {
      const errors = ["Query job did not complete successfully"];
      await finishTestRun(db, runId, "failed", errors[0]!);
      return { ok: false, errors, eventCount: 0, sampleEvents: [] };
    }

    const page = await client.getResultPage(job.id, 0, 20);
    const resultValidation =
      row.mode === "event"
        ? validateEventResults(page.events)
        : validateAggregateResults(page.events, sampleWindow.start, sampleWindow.end);

    if (!resultValidation.ok) {
      await finishTestRun(db, runId, "failed", resultValidation.errors.join("; "));
      await db.query(`UPDATE query_versions SET test_passed_at = NULL WHERE id = $1`, [id]);
      return {
        ok: false,
        errors: resultValidation.errors,
        eventCount: page.events.length,
        sampleEvents: page.events.slice(0, 5),
      };
    }

    await finishTestRun(db, runId, "complete", null, page.events.length);
    await db.query(`UPDATE query_versions SET test_passed_at = now() WHERE id = $1`, [id]);
    return {
      ok: true,
      errors: [],
      eventCount: page.events.length,
      sampleEvents: page.events.slice(0, 5),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Query test failed";
    await finishTestRun(db, runId, "failed", message);
    await db.query(`UPDATE query_versions SET test_passed_at = NULL WHERE id = $1`, [id]);
    return { ok: false, errors: [message], eventCount: 0, sampleEvents: [] };
  } finally {
    if (jobId) {
      await client.deleteQueryJob(jobId).catch(() => {});
    }
  }
}

async function finishTestRun(
  db: Database,
  runId: string,
  status: "complete" | "failed",
  failureReason: string | null,
  resultCount = 0,
): Promise<void> {
  await db.query(
    `UPDATE query_runs
     SET status = $2, failure_reason = $3, result_count = $4, finished_at = now(), started_at = coalesce(started_at, now())
     WHERE id = $1`,
    [runId, status, failureReason, resultCount],
  );
}

export async function activateQueryVersion(db: Database, id: string): Promise<void> {
  const row = await loadVersion(db, id);
  if (!row) {
    throw Object.assign(new Error("not_found"));
  }
  if (!row.test_passed_at) {
    throw Object.assign(new Error("test_required"));
  }

  await db.query(
    `UPDATE query_versions
     SET active = false
     WHERE connection_id = $1 AND name = $2 AND id <> $3`,
    [row.connection_id, row.name, id],
  );
  await db.query(
    `UPDATE query_versions SET active = true, schedule_cron = $2 WHERE id = $1`,
    [id, normalizeScheduleCron(row.schedule_cron)],
  );
  await db.query(
    `INSERT INTO query_schedules (query_version_id, next_run_at, paused)
     VALUES ($1, now(), false)
     ON CONFLICT (query_version_id)
     DO UPDATE SET next_run_at = now(), paused = false, updated_at = now()`,
    [id],
  );
}

export async function deactivateQueryVersion(db: Database, id: string): Promise<void> {
  const row = await loadVersion(db, id);
  if (!row) {
    throw Object.assign(new Error("not_found"));
  }

  await db.query(`UPDATE query_versions SET active = false WHERE id = $1`, [id]);
  await db.query(
    `UPDATE query_schedules
     SET paused = true, updated_at = now()
     WHERE query_version_id = $1`,
    [id],
  );
  await db.query(
    `UPDATE query_runs
     SET status = 'cancelled',
         failure_reason = 'query deactivated',
         finished_at = now()
     WHERE query_version_id = $1
       AND status IN ('pending', 'running')`,
    [id],
  );
  await db.query(
    `UPDATE backfill_windows
     SET status = 'paused', updated_at = now()
     WHERE query_version_id = $1
       AND status = 'pending'`,
    [id],
  );
}

export async function renameQuery(
  db: Database,
  connectionId: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const trimmed = newName.trim();
  if (!trimmed) {
    throw Object.assign(new Error("invalid_name"));
  }
  if (trimmed === oldName) {
    return;
  }

  const clash = await db.query(
    `SELECT 1 FROM query_versions WHERE connection_id = $1 AND name = $2 LIMIT 1`,
    [connectionId, trimmed],
  );
  if (clash.rows.length > 0) {
    throw Object.assign(new Error("name_taken"));
  }

  const updated = await db.query(
    `UPDATE query_versions
     SET name = $3
     WHERE connection_id = $1 AND name = $2`,
    [connectionId, oldName, trimmed],
  );
  if ((updated.rowCount ?? 0) === 0) {
    throw Object.assign(new Error("not_found"));
  }
}

export async function deleteQueryVersion(db: Database, id: string): Promise<void> {
  const row = await loadVersion(db, id);
  if (!row) {
    throw Object.assign(new Error("not_found"));
  }
  if (row.active) {
    throw Object.assign(new Error("active_version"));
  }

  await db.withTransaction(async (client) => {
    await client.query(`DELETE FROM retention_holds WHERE query_version_id = $1`, [id]);
    await client.query(`DELETE FROM query_schedules WHERE query_version_id = $1`, [id]);
    await client.query(`DELETE FROM backfill_windows WHERE query_version_id = $1`, [id]);
    await client.query(`DELETE FROM event_records WHERE query_version_id = $1`, [id]);
    await client.query(`DELETE FROM aggregate_snapshots WHERE query_version_id = $1`, [id]);
    await client.query(`UPDATE exports SET query_version_id = NULL WHERE query_version_id = $1`, [id]);
    await client.query(
      `DELETE FROM query_runs WHERE query_version_id = $1 AND parent_run_id IS NOT NULL`,
      [id],
    );
    await client.query(`DELETE FROM query_runs WHERE query_version_id = $1`, [id]);
    await client.query(`DELETE FROM query_versions WHERE id = $1`, [id]);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
