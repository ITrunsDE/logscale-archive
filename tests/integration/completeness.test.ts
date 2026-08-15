import pg from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@archive/config";
import {
  archiveAggregateWindow,
  archiveEventWindow,
  createDatabase,
  encryptSecret,
  encryptedSecretToBytes,
  migrateDatabase,
  storeAggregateSnapshot,
} from "@archive/core";
import { splitWindow } from "../../apps/worker/src/windowSplitter.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://archive:change-me-local-only@127.0.0.1:5432/archive";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_TOKEN = "integration-completeness-token";
const PAGE_SIZE = 2;
const RESULT_CAP_WARNING = "Result limit reached; results may be truncated";

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

function event(id: string, repo = "repo-a", timestamp = "2026-01-01T00:10:00.000Z") {
  return {
    "@id": id,
    "#repo": repo,
    "@timestamp": timestamp,
    message: `event-${id}`,
  };
}

function aggregateRow(timestamp: string, count: number) {
  return { _time: timestamp, count };
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
      `Complete-${suffix}`,
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

  return { queryVersionId, repository: `repo-a-${suffix}` };
}

async function seedActiveAggregateQuery(db: ReturnType<typeof createDatabase>) {
  connectionCounter += 1;
  const suffix = connectionCounter;
  const encrypted = encryptSecret(TEST_TOKEN, Buffer.from(ENCRYPTION_KEY, "hex"));
  const connection = await db.query<{ id: string; repository: string }>(
    `INSERT INTO logscale_connections
       (name, endpoint, repository, token_ciphertext, token_key_id, status)
     VALUES ($1, $2, $3, $4, 'env-v1', 'valid')
     RETURNING id, repository`,
    [
      `Agg-${suffix}`,
      `https://logscale.example/${suffix}`,
      `repo-agg-${suffix}`,
      encryptedSecretToBytes(encrypted),
    ],
  );
  const connectionId = connection.rows[0]!.id;
  const repository = connection.rows[0]!.repository;

  const version = await db.query<{ id: string }>(
    `INSERT INTO query_versions
       (connection_id, name, version_number, query_text, mode, initial_start_at, active, test_passed_at)
     VALUES ($1, 'counts', 1, '#repo=repo-agg | timeChart(span=1h)', 'aggregate', '2026-01-01T00:00:00.000Z', true, now())
     RETURNING id`,
    [connectionId],
  );
  const queryVersionId = version.rows[0]!.id;

  await db.query(
    `INSERT INTO query_schedules (query_version_id, next_run_at, watermark_at, paused)
     VALUES ($1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', false)`,
    [queryVersionId],
  );

  return { queryVersionId, repository };
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

type MockJob = {
  warnings?: string[];
  pages?: unknown[][];
};

function mockFetch(jobs: MockJob[], pageSize = PAGE_SIZE): typeof fetch {
  let jobCounter = 0;
  const jobConfigs = new Map<string, MockJob>();

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (method === "POST" && url.includes("/queryjobs") && !url.match(/queryjobs\/[^/]+$/)) {
      jobCounter += 1;
      const jobId = `job-${jobCounter}`;
      jobConfigs.set(jobId, jobs[jobCounter - 1] ?? { pages: [] });
      return new Response(JSON.stringify({ id: jobId, state: "running" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const jobMatch = url.match(/queryjobs\/(job-\d+)(?:\/|$|\?)/);
    const jobId = jobMatch?.[1] ?? "job-1";
    const config = jobConfigs.get(jobId) ?? { pages: [] };

    if (method === "GET" && url.includes(`/queryjobs/${jobId}`) && !url.includes("/results")) {
      return new Response(
        JSON.stringify({
          id: jobId,
          state: "done",
          ...(config.warnings ? { warnings: config.warnings } : {}),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (method === "GET" && url.includes("/results")) {
      const parsed = new URL(url, "http://local");
      const offset = Number(parsed.searchParams.get("offset") ?? 0);
      const pages = config.pages ?? [];
      const pageIndex = Math.floor(offset / pageSize);
      const pageEvents = pages[pageIndex] ?? [];
      const done = pageIndex >= pages.length - 1;
      const total = pages.reduce((sum, page) => sum + page.length, 0);
      return new Response(
        JSON.stringify({ events: pageEvents, offset, limit: pageSize, total, done }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
}

describe("completeness limits and aggregate snapshots", () => {
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

  it("splits event windows on result-cap warning and defers watermark until children complete", async () => {
    applyEnv();
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedActiveEventQuery(db);

    const parentWindow = {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T02:00:00.000Z",
    };
    const [left, right] = splitWindow(parentWindow);
    const parentRunId = await insertPendingRun(db, queryVersionId, "scheduled", parentWindow);

    const fetchImpl = mockFetch([
      { warnings: [RESULT_CAP_WARNING] },
      { pages: [[event("left-1"), event("left-2")]] },
      { pages: [[event("right-1")]] },
    ]);

    const splitOutcome = await archiveEventWindow(
      db,
      {
        encryptionKey: config.encryptionKey,
        fetch: fetchImpl,
        pageSize: PAGE_SIZE,
        splitWindow,
        minWindowDurationMs: 60_000,
      },
      parentRunId,
      parentWindow,
    );
    expect(splitOutcome.split).toBe(true);

    const parent = await db.query<{ status: string; failure_reason: string | null }>(
      `SELECT status, failure_reason FROM query_runs WHERE id = $1`,
      [parentRunId],
    );
    expect(parent.rows[0]).toMatchObject({
      status: "split",
      failure_reason: expect.stringContaining("result_cap"),
    });

    const children = await db.query<{ id: string; window_start: Date; window_end: Date }>(
      `SELECT id, window_start, window_end FROM query_runs
       WHERE parent_run_id = $1 ORDER BY window_start`,
      [parentRunId],
    );
    expect(children.rows).toHaveLength(2);
    expect(children.rows[0]!.window_start.toISOString()).toBe(left.start);
    expect(children.rows[0]!.window_end.toISOString()).toBe(left.end);
    expect(children.rows[1]!.window_start.toISOString()).toBe(right.start);
    expect(children.rows[1]!.window_end.toISOString()).toBe(right.end);

    const watermarkAfterSplit = await db.query<{ watermark_at: Date }>(
      `SELECT watermark_at FROM query_schedules WHERE query_version_id = $1`,
      [queryVersionId],
    );
    expect(watermarkAfterSplit.rows[0]!.watermark_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    const leftRunId = children.rows[0]!.id;
    const leftOutcome = await archiveEventWindow(
      db,
      {
        encryptionKey: config.encryptionKey,
        fetch: fetchImpl,
        pageSize: PAGE_SIZE,
        splitWindow,
        minWindowDurationMs: 60_000,
      },
      leftRunId,
      left,
    );
    expect(leftOutcome.ok).toBe(true);

    const watermarkAfterLeft = await db.query<{ watermark_at: Date }>(
      `SELECT watermark_at FROM query_schedules WHERE query_version_id = $1`,
      [queryVersionId],
    );
    expect(watermarkAfterLeft.rows[0]!.watermark_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    const rightRunId = children.rows[1]!.id;
    const rightOutcome = await archiveEventWindow(
      db,
      {
        encryptionKey: config.encryptionKey,
        fetch: fetchImpl,
        pageSize: PAGE_SIZE,
        splitWindow,
        minWindowDurationMs: 60_000,
      },
      rightRunId,
      right,
    );
    expect(rightOutcome.ok).toBe(true);

    const watermarkFinal = await db.query<{ watermark_at: Date }>(
      `SELECT watermark_at FROM query_schedules WHERE query_version_id = $1`,
      [queryVersionId],
    );
    expect(watermarkFinal.rows[0]!.watermark_at.toISOString()).toBe(parentWindow.end);

    await db.close();
  });

  it("splits when LogScale returns more events than page limit with matching total (silent 200-cap)", async () => {
    applyEnv();
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedActiveEventQuery(db);

    const parentWindow = {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T02:00:00.000Z",
    };
    const runId = await insertPendingRun(db, queryVersionId, "backfill", parentWindow);

    // One response larger than pageSize, done=true, total===fetched — LogScale ignores limit.
    const oversized = [
      event("c1"),
      event("c2"),
      event("c3"),
      event("c4"),
    ];
    const fetchImpl = mockFetch([{ pages: [oversized] }]);

    const outcome = await archiveEventWindow(
      db,
      {
        encryptionKey: config.encryptionKey,
        fetch: fetchImpl,
        pageSize: PAGE_SIZE,
        splitWindow,
        minWindowDurationMs: 60_000,
      },
      runId,
      parentWindow,
    );
    expect(outcome.split).toBe(true);

    const run = await db.query<{ status: string; failure_reason: string | null }>(
      `SELECT status, failure_reason FROM query_runs WHERE id = $1`,
      [runId],
    );
    expect(run.rows[0]).toMatchObject({
      status: "split",
      failure_reason: expect.stringContaining("Result page full"),
    });

    await db.close();
  });

  it("fails visibly at minimum window duration instead of discarding data", async () => {
    applyEnv();
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedActiveEventQuery(db);

    const tinyWindow = {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T00:00:30.000Z",
    };
    const runId = await insertPendingRun(db, queryVersionId, "scheduled", tinyWindow);
    const fetchImpl = mockFetch([{ warnings: [RESULT_CAP_WARNING] }]);

    const outcome = await archiveEventWindow(
      db,
      {
        encryptionKey: config.encryptionKey,
        fetch: fetchImpl,
        splitWindow,
        minWindowDurationMs: 60_000,
      },
      runId,
      tinyWindow,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.split).toBeUndefined();

    const run = await db.query<{ status: string; failure_reason: string | null }>(
      `SELECT status, failure_reason FROM query_runs WHERE id = $1`,
      [runId],
    );
    expect(run.rows[0]).toMatchObject({
      status: "failed",
      failure_reason: expect.stringContaining(RESULT_CAP_WARNING),
    });

    const childCount = await db.query(`SELECT 1 FROM query_runs WHERE parent_run_id = $1`, [runId]);
    expect(childCount.rows).toHaveLength(0);

    await db.close();
  });

  it("deduplicates overlapping events across split window boundaries", async () => {
    applyEnv();
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedActiveEventQuery(db);

    const boundary = "2026-01-01T01:00:00.000Z";
    const parentWindow = {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T02:00:00.000Z",
    };
    const [left, right] = splitWindow(parentWindow);
    const parentRunId = await insertPendingRun(db, queryVersionId, "scheduled", parentWindow);

    const fetchImpl = mockFetch([
      { warnings: [RESULT_CAP_WARNING] },
      { pages: [[event("unique-left"), event("overlap", "repo-a", boundary)]] },
      { pages: [[event("overlap", "repo-a", boundary), event("unique-right")]] },
    ]);

    await archiveEventWindow(
      db,
      { encryptionKey: config.encryptionKey, fetch: fetchImpl, splitWindow, minWindowDurationMs: 60_000 },
      parentRunId,
      parentWindow,
    );

    const children = await db.query<{ id: string }>(
      `SELECT id FROM query_runs WHERE parent_run_id = $1 ORDER BY window_start`,
      [parentRunId],
    );

    await archiveEventWindow(
      db,
      { encryptionKey: config.encryptionKey, fetch: fetchImpl, splitWindow, minWindowDurationMs: 60_000 },
      children.rows[0]!.id,
      left,
    );
    await archiveEventWindow(
      db,
      { encryptionKey: config.encryptionKey, fetch: fetchImpl, splitWindow, minWindowDurationMs: 60_000 },
      children.rows[1]!.id,
      right,
    );

    const stored = await db.query<{ source_event_id: string }>(
      `SELECT source_event_id FROM event_records
       WHERE query_version_id = $1
       ORDER BY source_event_id`,
      [queryVersionId],
    );
    expect(stored.rows.map((row) => row.source_event_id)).toEqual([
      "overlap",
      "unique-left",
      "unique-right",
    ]);

    await db.close();
  });

  it("fails aggregate archive on result cap with no partial snapshot", async () => {
    applyEnv();
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId } = await seedActiveAggregateQuery(db);
    const window = {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T01:00:00.000Z",
    };
    const runId = await insertPendingRun(db, queryVersionId, "scheduled", window);

    const fetchImpl = mockFetch([
      {
        warnings: [RESULT_CAP_WARNING],
        pages: [[aggregateRow("2026-01-01T00:00:00.000Z", 42)]],
      },
    ]);

    const outcome = await archiveAggregateWindow(
      db,
      { encryptionKey: config.encryptionKey, fetch: fetchImpl, pageSize: PAGE_SIZE },
      runId,
      window,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("result_cap");

    const run = await db.query<{ status: string; failure_reason: string | null }>(
      `SELECT status, failure_reason FROM query_runs WHERE id = $1`,
      [runId],
    );
    expect(run.rows[0]).toMatchObject({
      status: "failed",
      failure_reason: expect.stringContaining(RESULT_CAP_WARNING),
    });

    const snapshots = await db.query(`SELECT 1 FROM aggregate_snapshots WHERE query_run_id = $1`, [
      runId,
    ]);
    expect(snapshots.rows).toHaveLength(0);

    await db.close();
  });

  it("versions aggregate snapshots on repeated windows and preserves revisions", async () => {
    applyEnv();
    const config = loadConfig(process.env);
    const db = createDatabase(DATABASE_URL);
    const { queryVersionId, repository } = await seedActiveAggregateQuery(db);
    const window = {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T01:00:00.000Z",
    };

    const firstRunId = await insertPendingRun(db, queryVersionId, "scheduled", window);
    const secondRunId = await insertPendingRun(db, queryVersionId, "scheduled", {
      start: "2026-01-01T01:00:00.000Z",
      end: "2026-01-01T02:00:00.000Z",
    });
    const thirdRunId = await insertPendingRun(db, queryVersionId, "scheduled", window);

    const payloadV1 = [aggregateRow("2026-01-01T00:00:00.000Z", 10)];
    const payloadV2 = [aggregateRow("2026-01-01T00:00:00.000Z", 11)];

    const fetchImpl = mockFetch([
      { pages: [payloadV1] },
      { pages: [[aggregateRow("2026-01-01T01:00:00.000Z", 10)]] },
      { pages: [payloadV2] },
    ]);

    const first = await archiveAggregateWindow(
      db,
      { encryptionKey: config.encryptionKey, fetch: fetchImpl, pageSize: PAGE_SIZE },
      firstRunId,
      window,
    );
    expect(first.ok).toBe(true);
    expect(first.revision).toBe(1);

    const delayed = await archiveAggregateWindow(
      db,
      { encryptionKey: config.encryptionKey, fetch: fetchImpl, pageSize: PAGE_SIZE },
      secondRunId,
      { start: "2026-01-01T01:00:00.000Z", end: "2026-01-01T02:00:00.000Z" },
    );
    expect(delayed.ok).toBe(true);

    const repeated = await archiveAggregateWindow(
      db,
      { encryptionKey: config.encryptionKey, fetch: fetchImpl, pageSize: PAGE_SIZE },
      thirdRunId,
      window,
    );
    expect(repeated.ok).toBe(true);
    expect(repeated.revision).toBe(2);

    const revisions = await db.query<{ revision: number; payload: unknown }>(
      `SELECT revision, payload FROM aggregate_snapshots
       WHERE query_version_id = $1 AND repository = $2
         AND window_start = $3::timestamptz AND window_end = $4::timestamptz
       ORDER BY revision`,
      [queryVersionId, repository, window.start, window.end],
    );
    expect(revisions.rows).toHaveLength(2);
    expect(revisions.rows[0]!.revision).toBe(1);
    expect(revisions.rows[1]!.revision).toBe(2);

    const unchanged = await storeAggregateSnapshot(db, {
      queryVersionId,
      queryRunId: thirdRunId,
      repository,
      windowStart: window.start,
      windowEnd: window.end,
      dimensions: {},
      payload: payloadV2,
    });
    expect(unchanged.created).toBe(false);
    expect(unchanged.revision).toBe(2);

    await db.close();
  });
});
