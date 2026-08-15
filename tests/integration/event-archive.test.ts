import pg from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@archive/config";
import {
  archiveEventWindow,
  claimNextRun,
  createDatabase,
  encryptSecret,
  encryptedSecretToBytes,
  migrateDatabase,
  reclaimOrphanedQueryRuns,
} from "@archive/core";
import { runWorkerTick } from "../../apps/worker/src/main.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://archive:change-me-local-only@127.0.0.1:5432/archive";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_TOKEN = "integration-event-archive-token";

const PAGE_SIZE = 2;

async function resetDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO archive;
      GRANT ALL ON SCHEMA public TO public;
    `);
  } finally {
    await client.end();
  }
}

function applyEnv(): void {
  Object.assign(process.env, {
    APP_ROLE: "worker",
    DATABASE_URL,
    ENCRYPTION_KEY,
    SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
  });
}

function event(id: string, repo = "repo-a") {
  return {
    "@id": id,
    "#repo": repo,
    "@timestamp": "2026-01-01T00:10:00.000Z",
    message: `event-${id}`,
  };
}

let connectionCounter = 0;

async function seedActiveEventQuery(db: ReturnType<typeof createDatabase>) {
  connectionCounter += 1;
  const suffix = connectionCounter;
  const encrypted = encryptSecret(TEST_TOKEN, Buffer.from(ENCRYPTION_KEY, "hex"));
  const connection = await db.query<{ id: string }>(
    `INSERT INTO logscale_connections
       (name, endpoint, repository, token_ciphertext, token_key_id, status)
     VALUES ($1, $2, $3, $4, 'env-v1', 'valid')
     RETURNING id`,
    [
      `Archive-${suffix}`,
      `https://logscale.example/${suffix}`,
      `repo-a-${suffix}`,
      encryptedSecretToBytes(encrypted),
    ],
  );
  const connectionId = connection.rows[0]!.id;

  const version = await db.query<{ id: string }>(
    `INSERT INTO query_versions
       (connection_id, name, version_number, query_text, mode, initial_start_at, active, test_passed_at)
     VALUES ($1, 'events', 1, '#repo=repo-a | tail()', 'event', '2026-01-01T00:00:00.000Z', true, now())
     RETURNING id`,
    [connectionId],
  );
  const queryVersionId = version.rows[0]!.id;

  await db.query(
    `INSERT INTO query_schedules (query_version_id, next_run_at, watermark_at, paused)
     VALUES ($1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', false)`,
    [queryVersionId],
  );

  return { connectionId, queryVersionId, repository: `repo-a-${suffix}` };
}

async function insertPendingRun(
  db: ReturnType<typeof createDatabase>,
  queryVersionId: string,
  kind: "scheduled" | "backfill",
  window: { start: string; end: string },
) {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO query_runs (query_version_id, kind, status, window_start, window_end)
     VALUES ($1, $2, 'pending', $3, $4)
     RETURNING id`,
    [queryVersionId, kind, window.start, window.end],
  );
  return inserted.rows[0]!.id;
}

function mockMultiPageFetch(pages: unknown[][], pageSize = PAGE_SIZE): typeof fetch {
  let jobCounter = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (method === "POST" && url.includes("/queryjobs") && !url.match(/queryjobs\/[^/]+$/)) {
      jobCounter += 1;
      return new Response(JSON.stringify({ id: `job-${jobCounter}`, state: "running" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const jobMatch = url.match(/queryjobs\/(job-\d+)(?:\/|$|\?)/);
    const jobId = jobMatch?.[1] ?? "job-1";

    if (method === "GET" && url.includes(`/queryjobs/${jobId}`) && !url.includes("/results")) {
      return new Response(JSON.stringify({ id: jobId, state: "done" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "GET" && url.includes("/results")) {
      const parsed = new URL(url, "http://local");
      const offset = Number(parsed.searchParams.get("offset") ?? 0);
      const pageIndex = Math.floor(offset / pageSize);
      const pageEvents = pages[pageIndex] ?? [];
      const done = pageIndex >= pages.length - 1;
      const total = pages.reduce((sum, page) => sum + page.length, 0);
      return new Response(
        JSON.stringify({
          events: pageEvents,
          offset,
          limit: pageSize,
          total,
          done,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
}

describe("event archive worker", () => {
  beforeAll(async () => {
    await resetDatabase(DATABASE_URL);
    await migrateDatabase(DATABASE_URL);
  }, 60_000);

  beforeEach(async () => {
    const db = createDatabase(DATABASE_URL);
    await db.query(
      `UPDATE query_runs
       SET status = 'failed', finished_at = COALESCE(finished_at, now())
       WHERE status IN ('running', 'pending')`,
    );
    await db.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores events exactly once across retry and restart", async () => {
    applyEnv();
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedActiveEventQuery(db);
    const runId = await insertPendingRun(db, queryVersionId, "scheduled", {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T01:00:00.000Z",
    });

    const pages = [[event("ev-1"), event("ev-2")], [event("ev-3")]];
    const fetchImpl = mockMultiPageFetch(pages);
    const window = {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T01:00:00.000Z",
    };
    const deps = {
      encryptionKey: config.encryptionKey,
      fetch: fetchImpl,
      pageSize: PAGE_SIZE,
      hooks: {
        afterPagePersisted: async ({ pageIndex }: { pageIndex: number }) => {
          if (pageIndex === 0) {
            throw new Error("worker restart after first page");
          }
        },
      },
    };

    const first = await archiveEventWindow(db, deps, runId, window);
    expect(first.ok).toBe(false);
    expect(first.retryable).toBe(true);

    const midEvents = await db.query(`SELECT source_event_id FROM event_records ORDER BY source_event_id`);
    expect(midEvents.rows.map((row) => row.source_event_id)).toEqual(["ev-1", "ev-2"]);

    const watermarkMid = await db.query<{ watermark_at: Date | null }>(
      `SELECT watermark_at FROM query_schedules WHERE query_version_id = $1`,
      [queryVersionId],
    );
    expect(watermarkMid.rows[0]!.watermark_at!.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    const second = await archiveEventWindow(db, { ...deps, hooks: undefined }, runId, window);
    expect(second.ok).toBe(true);
    expect(second.eventCount).toBe(3);

    const stored = await db.query<{ source_event_id: string }>(
      `SELECT source_event_id FROM event_records ORDER BY source_event_id`,
    );
    expect(stored.rows.map((row) => row.source_event_id)).toEqual(["ev-1", "ev-2", "ev-3"]);

    const watermarkFinal = await db.query<{ watermark_at: Date | null }>(
      `SELECT watermark_at FROM query_schedules WHERE query_version_id = $1`,
      [queryVersionId],
    );
    expect(watermarkFinal.rows[0]!.watermark_at!.toISOString()).toBe(window.end);

    await db.close();
  });

  it("does not allow overlapping runs for the same query version", async () => {
    applyEnv();
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedActiveEventQuery(db);

    await insertPendingRun(db, queryVersionId, "scheduled", {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T01:00:00.000Z",
    });
    await insertPendingRun(db, queryVersionId, "scheduled", {
      start: "2026-01-01T01:00:00.000Z",
      end: "2026-01-01T02:00:00.000Z",
    });

    const first = await claimNextRun(db, "worker-a");
    expect(first).not.toBeNull();

    const second = await claimNextRun(db, "worker-b");
    expect(second).toBeNull();

    await db.close();
  });

  it("reclaims orphaned running runs after worker restart", async () => {
    applyEnv();
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedActiveEventQuery(db);
    await insertPendingRun(db, queryVersionId, "scheduled", {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T01:00:00.000Z",
    });

    const claimed = await claimNextRun(db, "worker-old");
    expect(claimed?.status).toBe("running");

    // Simulate SIGKILL: status stays running, nothing else claims.
    expect(await claimNextRun(db, "worker-new")).toBeNull();

    const bootAt = new Date();
    const reclaimed = await reclaimOrphanedQueryRuns(db, bootAt);
    expect(reclaimed).toBe(1);

    const fetchImpl = mockMultiPageFetch([[event("orphan-1")]]);
    const worked = await runWorkerTick(
      db,
      {
        encryptionKey: config.encryptionKey,
        fetch: fetchImpl,
        bootAt,
        backup: {
          dumpDatabase: async (_url, filePath) => {
            await import("node:fs/promises").then((fs) => fs.writeFile(filePath, "-- test dump\n"));
          },
        },
      },
      "worker-new",
    );
    expect(worked).toBe(true);

    const status = await db.query<{ status: string }>(
      `SELECT status FROM query_runs WHERE id = $1`,
      [claimed!.id],
    );
    expect(status.rows[0]?.status).toBe("complete");

    await db.close();
  });

  it("prioritizes scheduled runs over backfill", async () => {
    applyEnv();
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedActiveEventQuery(db);

    const backfillId = await insertPendingRun(db, queryVersionId, "backfill", {
      start: "2025-12-01T00:00:00.000Z",
      end: "2025-12-01T01:00:00.000Z",
    });
    const scheduledId = await insertPendingRun(db, queryVersionId, "scheduled", {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T01:00:00.000Z",
    });

    await db.query(`UPDATE query_runs SET created_at = now() - interval '1 hour' WHERE id = $1`, [
      backfillId,
    ]);

    const claimed = await claimNextRun(db, "worker-priority");
    expect(claimed?.id).toBe(scheduledId);
    expect(claimed?.kind).toBe("scheduled");

    await db.close();
  });

  it("leaves watermark unchanged when page persistence fails", async () => {
    applyEnv();
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedActiveEventQuery(db);
    const runId = await insertPendingRun(db, queryVersionId, "scheduled", {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T01:00:00.000Z",
    });

    const fetchImpl = mockMultiPageFetch([[event("ev-1"), event("ev-2")]]);
    const outcome = await archiveEventWindow(
      db,
      {
        encryptionKey: config.encryptionKey,
        fetch: fetchImpl,
        pageSize: PAGE_SIZE,
        hooks: {
          beforePageInsert: async () => {
            throw new Error("injected db failure");
          },
        },
      },
      runId,
      {
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-01T01:00:00.000Z",
      },
    );

    expect(outcome.ok).toBe(false);

    const events = await db.query(`SELECT 1 FROM event_records WHERE query_run_id = $1`, [runId]);
    expect(events.rows).toHaveLength(0);

    const watermark = await db.query<{ watermark_at: Date | null }>(
      `SELECT watermark_at FROM query_schedules WHERE query_version_id = $1`,
      [queryVersionId],
    );
    expect(watermark.rows[0]!.watermark_at!.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    await db.close();
  });

  it("completes multi-page archive after worker restart between pages", async () => {
    applyEnv();
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedActiveEventQuery(db);
    const runId = await insertPendingRun(db, queryVersionId, "scheduled", {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T01:00:00.000Z",
    });

    const pages = [[event("ev-a"), event("ev-b")], [event("ev-c"), event("ev-d")], [event("ev-e")]];
    const fetchImpl = mockMultiPageFetch(pages);
    const window = {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T01:00:00.000Z",
    };

    let restartAfterFirstPage = true;
    const partial = await archiveEventWindow(
      db,
      {
        encryptionKey: config.encryptionKey,
        fetch: fetchImpl,
        pageSize: PAGE_SIZE,
        hooks: {
          afterPagePersisted: async ({ pageIndex }: { pageIndex: number }) => {
            if (pageIndex === 0 && restartAfterFirstPage) {
              restartAfterFirstPage = false;
              throw new Error("simulated worker exit after page one");
            }
          },
        },
      },
      runId,
      window,
    );
    expect(partial.ok).toBe(false);

    await claimNextRun(db, "worker-restart");
    const completed = await archiveEventWindow(
      db,
      {
        encryptionKey: config.encryptionKey,
        fetch: fetchImpl,
        pageSize: PAGE_SIZE,
      },
      runId,
      window,
    );
    expect(completed.ok).toBe(true);
    expect(completed.eventCount).toBe(5);

    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_entries
       WHERE action = 'event_archive.complete' AND metadata->>'runId' = $1`,
      [runId],
    );
    expect(audit.rows).toHaveLength(1);

    await db.close();
  });

  it("runs archive through the worker tick loop with mocked pages", async () => {
    applyEnv();
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedActiveEventQuery(db);
    await insertPendingRun(db, queryVersionId, "scheduled", {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T01:00:00.000Z",
    });

    const fetchImpl = mockMultiPageFetch([[event("tick-1"), event("tick-2")], [event("tick-3")]]);
    const worked = await runWorkerTick(
      db,
      {
        encryptionKey: config.encryptionKey,
        fetch: fetchImpl,
        backup: {
          dumpDatabase: async (_url, filePath) => {
            await import("node:fs/promises").then((fs) => fs.writeFile(filePath, "-- test dump\n"));
          },
        },
      },
      "worker-tick",
    );
    expect(worked).toBe(true);

    const run = await db.query<{ status: string; result_count: string }>(
      `SELECT status, result_count FROM query_runs WHERE query_version_id = $1`,
      [queryVersionId],
    );
    expect(run.rows[0]).toMatchObject({ status: "complete", result_count: "3" });

    await db.close();
  });
});
