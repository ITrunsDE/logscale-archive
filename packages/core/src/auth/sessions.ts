import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "../db/repositories.js";
import type { UserRole } from "./users.js";

export const SESSION_COOKIE = "archive_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionUser = {
  id: string;
  username: string;
  role: UserRole;
};

export type ActiveSession = {
  id: string;
  userId: string;
  csrfSecret: string;
  user: SessionUser;
  expiresAt: Date;
};

type SessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_secret: string;
  expires_at: Date;
  revoked_at: Date | null;
  username: string;
  role: UserRole;
};

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generateCsrfSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function encodeSessionCookie(sessionId: string, token: string): string {
  return `${sessionId}.${token}`;
}

export function decodeSessionCookie(value: string): { sessionId: string; token: string } | null {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) {
    return null;
  }
  return {
    sessionId: value.slice(0, dot),
    token: value.slice(dot + 1),
  };
}

export async function createSession(
  db: Database,
  userId: string,
  ttlMs: number = SESSION_TTL_MS,
): Promise<{ sessionId: string; token: string; csrfSecret: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const csrfSecret = generateCsrfSecret();
  const expiresAt = new Date(Date.now() + ttlMs);

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, csrf_secret, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId, hashSessionToken(token), csrfSecret, expiresAt],
  );

  return {
    sessionId: rows[0]!.id,
    token,
    csrfSecret,
    expiresAt,
  };
}

function rowToActiveSession(row: SessionRow): ActiveSession {
  return {
    id: row.id,
    userId: row.user_id,
    csrfSecret: row.csrf_secret,
    expiresAt: row.expires_at,
    user: {
      id: row.user_id,
      username: row.username,
      role: row.role,
    },
  };
}

export async function resolveSession(
  db: Database,
  sessionId: string,
  token: string,
): Promise<ActiveSession | null> {
  const { rows } = await db.query<SessionRow>(
    `SELECT s.id, s.user_id, s.token_hash, s.csrf_secret, s.expires_at, s.revoked_at,
            u.username, u.role
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`,
    [sessionId],
  );
  const row = rows[0];
  if (!row || row.revoked_at || row.expires_at.getTime() <= Date.now()) {
    return null;
  }

  const expected = Buffer.from(row.token_hash, "hex");
  const actual = Buffer.from(hashSessionToken(token), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  return rowToActiveSession(row);
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
}

export async function revokeAllSessions(db: Database): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL`,
  );
  return rowCount ?? 0;
}

export async function revokeUserSessions(db: Database, userId: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return rowCount ?? 0;
}

export async function revokeUserSessionsExcept(
  db: Database,
  userId: string,
  keepSessionId: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE sessions
     SET revoked_at = now()
     WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
    [userId, keepSessionId],
  );
  return rowCount ?? 0;
}

export function validateCsrf(session: ActiveSession, headerValue: string | undefined): boolean {
  if (!headerValue) {
    return false;
  }
  const expected = Buffer.from(session.csrfSecret);
  const actual = Buffer.from(headerValue);
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}
