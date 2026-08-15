import type { Database } from "@archive/core";

export async function enqueueDueRuns(db: Database): Promise<void> {
  await db.query(
    `INSERT INTO query_runs (query_version_id, kind, status, window_start, window_end)
     SELECT qv.id,
            'scheduled',
            'pending',
            COALESCE(qs.watermark_at, qv.initial_start_at),
            now() - make_interval(secs => qv.correction_window_seconds)
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
       )`,
  );

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
           AND r.status <> 'failed'
       )`,
  );
}
