import { describe, expect, it, vi } from "vitest";
import { validateConnection } from "@archive/core";

const TOKEN = "validate-token-123";

describe("validateConnection", () => {
  it("returns server version and repository access for read-only tokens", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/status")) {
        return new Response(JSON.stringify({ version: "1.200.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/repositories/repo-a")) {
        return new Response(JSON.stringify({ name: "repo-a" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/self")) {
        return new Response(JSON.stringify({ permissions: ["read"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "missing" }), { status: 404 });
    });

    const result = await validateConnection({
      endpoint: "https://logscale.example",
      repository: "repo-a",
      token: TOKEN,
      fetch: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({
      ok: true,
      serverVersion: "1.200.0",
      repositoryAccessible: true,
      permissionWarnings: [],
    });
  });

  it("rejects when repository body name does not match", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/status")) {
        return new Response(JSON.stringify({ version: "1.200.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/repositories/repo-a")) {
        return new Response(JSON.stringify({ name: "other-repo" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "missing" }), { status: 404 });
    });

    const result = await validateConnection({
      endpoint: "https://logscale.example",
      repository: "repo-a",
      token: TOKEN,
      fetch: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({
      ok: false,
      repositoryAccessible: false,
      error: 'Repository name mismatch: expected "repo-a", got "other-repo"',
    });
  });
});
