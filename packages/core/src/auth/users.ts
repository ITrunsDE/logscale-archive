import type { Database } from "../db/repositories.js";
import { hashPassword } from "./passwords.js";

export type UserRole = "admin" | "viewer";

export type UserRecord = {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  created_at: Date;
  updated_at: Date;
};

export type PublicUser = {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
};

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  created_at: Date;
  updated_at: Date;
};

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function countUsers(db: Database): Promise<number> {
  const { rows } = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
  return Number(rows[0]?.count ?? "0");
}

export async function findUserByUsername(
  db: Database,
  username: string,
): Promise<UserRecord | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT id, username, password_hash, role, created_at, updated_at
     FROM users WHERE username = $1`,
    [username],
  );
  return rows[0] ?? null;
}

export async function findUserById(db: Database, id: string): Promise<UserRecord | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT id, username, password_hash, role, created_at, updated_at
     FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listUsers(db: Database): Promise<PublicUser[]> {
  const { rows } = await db.query<UserRow>(
    `SELECT id, username, password_hash, role, created_at, updated_at
     FROM users ORDER BY username`,
  );
  return rows.map(toPublicUser);
}

export async function createUser(
  db: Database,
  input: { username: string; password: string; role: UserRole },
  passwordHash?: string,
): Promise<PublicUser> {
  const password_hash = passwordHash ?? (await hashPassword(input.password));
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, $2, $3)
     RETURNING id, username, password_hash, role, created_at, updated_at`,
    [input.username, password_hash, input.role],
  );
  return toPublicUser(rows[0]!);
}

export async function upsertRecoveryAdmin(
  db: Database,
  username: string,
  passwordHash: string,
): Promise<PublicUser> {
  const existing = await findUserByUsername(db, username);
  if (existing) {
    const { rows } = await db.query<UserRow>(
      `UPDATE users
       SET password_hash = $1, role = 'admin', updated_at = now()
       WHERE id = $2
       RETURNING id, username, password_hash, role, created_at, updated_at`,
      [passwordHash, existing.id],
    );
    return toPublicUser(rows[0]!);
  }
  return createUser(
    db,
    { username, password: "", role: "admin" },
    passwordHash,
  );
}

export async function updateUserPassword(
  db: Database,
  userId: string,
  password: string,
): Promise<PublicUser | null> {
  const password_hash = await hashPassword(password);
  const { rows } = await db.query<UserRow>(
    `UPDATE users
     SET password_hash = $1, updated_at = now()
     WHERE id = $2
     RETURNING id, username, password_hash, role, created_at, updated_at`,
    [password_hash, userId],
  );
  return rows[0] ? toPublicUser(rows[0]) : null;
}
