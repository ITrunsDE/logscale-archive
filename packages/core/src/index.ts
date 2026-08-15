export { migrateDatabase } from "./db/migrate.js";
export { createDatabase, reconnectDatabase, type Database } from "./db/repositories.js";
export {
  tables,
  EVENT_IDENTITY_UNIQUE,
  AGGREGATE_IDENTITY_UNIQUE,
  type TableName,
} from "./db/schema.js";
export { hashPassword, verifyPassword } from "./auth/passwords.js";
export {
  getPasswordPolicy,
  updatePasswordPolicy,
  validatePassword,
  PASSWORD_MIN_HARD,
  type PasswordPolicy,
} from "./auth/policy.js";
export {
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessions,
  revokeUserSessions,
  revokeUserSessionsExcept,
  validateCsrf,
  encodeSessionCookie,
  decodeSessionCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type ActiveSession,
  type SessionUser,
} from "./auth/sessions.js";
export {
  countUsers,
  createUser,
  findUserById,
  findUserByUsername,
  listUsers,
  toPublicUser,
  updateUserPassword,
  upsertRecoveryAdmin,
  type PublicUser,
  type UserRole,
} from "./auth/users.js";
export { generateCompliantPassword } from "./auth/generatePassword.js";
export { createRecoveryAdmin } from "./auth/recovery.js";
export {
  writeAuditEntry,
  listAuditEntries,
  sanitizeAuditMetadata,
  type AuditEntry,
  type AuditEntryInput,
  type ListAuditEntriesInput,
} from "./audit/writeAuditEntry.js";
export {
  ENCRYPTION_KEY_BYTES,
  ENCRYPTION_KEY_ID,
  ENCRYPTION_VERSION,
  decryptSecret,
  encryptSecret,
  encryptedSecretFromBytes,
  encryptedSecretToBytes,
  parseEncryptionKeyHex,
  type EncryptedSecret,
} from "./security/encryption.js";
export { LogScaleClient, sanitizeErrorMessage } from "./logscale/client.js";
export { validateConnection } from "./logscale/validateToken.js";
export type {
  ConnectionValidation,
  CreateQueryJobInput,
  FetchFn,
  LogScaleClientConfig,
  QueryJob,
  QueryJobStatus,
  QueryJobStatusValue,
  ResultPage,
  ValidateConnectionInput,
} from "./logscale/types.js";
export {
  validateQueryText,
  validateEventResults,
  validateAggregateResults,
  type QueryMode,
  type QueryValidation,
} from "./queries/validateQuery.js";
export {
  activateQueryVersion,
  createQueryDraft,
  deactivateQueryVersion,
  listQueryVersions,
  testQueryVersion,
  type CreateQueryDraftInput,
  type QueryTestResult,
  type QueryVersion,
  type QueryVersionsDeps,
  type SampleWindow,
} from "./queries/queryVersions.js";
export {
  claimNextRun,
  getQueryRun,
  type ClaimNextRunOptions,
  type QueryRun,
  type QueryRunKind,
  type QueryRunStatus,
} from "./jobs/leases.js";
export {
  parseQueryJobWarnings,
  hasResultCapWarning,
  formatFailureMetadata,
} from "./logscale/warnings.js";
export {
  archiveAggregateWindow,
  storeAggregateSnapshot,
  type AggregateArchiveDeps,
  type AggregateArchiveOutcome,
  type AggregateSnapshotInput,
  type AggregateWindow,
  type SnapshotRevision,
} from "./results/aggregates.js";
export {
  archiveEventWindow,
  type ArchiveOutcome,
  type ArchiveWindow,
  type EventArchiveDeps,
  type EventArchiveHooks,
} from "./results/events.js";
export {
  searchStoredResults,
  searchAllStoredResults,
  createExport,
  listExports,
  getExport,
  canDownloadExport,
  claimNextExport,
  runExportJob,
  expireExports,
  listSearchableQueryVersions,
  exportRoot,
  exportFilePath,
  pathsIncludedInBackup,
  isExportPath,
  type SearchActor,
  type JsonFieldFilter,
  type StoredResultFilters,
  type StoredResultRow,
  type PaginatedResults,
  type ExportFormat,
  type CreateExportRequest,
  type ExportJob,
} from "./search/storedResults.js";
export {
  createBackup,
  restoreBackup,
  listBackupRuns,
  getBackupRun,
  getLatestCompleteBackup,
  enterMaintenanceMode,
  exitMaintenanceMode,
  getMaintenanceState,
  isMaintenanceMode,
  assertRecentBackupBeforeMigration,
  getJobStats,
  listAppliedMigrations,
  checkDatabaseHealth,
  checkWorkerHealth,
  type BackupRun,
  type BackupRunStatus,
  type RestoreOutcome,
  type RestoreInput,
  type MaintenanceState,
  type JobStats,
  type BackupDeps,
} from "./maintenance.js";
export const PACKAGE_NAME = "@archive/core";
