import pg from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@archive/config";
import {
  createDatabase,
  encryptSecret,
  encryptedSecretToBytes,
  migrateDatabase,
} from "@archive/core";
import { enqueueDueRuns } from "../../apps/worker/src/scheduler.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://archive:change-me-local-only@127.0.0.1:5432/archive";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

describe("enqueueDueRuns cron spacing", () => {
  const db = createDatabase(DATABASE_URL);

  beforeAll(() => {
    Object.assign(process.env, {
      APP_ROLE: "worker",
      DATABASE_URL,
      ENCRYPTION_KEY,
      SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
    });
    loadConfig();
  });

  beforeEach(async () => {
    await resetDatabase(DATABASE_URL);
    await migrateDatabase(DATABASE_URL);
  });

  afterEach(async () => {
    await db.query("SELECT 1").catch(() => undefined);
  });

  it("advances next_run_at to the next cron tick after enqueue", async () => {
    const encrypted = encryptSecret("tok", Buffer.from(ENCRYPTION_KEY, "hex"));
    const connection = await db.query<{ id: string }>(
      `INSERT INTO logscale_connections
         (name, endpoint, repository, token_ciphertext, token_key_id, status)
       VALUES ('c', 'https://example', 'repo', $1, 'env-v1', 'valid')
       RETURNING id`,
      [encryptedSecretToBytes(encrypted)],
    );
    const version = await db.query<{ id: string }>(
      `INSERT INTO query_versions
         (connection_id, name, version_number, query_text, mode, schedule_cron, schedule_timezone,
          initial_start_at, correction_window_seconds, active, test_passed_at)
       VALUES ($1, 'events', 1, '*', 'event', '0 * * * *', 'UTC',
               '2026-08-15T18:00:00.000Z', 300, true, now())
       RETURNING id`,
      [connection.rows[0]!.id],
    );
    const queryVersionId = version.rows[0]!.id;
    await db.query(
      `INSERT INTO query_schedules (query_version_id, next_run_at, watermark_at, paused)
       VALUES ($1, '2026-08-15T19:00:00.000Z', '2026-08-15T18:00:00.000Z', false)`,
      [queryVersionId],
    );

    const now = new Date("2026-08-15T19:20:00.000Z");
    await enqueueDueRuns(db, now);

    const runs = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM query_runs WHERE query_version_id = $1`,
      [queryVersionId],
    );
    expect(Number(runs.rows[0]!.count)).toBe(1);

    const schedule = await db.query<{ next_run_at: Date }>(
      `SELECT next_run_at FROM query_schedules WHERE query_version_id = $1`,
      [queryVersionId],
    );
    expect(schedule.rows[0]!.next_run_at.toISOString()).toBe("2026-08-15T20:00:00.000Z");

    await enqueueDueRuns(db, now);
    const runsAgain = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM query_runs WHERE query_version_id = $1`,
      [queryVersionId],
    );
    expect(Number(runsAgain.rows[0]!.count)).toBe(1);
  });

  it("creates one run when scheduler ticks overlap", async () => {
    const encrypted = encryptSecret("tok", Buffer.from(ENCRYPTION_KEY, "hex"));
    const connection = await db.query<{ id: string }>(
      `INSERT INTO logscale_connections
         (name, endpoint, repository, token_ciphertext, token_key_id, status)
       VALUES ('concurrent', 'https://example', 'repo', $1, 'env-v1', 'valid')
       RETURNING id`,
      [encryptedSecretToBytes(encrypted)],
    );
    const version = await db.query<{ id: string }>(
      `INSERT INTO query_versions
         (connection_id, name, version_number, query_text, mode, schedule_cron, schedule_timezone,
          initial_start_at, correction_window_seconds, active, test_passed_at)
       VALUES ($1, 'concurrent-events', 1, '*', 'event', '0 * * * *', 'UTC',
               '2026-08-15T18:00:00.000Z', 300, true, now())
       RETURNING id`,
      [connection.rows[0]!.id],
    );
    const queryVersionId = version.rows[0]!.id;
    await db.query(
      `INSERT INTO query_schedules (query_version_id, next_run_at, watermark_at, paused)
       VALUES ($1, '2026-08-15T19:00:00.000Z', '2026-08-15T18:00:00.000Z', false)`,
      [queryVersionId],
    );

    const now = new Date("2026-08-15T19:20:00.000Z");
    await Promise.all([enqueueDueRuns(db, now), enqueueDueRuns(db, now)]);

    const runs = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM query_runs WHERE query_version_id = $1`,
      [queryVersionId],
    );
    expect(Number(runs.rows[0]!.count)).toBe(1);
  });
});
