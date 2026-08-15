import type { ConnectionValidation, FetchFn, ValidateConnectionInput } from "./types.js";
import { sanitizeErrorMessage } from "./client.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const READ_PERMISSIONS = new Set([
  "read",
  "readdata",
  "read-data",
  "data-read",
  "search",
  "query",
]);

export async function validateConnection(
  input: ValidateConnectionInput,
): Promise<ConnectionValidation> {
  const fetchImpl = input.fetch ?? fetch;
  const baseUrl = input.endpoint.replace(/\/+$/, "");
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const permissionWarnings: string[] = [];
  let serverVersion: string | undefined;
  let repositoryAccessible = false;
  let tokenExpiresAt: string | undefined;

  try {
    const versionResponse = await timedFetch(
      fetchImpl,
      `${baseUrl}/api/v1/version`,
      input.token,
      timeoutMs,
    );
    if (!versionResponse.ok) {
      return {
        ok: false,
        repositoryAccessible: false,
        permissionWarnings,
        error: await errorFromResponse(versionResponse, input.token),
      };
    }
    const versionBody = (await versionResponse.json()) as { version?: string; build?: string };
    serverVersion = versionBody.version ?? versionBody.build ?? "unknown";

    const repoResponse = await timedFetch(
      fetchImpl,
      `${baseUrl}/api/v1/repositories/${encodeURIComponent(input.repository)}`,
      input.token,
      timeoutMs,
    );
    if (repoResponse.status === 401 || repoResponse.status === 403 || repoResponse.status === 404) {
      return {
        ok: false,
        serverVersion,
        repositoryAccessible: false,
        permissionWarnings,
        error: "Repository is not accessible with this token",
      };
    }
    if (!repoResponse.ok) {
      return {
        ok: false,
        serverVersion,
        repositoryAccessible: false,
        permissionWarnings,
        error: await errorFromResponse(repoResponse, input.token),
      };
    }
    repositoryAccessible = true;

    const selfResponse = await timedFetch(fetchImpl, `${baseUrl}/api/v1/self`, input.token, timeoutMs);
    if (selfResponse.ok) {
      const selfBody = (await selfResponse.json()) as {
        permissions?: string[];
        scopes?: string[];
        expiresAt?: string;
        expiry?: string;
      };
      tokenExpiresAt = selfBody.expiresAt ?? selfBody.expiry;
      const permissions = [...(selfBody.permissions ?? []), ...(selfBody.scopes ?? [])];
      for (const permission of permissions) {
        const normalized = permission.toLowerCase();
        if (READ_PERMISSIONS.has(normalized)) {
          continue;
        }
        if (normalized.includes("read") && !normalized.includes("write")) {
          continue;
        }
        permissionWarnings.push(`Token grants non read-only permission: ${permission}`);
      }
    }

    return {
      ok: permissionWarnings.length === 0,
      serverVersion,
      repositoryAccessible,
      permissionWarnings,
      ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      serverVersion,
      repositoryAccessible,
      permissionWarnings,
      error: error instanceof Error ? sanitizeErrorMessage(error.message, input.token) : "Validation failed",
    };
  }
}

async function timedFetch(
  fetchImpl: FetchFn,
  url: string,
  token: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("LogScale validation request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function errorFromResponse(response: Response, token: string): Promise<string> {
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
