UPDATE query_versions
SET schedule_cron = '0 * * * *'
WHERE schedule_cron IS NULL OR btrim(schedule_cron) = '';

INSERT INTO query_schedules (query_version_id, next_run_at, paused)
SELECT qv.id, now(), false
FROM query_versions qv
LEFT JOIN query_schedules qs ON qs.query_version_id = qv.id
WHERE qv.active AND qs.query_version_id IS NULL;

UPDATE query_schedules qs
SET next_run_at = now(), paused = false, updated_at = now()
FROM query_versions qv
WHERE qv.id = qs.query_version_id
  AND qv.active
  AND (qs.paused OR qs.next_run_at IS NULL);
