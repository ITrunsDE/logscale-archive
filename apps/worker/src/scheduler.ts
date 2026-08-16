import type { Database } from "@archive/core";
import { computeNextRunAt } from "@archive/core";

export async function enqueueDueRuns(db: Database, now: Date = new Date()): Promise<void> {
  await db.withTransaction(async (client) => {
    const due = await client.query<{
      query_version_id: string;
      schedule_cron: string | null;
      schedule_timezone: string;
      window_start: Date;
      window_end: Date;
    }>(
      `SELECT qv.id AS query_version_id,
              qv.schedule_cron,
              qv.schedule_timezone,
              COALESCE(qs.watermark_at, qv.initial_start_at) AS window_start,
              now() - make_interval(secs => qv.correction_window_seconds) AS window_end
       FROM query_versions qv
       JOIN query_schedules qs ON qs.query_version_id = qv.id
       WHERE qv.active = true
         AND qv.mode = 'event'
         AND NOT qs.paused
         AND qs.next_run_at IS NOT NULL
         AND qs.next_run_at <= now()
         AND COALESCE(qs.watermark_at, qv.initial_start_at)
             < now() - make_interval(secs => qv.correction_window_seconds)
         AND NOT EXISTS (
           SELECT 1 FROM query_runs r
           WHERE r.query_version_id = qv.id
             AND r.status IN ('pending', 'running')
         )
       FOR UPDATE OF qs SKIP LOCKED`,
    );

    for (const row of due.rows) {
      try {
        const nextRunAt = computeNextRunAt(row.schedule_cron ?? "", row.schedule_timezone, now);
        await client.query(
          `UPDATE query_schedules
           SET next_run_at = $2, updated_at = now()
           WHERE query_version_id = $1`,
          [row.query_version_id, nextRunAt.toISOString()],
        );
      } catch {
        await client.query(
          `UPDATE query_schedules
           SET paused = true, updated_at = now()
           WHERE query_version_id = $1`,
          [row.query_version_id],
        );
        continue;
      }
      await client.query(
        `INSERT INTO query_runs (query_version_id, kind, status, window_start, window_end)
         VALUES ($1, 'scheduled', 'pending', $2, $3)`,
        [row.query_version_id, row.window_start, row.window_end],
      );
    }
  });

  await db.query(
    `INSERT INTO query_runs (query_version_id, kind, status, window_start, window_end)
     SELECT bw.query_version_id, 'backfill', 'pending', bw.window_start, bw.window_end
     FROM backfill_windows bw
     JOIN query_versions qv ON qv.id = bw.query_version_id
     WHERE bw.status = 'pending'
       AND qv.active = true
       AND qv.mode = 'event'
       AND NOT EXISTS (
         SELECT 1 FROM query_runs r
         WHERE r.query_version_id = bw.query_version_id
           AND r.status IN ('pending', 'running')
       )
       AND NOT EXISTS (
         SELECT 1 FROM query_runs r
         WHERE r.query_version_id = bw.query_version_id
           AND r.kind = 'backfill'
           AND r.window_start = bw.window_start
           AND r.window_end = bw.window_end
           AND r.status IN ('pending', 'running')
       )`,
  );
}
