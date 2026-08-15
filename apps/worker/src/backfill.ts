import type { Database } from "@archive/core";

export type BackfillWindow = {
  id: string;
  queryVersionId: string;
  windowStart: string;
  windowEnd: string;
  status: string;
};

export type BackfillStatus = {
  pending: number;
  running: number;
  complete: number;
  failed: number;
  paused: number;
  windows: BackfillWindow[];
};

type BackfillRow = {
  id: string;
  query_version_id: string;
  window_start: Date;
  window_end: Date;
  status: string;
};

function utcDayWindows(startIso: string, endIso: string): Array<{ start: string; end: string }> {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("invalid_range");
  }

  const windows: Array<{ start: string; end: string }> = [];
  let cursor = start;
  while (cursor < end) {
    const date = new Date(cursor);
    const nextDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
    const windowEnd = Math.min(nextDay, end);
    windows.push({
      start: new Date(cursor).toISOString(),
      end: new Date(windowEnd).toISOString(),
    });
    cursor = windowEnd;
  }
  return windows;
}

function toWindow(row: BackfillRow): BackfillWindow {
  return {
    id: row.id,
    queryVersionId: row.query_version_id,
    windowStart: row.window_start.toISOString(),
    windowEnd: row.window_end.toISOString(),
    status: row.status,
  };
}

async function assertEventQueryVersion(db: Database, queryVersionId: string): Promise<void> {
  const result = await db.query<{ mode: string }>(
    `SELECT mode FROM query_versions WHERE id = $1`,
    [queryVersionId],
  );
  if (!result.rows[0]) {
    throw new Error("not_found");
  }
  if (result.rows[0].mode !== "event") {
    throw new Error("invalid_mode");
  }
}

export async function createBackfill(
  db: Database,
  queryVersionId: string,
  start: string,
  end: string,
): Promise<void> {
  await assertEventQueryVersion(db, queryVersionId);
  const windows = utcDayWindows(start, end);

  for (const window of windows) {
    await db.query(
      `INSERT INTO backfill_windows (query_version_id, window_start, window_end, status)
       SELECT $1, $2, $3, 'pending'
       WHERE NOT EXISTS (
         SELECT 1 FROM backfill_windows
         WHERE query_version_id = $1
           AND window_start = $2
           AND window_end = $3
           AND status <> 'failed'
       )`,
      [queryVersionId, window.start, window.end],
    );
  }
}

export async function pauseBackfill(db: Database, queryVersionId: string): Promise<number> {
  const result = await db.query(
    `UPDATE backfill_windows
     SET status = 'paused', updated_at = now()
     WHERE query_version_id = $1 AND status = 'pending'`,
    [queryVersionId],
  );
  return result.rowCount ?? 0;
}

export async function resumeBackfill(db: Database, queryVersionId: string): Promise<number> {
  const result = await db.query(
    `UPDATE backfill_windows
     SET status = 'pending', updated_at = now()
     WHERE query_version_id = $1 AND status = 'paused'`,
    [queryVersionId],
  );
  return result.rowCount ?? 0;
}

export async function getBackfillStatus(db: Database, queryVersionId: string): Promise<BackfillStatus> {
  const result = await db.query<BackfillRow>(
    `SELECT id, query_version_id, window_start, window_end, status
     FROM backfill_windows
     WHERE query_version_id = $1
     ORDER BY window_start`,
    [queryVersionId],
  );

  const counts = { pending: 0, running: 0, complete: 0, failed: 0, paused: 0 };
  const windows = result.rows.map((row) => {
    const window = toWindow(row);
    if (window.status in counts) {
      counts[window.status as keyof typeof counts] += 1;
    }
    return window;
  });

  return { ...counts, windows };
}
