import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGGREGATE_IDENTITY_UNIQUE,
  EVENT_IDENTITY_UNIQUE,
  createDatabase,
  migrateDatabase,
  tables,
} from "@archive/core";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://archive:change-me-local-only@127.0.0.1:5432/archive";

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

describe("database schema", () => {
  beforeAll(async () => {
    await resetDatabase(DATABASE_URL);
    await migrateDatabase(DATABASE_URL);
  }, 60_000);

  afterAll(async () => {
    // leave schema in place for manual inspection; next run resets
  });

  it("creates required tables with primary keys", async () => {
    const db = createDatabase(DATABASE_URL);
    try {
      const { rows } = await db.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      const names = new Set(rows.map((r) => r.table_name));
      for (const table of tables) {
        expect(names.has(table), `missing table ${table}`).toBe(true);
      }

      const { rows: pks } = await db.query<{ table_name: string }>(
        `SELECT tc.table_name
         FROM information_schema.table_constraints tc
         WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'`,
      );
      const pkTables = new Set(pks.map((r) => r.table_name));
      for (const table of tables) {
        expect(pkTables.has(table), `missing PK on ${table}`).toBe(true);
      }
    } finally {
      await db.close();
    }
  });

  it("enforces unique event identity", async () => {
    const db = createDatabase(DATABASE_URL);
    try {
      const connection = await db.query<{ id: string }>(
        `INSERT INTO logscale_connections (name, endpoint, repository, token_ciphertext, token_key_id)
         VALUES ('c1', 'https://example.local', 'repo', '\\x00', 'k1')
         RETURNING id`,
      );
      const connectionId = connection.rows[0]!.id;
      const version = await db.query<{ id: string }>(
        `INSERT INTO query_versions
           (connection_id, name, version_number, query_text, mode, initial_start_at, active)
         VALUES ($1, 'q1', 1, '#repo=repo', 'event', now(), true)
         RETURNING id`,
        [connectionId],
      );
      const versionId = version.rows[0]!.id;
      const run = await db.query<{ id: string }>(
        `INSERT INTO query_runs
           (query_version_id, kind, status, window_start, window_end)
         VALUES ($1, 'scheduled', 'complete', now() - interval '1 hour', now())
         RETURNING id`,
        [versionId],
      );
      const runId = run.rows[0]!.id;

      await db.query(
        `INSERT INTO event_records
           (query_version_id, query_run_id, source_repo, source_event_id, event_timestamp, payload)
         VALUES ($1, $2, 'repo', 'ev-1', now(), '{"@id":"ev-1"}'::jsonb)`,
        [versionId, runId],
      );

      await expect(
        db.query(
          `INSERT INTO event_records
             (query_version_id, query_run_id, source_repo, source_event_id, event_timestamp, payload)
           VALUES ($1, $2, 'repo', 'ev-1', now(), '{"@id":"ev-1"}'::jsonb)`,
          [versionId, runId],
        ),
      ).rejects.toMatchObject({ code: "23505", constraint: EVENT_IDENTITY_UNIQUE });
    } finally {
      await db.close();
    }
  });

  it("enforces aggregate snapshot identity including revision", async () => {
    const db = createDatabase(DATABASE_URL);
    try {
      const connection = await db.query<{ id: string }>(
        `INSERT INTO logscale_connections (name, endpoint, repository, token_ciphertext, token_key_id)
         VALUES ('c2', 'https://example.local/2', 'repo2', '\\x00', 'k1')
         RETURNING id`,
      );
      const connectionId = connection.rows[0]!.id;
      const version = await db.query<{ id: string }>(
        `INSERT INTO query_versions
           (connection_id, name, version_number, query_text, mode, initial_start_at, active)
         VALUES ($1, 'agg', 1, '#repo=repo2 | count()', 'aggregate', now(), true)
         RETURNING id`,
        [connectionId],
      );
      const versionId = version.rows[0]!.id;
      const run = await db.query<{ id: string }>(
        `INSERT INTO query_runs
           (query_version_id, kind, status, window_start, window_end)
         VALUES ($1, 'scheduled', 'complete', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
         RETURNING id`,
        [versionId],
      );
      const runId = run.rows[0]!.id;

      await db.query(
        `INSERT INTO aggregate_snapshots
           (query_version_id, query_run_id, repository, window_start, window_end, dimensions, dimensions_hash, revision, payload)
         VALUES ($1, $2, 'repo2', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', '{}'::jsonb, 'hash', 1, '{}'::jsonb)`,
        [versionId, runId],
      );

      await expect(
        db.query(
          `INSERT INTO aggregate_snapshots
             (query_version_id, query_run_id, repository, window_start, window_end, dimensions, dimensions_hash, revision, payload)
           VALUES ($1, $2, 'repo2', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', '{}'::jsonb, 'hash', 1, '{}'::jsonb)`,
          [versionId, runId],
        ),
      ).rejects.toMatchObject({ code: "23505", constraint: AGGREGATE_IDENTITY_UNIQUE });

      await db.query(
        `INSERT INTO aggregate_snapshots
           (query_version_id, query_run_id, repository, window_start, window_end, dimensions, dimensions_hash, revision, payload)
         VALUES ($1, $2, 'repo2', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', '{}'::jsonb, 'hash', 2, '{"_count":1}'::jsonb)`,
        [versionId, runId],
      );
    } finally {
      await db.close();
    }
  });

  it("applies migrations idempotently on second run", async () => {
    await migrateDatabase(DATABASE_URL);
    await migrateDatabase(DATABASE_URL);
    const db = createDatabase(DATABASE_URL);
    try {
      const { rows } = await db.query<{ id: string }>(
        "SELECT id FROM schema_migrations ORDER BY id",
      );
      expect(rows.map((r) => r.id)).toEqual(["0001_initial"]);
    } finally {
      await db.close();
    }
  });
});
