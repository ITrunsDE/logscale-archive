import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://archive:change-me-local-only@127.0.0.1:5432/archive";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATION = join(REPO_ROOT, "packages/core/migrations/0001_initial.sql");

export default async function globalSetup(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO archive;
      GRANT ALL ON SCHEMA public TO public;
    `);

    const sql = await readFile(MIGRATION, "utf8");
    await client.query(sql);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    await client.query(`INSERT INTO schema_migrations (id) VALUES ('0001_initial')`);
  } finally {
    await client.end();
  }
}
