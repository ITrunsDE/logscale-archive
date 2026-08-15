-- 0001_initial.sql — durable archive metadata and immutable JSONB payloads

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE password_policy (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  min_length INT NOT NULL DEFAULT 14 CHECK (min_length >= 12),
  require_upper BOOLEAN NOT NULL DEFAULT false,
  require_lower BOOLEAN NOT NULL DEFAULT false,
  require_digit BOOLEAN NOT NULL DEFAULT false,
  require_symbol BOOLEAN NOT NULL DEFAULT false,
  history_count INT NOT NULL DEFAULT 0 CHECK (history_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO password_policy (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE logscale_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  repository TEXT NOT NULL,
  token_ciphertext BYTEA NOT NULL,
  token_key_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (endpoint, repository)
);

CREATE TABLE query_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES logscale_connections(id),
  name TEXT NOT NULL,
  version_number INT NOT NULL,
  query_text TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('event', 'aggregate')),
  schedule_cron TEXT,
  schedule_timezone TEXT NOT NULL DEFAULT 'UTC',
  initial_start_at TIMESTAMPTZ NOT NULL,
  correction_window_seconds INT NOT NULL DEFAULT 0,
  retention_days INT,
  active BOOLEAN NOT NULL DEFAULT false,
  test_passed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, name, version_number)
);

CREATE INDEX query_versions_active_idx ON query_versions(active);

CREATE TABLE query_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_version_id UUID NOT NULL UNIQUE REFERENCES query_versions(id),
  next_run_at TIMESTAMPTZ,
  watermark_at TIMESTAMPTZ,
  paused BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE query_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_version_id UUID NOT NULL REFERENCES query_versions(id),
  kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'backfill', 'test')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed', 'split', 'cancelled')),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  parent_run_id UUID REFERENCES query_runs(id),
  failure_reason TEXT,
  result_count BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (window_end > window_start)
);

CREATE INDEX query_runs_status_idx ON query_runs(status);
CREATE INDEX query_runs_query_version_id_idx ON query_runs(query_version_id);
CREATE INDEX query_runs_window_idx ON query_runs(query_version_id, window_start, window_end);

CREATE TABLE backfill_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_version_id UUID NOT NULL REFERENCES query_versions(id),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed', 'paused')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (window_end > window_start)
);

CREATE INDEX backfill_windows_status_idx ON backfill_windows(status);

CREATE TABLE event_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_version_id UUID NOT NULL REFERENCES query_versions(id),
  query_run_id UUID NOT NULL REFERENCES query_runs(id),
  source_repo TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  event_timestamp TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_identity UNIQUE (query_version_id, source_repo, source_event_id)
);

CREATE INDEX event_records_event_timestamp_idx ON event_records(event_timestamp);
CREATE INDEX event_records_query_version_id_idx ON event_records(query_version_id);

CREATE TABLE aggregate_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_version_id UUID NOT NULL REFERENCES query_versions(id),
  query_run_id UUID NOT NULL REFERENCES query_runs(id),
  repository TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  dimensions JSONB NOT NULL,
  dimensions_hash TEXT NOT NULL,
  revision INT NOT NULL DEFAULT 1,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT aggregate_identity UNIQUE (query_version_id, repository, window_start, window_end, dimensions_hash, revision),
  CHECK (window_end > window_start)
);

CREATE INDEX aggregate_snapshots_window_idx ON aggregate_snapshots(query_version_id, window_start, window_end);

CREATE TABLE audit_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  ip INET,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_entries_created_at_idx ON audit_entries(created_at);
CREATE INDEX audit_entries_actor_user_id_idx ON audit_entries(actor_user_id);

CREATE TABLE exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  query_version_id UUID REFERENCES query_versions(id),
  format TEXT NOT NULL CHECK (format IN ('csv', 'ndjson')),
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed', 'expired')),
  file_path TEXT,
  result_count BIGINT,
  error_message TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX exports_status_idx ON exports(status);
CREATE INDEX exports_expires_at_idx ON exports(expires_at);

CREATE TABLE backup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  file_path TEXT,
  checksum TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE retention_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_version_id UUID NOT NULL UNIQUE REFERENCES query_versions(id),
  reason TEXT NOT NULL,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
