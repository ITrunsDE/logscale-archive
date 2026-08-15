import type {
  CreateQueryJobInput,
  FetchFn,
  LogScaleClientConfig,
  QueryJob,
  QueryJobStatus,
  ResultPage,
} from "./types.js";
import { parseQueryJobWarnings } from "./warnings.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export class LogScaleClient {
  private readonly baseUrl: string;
  private readonly repository: string;
  private readonly token: string;
  private readonly fetchImpl: FetchFn;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: LogScaleClientConfig) {
    this.baseUrl = config.endpoint.replace(/\/+$/, "");
    this.repository = config.repository;
    this.token = config.token;
    this.fetchImpl = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async createQueryJob(input: CreateQueryJobInput): Promise<QueryJob> {
    const response = await this.request(
      "POST",
      `/api/v1/repositories/${encodeURIComponent(this.repository)}/queryjobs`,
      {
        queryString: input.query,
        start: input.start,
        end: input.end,
        isLive: false,
      },
    );
    const body = (await response.json()) as { id?: string; jobId?: string; state?: string };
    const id = body.id ?? body.jobId;
    if (!id) {
      throw new Error("LogScale query job response missing id");
    }
    return { id, status: parseJobStatus(body.state) ?? "running" };
  }

  async pollQueryJob(id: string): Promise<QueryJobStatus> {
    const response = await this.request(
      "GET",
      `/api/v1/repositories/${encodeURIComponent(this.repository)}/queryjobs/${encodeURIComponent(id)}`,
    );
    const body = (await response.json()) as Record<string, unknown> & {
      id?: string;
      jobId?: string;
      state?: string;
      status?: string;
      error?: string;
      message?: string;
    };
    const status = parseJobStatus(body.state ?? body.status) ?? "running";
    const error = body.error ?? body.message;
    const warnings = parseQueryJobWarnings(body);
    return {
      id: body.id ?? body.jobId ?? id,
      status,
      ...(error ? { error: sanitizeErrorMessage(String(error), this.token) } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async getResultPage(id: string, offset: number, limit: number): Promise<ResultPage> {
    const path =
      `/api/v1/repositories/${encodeURIComponent(this.repository)}/queryjobs/${encodeURIComponent(id)}/results` +
      `?offset=${encodeURIComponent(String(offset))}&limit=${encodeURIComponent(String(limit))}`;
    const response = await this.request("GET", path);
    const body = (await response.json()) as {
      events?: unknown[];
      results?: unknown[];
      offset?: number;
      limit?: number;
      total?: number;
      done?: boolean;
      hasMore?: boolean;
    };
    const events = body.events ?? body.results ?? [];
    const total = body.total ?? offset + events.length;
    const done =
      body.done ?? (body.hasMore !== undefined ? !body.hasMore : events.length < limit);
    return {
      events,
      offset: body.offset ?? offset,
      limit: body.limit ?? limit,
      total,
      done,
    };
  }

  async deleteQueryJob(id: string): Promise<void> {
    await this.request(
      "DELETE",
      `/api/v1/repositories/${encodeURIComponent(this.repository)}/queryjobs/${encodeURIComponent(id)}`,
    );
  }

  private async request(method: string, path: string, payload?: unknown): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/json",
            ...(payload ? { "content-type": "application/json" } : {}),
          },
          body: payload ? JSON.stringify(payload) : undefined,
          signal: controller.signal,
        });

        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
          await sleep(50 * 2 ** attempt);
          continue;
        }

        if (!response.ok) {
          const message = await readErrorMessage(response, this.token);
          throw new Error(message);
        }

        return response;
      } catch (error) {
        lastError = toRequestError(error, this.token);
        if (attempt < this.maxRetries && isRetryableError(error)) {
          await sleep(50 * 2 ** attempt);
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new Error("LogScale request failed");
  }
}

function parseJobStatus(value: string | undefined): QueryJobStatus["status"] | undefined {
  switch (value?.toLowerCase()) {
    case "running":
    case "working":
    case "queued":
      return "running";
    case "done":
    case "completed":
    case "complete":
      return "done";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return undefined;
  }
}

async function readErrorMessage(response: Response, token: string): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `LogScale request failed with status ${response.status}`;
  }
  try {
    const body = JSON.parse(text) as { error?: string; message?: string };
    return sanitizeErrorMessage(body.error ?? body.message ?? text, token);
  } catch {
    return sanitizeErrorMessage(text, token);
  }
}

export function sanitizeErrorMessage(message: string, token: string): string {
  let sanitized = message;
  if (token) {
    sanitized = sanitized.split(token).join("[redacted]");
  }
  sanitized = sanitized.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return sanitized.slice(0, 500);
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || /status 429|status 502|status 503|status 504/.test(error.message);
}

function toRequestError(error: unknown, token: string): Error {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return new Error("LogScale request timed out");
    }
    return new Error(sanitizeErrorMessage(error.message, token));
  }
  return new Error("LogScale request failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
