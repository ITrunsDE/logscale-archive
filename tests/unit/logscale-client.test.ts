import { afterEach, describe, expect, it, vi } from "vitest";
import { LogScaleClient, sanitizeErrorMessage } from "@archive/core";

const ENDPOINT = "https://logscale.example";
const REPO = "repo-a";
const TOKEN = "test-bearer-token-abc123";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("LogScaleClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends bearer token auth on requests", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
      expect(String(url)).toContain("/queryjobs");
      return jsonResponse({ id: "job-1", state: "running" });
    });

    const client = new LogScaleClient({
      endpoint: ENDPOINT,
      repository: REPO,
      token: TOKEN,
      fetch: fetchMock,
    });

    const job = await client.createQueryJob({
      query: "#repo=repo-a",
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-01T01:00:00Z",
    });

    expect(job).toEqual({ id: "job-1", status: "running" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("polls until a query job completes", async () => {
    let pollCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/queryjobs/job-42")) {
        pollCount += 1;
        return jsonResponse({
          id: "job-42",
          state: pollCount < 2 ? "running" : "done",
        });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const client = new LogScaleClient({
      endpoint: ENDPOINT,
      repository: REPO,
      token: TOKEN,
      fetch: fetchMock,
    });

    const first = await client.pollQueryJob("job-42");
    const second = await client.pollQueryJob("job-42");

    expect(first.status).toBe("running");
    expect(second.status).toBe("done");
  });

  it("retries retryable HTTP errors", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        return jsonResponse({ error: "upstream unavailable" }, 503);
      }
      return jsonResponse({ id: "job-retry", state: "running" });
    });

    const client = new LogScaleClient({
      endpoint: ENDPOINT,
      repository: REPO,
      token: TOKEN,
      fetch: fetchMock,
      maxRetries: 3,
    });

    const job = await client.createQueryJob({
      query: "#repo=repo-a",
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-01T01:00:00Z",
    });

    expect(job.id).toBe("job-retry");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("paginates query job results", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain("offset=100");
      expect(String(url)).toContain("limit=50");
      return jsonResponse({
        events: [{ "@id": "ev-100" }],
        offset: 100,
        limit: 50,
        total: 101,
        done: true,
      });
    });

    const client = new LogScaleClient({
      endpoint: ENDPOINT,
      repository: REPO,
      token: TOKEN,
      fetch: fetchMock,
    });

    const page = await client.getResultPage("job-7", 100, 50);
    expect(page).toEqual({
      events: [{ "@id": "ev-100" }],
      offset: 100,
      limit: 50,
      total: 101,
      done: true,
    });
  });

  it("deletes query jobs during cleanup", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      expect(String(url)).toContain("/queryjobs/job-cleanup");
      return new Response(null, { status: 204 });
    });

    const client = new LogScaleClient({
      endpoint: ENDPOINT,
      repository: REPO,
      token: TOKEN,
      fetch: fetchMock,
    });

    await client.deleteQueryJob("job-cleanup");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("redacts secrets from error messages", () => {
    const message = sanitizeErrorMessage(`Bearer ${TOKEN} failed`, TOKEN);
    expect(message).not.toContain(TOKEN);
    expect(message).toContain("[redacted]");
  });
});
