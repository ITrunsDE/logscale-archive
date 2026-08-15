ALTER TABLE query_runs DROP CONSTRAINT query_runs_status_check;
ALTER TABLE query_runs ADD CONSTRAINT query_runs_status_check
  CHECK (status IN ('pending', 'running', 'complete', 'failed', 'split', 'cancelled'));
