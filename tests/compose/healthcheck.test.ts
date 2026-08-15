import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_URL = process.env.ARCHIVE_WEB_URL ?? "http://127.0.0.1:8080/healthz";
const COMPOSE_FILE = resolve(process.cwd(), "infra/compose.yaml");

async function waitForHealthz(url: string, timeoutMs = 60_000): Promise<Response> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

describe("compose stack", () => {
  it("binds web to localhost and does not publish postgres", () => {
    const compose = readFileSync(COMPOSE_FILE, "utf8");
    expect(compose).toMatch(/127\.0\.0\.1:8080:8080/);

    const postgresBlock = compose.split(/\n {2}postgres:/)[1]?.split(/\n {2}[a-z]/)[0] ?? "";
    expect(postgresBlock.length).toBeGreaterThan(0);
    expect(postgresBlock).not.toMatch(/ports:/);
    expect(postgresBlock).not.toMatch(/5432/);
  });

  it("serves /healthz from the web process", async () => {
    if (process.env.ARCHIVE_LIVE !== "1") {
      return;
    }
    const response = await waitForHealthz(WEB_URL);
    const body = (await response.json()) as { ok: boolean; role: string };
    expect(body.ok).toBe(true);
    expect(body.role).toBe("web");
  }, 90_000);
});
