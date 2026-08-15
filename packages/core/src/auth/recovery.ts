import type { Database } from "../db/repositories.js";
import { writeAuditEntry } from "../audit/writeAuditEntry.js";
import { hashPassword } from "./passwords.js";
import { getPasswordPolicy, validatePassword } from "./policy.js";
import { revokeAllSessions } from "./sessions.js";
import { upsertRecoveryAdmin } from "./users.js";

export type RecoveryAdminInput = {
  username: string;
  password: string;
  recoverySecret: string;
  expectedRecoverySecret: string;
  ip?: string | null;
};

export async function createRecoveryAdmin(
  db: Database,
  input: RecoveryAdminInput,
): Promise<{ user: Awaited<ReturnType<typeof upsertRecoveryAdmin>>; sessionsRevoked: number }> {
  if (!input.expectedRecoverySecret) {
    throw new Error("Recovery is not configured");
  }
  if (input.recoverySecret !== input.expectedRecoverySecret) {
    throw new Error("Invalid recovery secret");
  }

  const policy = await getPasswordPolicy(db);
  const passwordErrors = validatePassword(input.password, policy);
  if (passwordErrors.length > 0) {
    throw new Error(passwordErrors.join("; "));
  }

  const passwordHash = await hashPassword(input.password);

  return db.withTransaction(async (client) => {
    const tx = {
      pool: db.pool,
      query: client.query.bind(client),
      withTransaction: db.withTransaction,
      close: db.close,
    };

    const user = await upsertRecoveryAdmin(tx, input.username, passwordHash);
    const sessionsRevoked = await revokeAllSessions(tx);

    await writeAuditEntry(tx, {
      actorUserId: user.id,
      action: "recovery.admin_reset",
      ip: input.ip ?? null,
      metadata: { username: input.username, sessionsRevoked },
    });

    return { user, sessionsRevoked };
  });
}
