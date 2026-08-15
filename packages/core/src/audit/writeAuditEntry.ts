import type { Database } from "../db/repositories.js";

export type AuditEntryInput = {
  actorUserId?: string | null;
  action: string;
  ip?: string | null;
  metadata?: Record<string, unknown>;
};

export type AuditEntry = {
  id: string;
  actorUserId: string | null;
  action: string;
  ip: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type ListAuditEntriesInput = {
  limit?: number;
  offset?: number;
  action?: string;
};

const FORBIDDEN_METADATA_KEYS = new Set([
  "token",
  "password",
  "payload",
  "ciphertext",
  "token_ciphertext",
  "secret",
  "plaintext",
  "querytext",
  "query_text",
  "result",
  "results",
  "events",
]);

function isForbiddenMetadataKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    FORBIDDEN_METADATA_KEYS.has(lower) ||
    lower.includes("token") ||
    lower.includes("password") ||
    lower.includes("payload") ||
    lower.includes("ciphertext")
  );
}

export function sanitizeAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isForbiddenMetadataKey(key)) {
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      clean[key] = sanitizeAuditMetadata(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      clean[key] = value.map((item) =>
        item && typeof item === "object"
          ? sanitizeAuditMetadata(item as Record<string, unknown>)
          : item,
      );
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export async function writeAuditEntry(db: Database, input: AuditEntryInput): Promise<void> {
  const metadata = sanitizeAuditMetadata(input.metadata ?? {});
  await db.query(
    `INSERT INTO audit_entries (actor_user_id, action, ip, metadata)
     VALUES ($1, $2, $3::inet, $4::jsonb)`,
    [
      input.actorUserId ?? null,
      input.action,
      input.ip ?? null,
      JSON.stringify(metadata),
    ],
  );
}

type AuditEntryRow = {
  id: string;
  actor_user_id: string | null;
  action: string;
  ip: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
};

export async function listAuditEntries(
  db: Database,
  input: ListAuditEntriesInput = {},
): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const params: unknown[] = [limit, offset];
  let where = "";

  if (input.action) {
    where = "WHERE action = $3";
    params.push(input.action);
  }

  const { rows } = await db.query<AuditEntryRow>(
    `SELECT id, actor_user_id, action, host(ip) AS ip, metadata, created_at
     FROM audit_entries
     ${where}
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    ip: row.ip,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  }));
}
