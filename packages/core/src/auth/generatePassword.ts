import { randomInt } from "node:crypto";
import { PASSWORD_MIN_HARD, type PasswordPolicy, validatePassword } from "./policy.js";

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGIT = "23456789";
const SYMBOL = "!@#$%^&*-_=+";

function pick(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)]!;
}

function shuffle(values: string[]): void {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const tmp = values[i]!;
    values[i] = values[j]!;
    values[j] = tmp;
  }
}

export function generateCompliantPassword(policy: PasswordPolicy): string {
  const length = Math.max(policy.minLength, PASSWORD_MIN_HARD, 16);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const chars: string[] = [];
    if (policy.requireUpper) {
      chars.push(pick(UPPER));
    }
    if (policy.requireLower) {
      chars.push(pick(LOWER));
    }
    if (policy.requireDigit) {
      chars.push(pick(DIGIT));
    }
    if (policy.requireSymbol) {
      chars.push(pick(SYMBOL));
    }
    if (chars.length === 0) {
      chars.push(pick(LOWER), pick(UPPER), pick(DIGIT));
    }

    let pool = UPPER + LOWER + DIGIT;
    if (policy.requireSymbol) {
      pool += SYMBOL;
    }
    while (chars.length < length) {
      chars.push(pick(pool));
    }
    shuffle(chars);
    const password = chars.join("");
    if (validatePassword(password, policy).length === 0) {
      return password;
    }
  }

  throw new Error("password_generate_failed");
}
