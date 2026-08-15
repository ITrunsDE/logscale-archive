import { writeAuditEntry } from "@archive/core";
import type { Database } from "@archive/core";

export type RetentionOutcome = {
  deletedEvents: number;
  deletedAggregates: number;
  skippedHeld: number;
  versionsProcessed: number;
};

type EligibleVersion = {
  id: string;
  retention_days: number;
};

export async function applyRetention(
  db: Database,
  now: Date = new Date(),
): Promise<RetentionOutcome> {
  const outcome: RetentionOutcome = {
    deletedEvents: 0,
    deletedAggregates: 0,
    skippedHeld: 0,
    versionsProcessed: 0,
  };

  const held = await db.query<{ query_version_id: string }>(
    `SELECT query_version_id FROM retention_holds`,
  );
  const heldIds = new Set(held.rows.map((row) => row.query_version_id));
  outcome.skippedHeld = heldIds.size;

  const versions = await db.query<EligibleVersion>(
    `SELECT id, retention_days
     FROM query_versions
     WHERE retention_days IS NOT NULL`,
  );

  for (const version of versions.rows) {
    if (heldIds.has(version.id)) {
      continue;
    }

    const cutoff = new Date(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - version.retention_days);

    const deleted = await db.withTransaction(async (client) => {
      const events = await client.query(
        `DELETE FROM event_records
         WHERE query_version_id = $1 AND event_timestamp < $2`,
        [version.id, cutoff.toISOString()],
      );
      const aggregates = await client.query(
        `DELETE FROM aggregate_snapshots
         WHERE query_version_id = $1 AND window_end < $2`,
        [version.id, cutoff.toISOString()],
      );
      return {
        events: events.rowCount ?? 0,
        aggregates: aggregates.rowCount ?? 0,
      };
    });

    if (deleted.events > 0 || deleted.aggregates > 0) {
      await writeAuditEntry(db, {
        action: "retention.delete.batch",
        metadata: {
          queryVersionId: version.id,
          cutoff: cutoff.toISOString(),
          deletedEvents: deleted.events,
          deletedAggregates: deleted.aggregates,
        },
      });
    }

    outcome.deletedEvents += deleted.events;
    outcome.deletedAggregates += deleted.aggregates;
    outcome.versionsProcessed += 1;
  }

  return outcome;
}

export async function manualDeleteVersionData(
  db: Database,
  queryVersionId: string,
  before?: Date,
): Promise<{ deletedEvents: number; deletedAggregates: number }> {
  const cutoff = before?.toISOString();

  const deleted = await db.withTransaction(async (client) => {
    const events = cutoff
      ? await client.query(
          `DELETE FROM event_records
           WHERE query_version_id = $1 AND event_timestamp < $2`,
          [queryVersionId, cutoff],
        )
      : await client.query(`DELETE FROM event_records WHERE query_version_id = $1`, [queryVersionId]);

    const aggregates = cutoff
      ? await client.query(
          `DELETE FROM aggregate_snapshots
           WHERE query_version_id = $1 AND window_end < $2`,
          [queryVersionId, cutoff],
        )
      : await client.query(`DELETE FROM aggregate_snapshots WHERE query_version_id = $1`, [
          queryVersionId,
        ]);

    return {
      events: events.rowCount ?? 0,
      aggregates: aggregates.rowCount ?? 0,
    };
  });

  await writeAuditEntry(db, {
    action: "retention.manual.delete",
    metadata: {
      queryVersionId,
      cutoff: cutoff ?? null,
      deletedEvents: deleted.events,
      deletedAggregates: deleted.aggregates,
    },
  });

  return {
    deletedEvents: deleted.events,
    deletedAggregates: deleted.aggregates,
  };
}
