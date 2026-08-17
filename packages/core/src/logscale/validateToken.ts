import type { ConnectionValidation, FetchFn, ValidateConnectionInput } from "./types.js";
import { sanitizeErrorMessage, stripTrailingSlashes } from "./client.js";

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
  const baseUrl = stripTrailingSlashes(input.endpoint);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const permissionWarnings: string[] = [];
  let serverVersion: string | undefined;
  let repositoryAccessible = false;
  let tokenExpiresAt: string | undefined;

  try {
    // ponytail: /api/v1/status is the documented health endpoint; /version 404s or returns HTML behind SPA prefixes
    const versionResponse = await timedFetch(
      fetchImpl,
      `${baseUrl}/api/v1/status`,
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
    const contentType = versionResponse.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      return {
        ok: false,
        repositoryAccessible: false,
        permissionWarnings,
        error:
          "Endpoint returned HTML instead of JSON — use the LogScale API base URL without /humio or /logscale",
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

    const repoContentType = repoResponse.headers.get("content-type") ?? "";
    if (!repoContentType.includes("json")) {
      return {
        ok: false,
        serverVersion,
        repositoryAccessible: false,
        permissionWarnings,
        error: "Repository response was not JSON",
      };
    }

    let repoBody: { name?: string };
    try {
      repoBody = (await repoResponse.json()) as { name?: string };
    } catch {
      return {
        ok: false,
        serverVersion,
        repositoryAccessible: false,
        permissionWarnings,
        error: "Repository response was not valid JSON",
      };
    }
    const returnedName = repoBody.name?.trim();
    const expectedName = input.repository.trim();
    // ponytail: require body.name === configured repo so a 200 for wrong/proxy path cannot pass
    if (!returnedName || returnedName !== expectedName) {
      return {
        ok: false,
        serverVersion,
        repositoryAccessible: false,
        permissionWarnings,
        error: returnedName
          ? `Repository name mismatch: expected "${expectedName}", got "${returnedName}"`
          : "Repository response did not include a matching name",
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
