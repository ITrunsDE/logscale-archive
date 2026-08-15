import type { Database } from "../db/repositories.js";

export const PASSWORD_MIN_HARD = 12;

export type PasswordPolicy = {
  minLength: number;
  requireUpper: boolean;
  requireLower: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
  historyCount: number;
};

type PasswordPolicyRow = {
  min_length: number;
  require_upper: boolean;
  require_lower: boolean;
  require_digit: boolean;
  require_symbol: boolean;
  history_count: number;
};

function rowToPolicy(row: PasswordPolicyRow): PasswordPolicy {
  return {
    minLength: row.min_length,
    requireUpper: row.require_upper,
    requireLower: row.require_lower,
    requireDigit: row.require_digit,
    requireSymbol: row.require_symbol,
    historyCount: row.history_count,
  };
}

export async function getPasswordPolicy(db: Database): Promise<PasswordPolicy> {
  const { rows } = await db.query<PasswordPolicyRow>(
    `SELECT min_length, require_upper, require_lower, require_digit, require_symbol, history_count
     FROM password_policy WHERE id = 1`,
  );
  const row = rows[0];
  if (!row) {
    throw new Error("password_policy row missing");
  }
  return rowToPolicy(row);
}

export async function updatePasswordPolicy(
  db: Database,
  policy: PasswordPolicy,
): Promise<PasswordPolicy> {
  if (policy.minLength < PASSWORD_MIN_HARD) {
    throw new Error(`minLength must be at least ${PASSWORD_MIN_HARD}`);
  }

  const { rows } = await db.query<PasswordPolicyRow>(
    `UPDATE password_policy
     SET min_length = $1,
         require_upper = $2,
         require_lower = $3,
         require_digit = $4,
         require_symbol = $5,
         history_count = $6,
         updated_at = now()
     WHERE id = 1
     RETURNING min_length, require_upper, require_lower, require_digit, require_symbol, history_count`,
    [
      policy.minLength,
      policy.requireUpper,
      policy.requireLower,
      policy.requireDigit,
      policy.requireSymbol,
      policy.historyCount,
    ],
  );
  return rowToPolicy(rows[0]!);
}

export function validatePassword(password: string, policy: PasswordPolicy): string[] {
  const errors: string[] = [];
  const minLength = Math.max(PASSWORD_MIN_HARD, policy.minLength);

  if (password.length < minLength) {
    errors.push(`Password must be at least ${minLength} characters`);
  }
  if (policy.requireUpper && !/[A-Z]/.test(password)) {
    errors.push("Password must include an uppercase letter");
  }
  if (policy.requireLower && !/[a-z]/.test(password)) {
    errors.push("Password must include a lowercase letter");
  }
  if (policy.requireDigit && !/[0-9]/.test(password)) {
    errors.push("Password must include a digit");
  }
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    errors.push("Password must include a symbol");
  }

  return errors;
}
