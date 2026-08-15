import pg from "pg";

export type Database = {
  pool: pg.Pool;
  query: pg.Pool["query"];
  withTransaction: <T>(fn: (client: pg.PoolClient) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
};

export function createDatabase(url: string): Database {
  const pool = new pg.Pool({ connectionString: url });

  return {
    pool,
    query: pool.query.bind(pool),
    async withTransaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end().catch(() => undefined);
    },
  };
}

export async function reconnectDatabase(db: Database, url: string): Promise<void> {
  await db.pool.end().catch(() => undefined);
  const pool = new pg.Pool({ connectionString: url });
  Object.assign(db, {
    pool,
    query: pool.query.bind(pool),
  });
}
