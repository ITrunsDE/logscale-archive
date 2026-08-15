import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertRecentBackupBeforeMigration } from "../maintenance.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith(".sql")).sort();
}

export async function migrateDatabase(
  url: string,
  options: { skipBackupGuard?: boolean } = {},
): Promise<void> {
  if (!options.skipBackupGuard) {
    await assertRecentBackupBeforeMigration(url);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await ensureMigrationsTable(client);
    const files = await listMigrationFiles();
    if (files.length === 0) {
      throw new Error(`No migration files found in ${MIGRATIONS_DIR}`);
    }

    const { rows: appliedRows } = await client.query<{ id: string }>(
      "SELECT id FROM schema_migrations ORDER BY id",
    );
    const applied = new Set(appliedRows.map((row) => row.id));

    // Refuse gaps: every applied id must exist on disk, in order.
    for (const id of applied) {
      if (!files.includes(`${id}.sql`) && !files.includes(id)) {
        throw new Error(`Inconsistent migration state: applied unknown migration ${id}`);
      }
    }

    for (const file of files) {
      const id = file.replace(/\.sql$/, "");
      if (applied.has(id) || applied.has(file)) {
        continue;
      }

      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}
