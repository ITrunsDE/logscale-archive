/** Table and constraint names used by the archive schema. */
export const tables = [
  "users",
  "sessions",
  "password_policy",
  "logscale_connections",
  "query_versions",
  "query_schedules",
  "query_runs",
  "backfill_windows",
  "event_records",
  "aggregate_snapshots",
  "audit_entries",
  "exports",
  "backup_runs",
  "retention_holds",
] as const;

export type TableName = (typeof tables)[number];

export const EVENT_IDENTITY_UNIQUE = "event_identity";
export const AGGREGATE_IDENTITY_UNIQUE = "aggregate_identity";
