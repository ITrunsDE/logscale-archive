/**
 * Approximate Falcon LogScale REST paths used by {@link LogScaleClient}:
 * POST   /api/v1/repositories/{repo}/queryjobs
 * GET    /api/v1/repositories/{repo}/queryjobs/{id}
 * GET    /api/v1/repositories/{repo}/queryjobs/{id}?paginationOffset=&paginationLimit=
 * DELETE /api/v1/repositories/{repo}/queryjobs/{id}
 * GET    /api/v1/status
 * GET    /api/v1/repositories/{repo}
 * GET    /api/v1/self
 */

export type FetchFn = typeof fetch;

export type LogScaleClientConfig = {
  endpoint: string;
  repository: string;
  token: string;
  fetch?: FetchFn;
  timeoutMs?: number;
  maxRetries?: number;
};

export type CreateQueryJobInput = {
  query: string;
  start: string;
  end: string;
};

export type QueryJobStatusValue = "running" | "done" | "failed" | "cancelled";

export type QueryJob = {
  id: string;
  status: QueryJobStatusValue;
};

export type QueryJobStatus = {
  id: string;
  status: QueryJobStatusValue;
  error?: string;
  warnings?: string[];
};

export type ResultPage = {
  events: unknown[];
  offset: number;
  limit: number;
  total: number;
  done: boolean;
};

export type ConnectionValidation = {
  ok: boolean;
  serverVersion?: string;
  repositoryAccessible: boolean;
  permissionWarnings: string[];
  tokenExpiresAt?: string;
  error?: string;
};

export type ValidateConnectionInput = {
  endpoint: string;
  repository: string;
  token: string;
  fetch?: FetchFn;
  timeoutMs?: number;
};
