import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const ENCRYPTION_VERSION = 1;
export const ENCRYPTION_KEY_BYTES = 32;
export const ENCRYPTION_KEY_ID = "env-v1";

export type EncryptedSecret = {
  v: number;
  iv: string;
  tag: string;
  ciphertext: string;
};

export function parseEncryptionKeyHex(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  if (key.length !== ENCRYPTION_KEY_BYTES) {
    throw new Error("Encryption key must be 32 bytes");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: ENCRYPTION_VERSION,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
}

export function decryptSecret(secret: EncryptedSecret, key: Buffer): string {
  if (secret.v !== ENCRYPTION_VERSION) {
    throw new Error(`Unsupported encryption version: ${secret.v}`);
  }
  if (key.length !== ENCRYPTION_KEY_BYTES) {
    throw new Error("Encryption key must be 32 bytes");
  }

  const iv = Buffer.from(secret.iv, "base64");
  const tag = Buffer.from(secret.tag, "base64");
  const ciphertext = Buffer.from(secret.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function encryptedSecretToBytes(secret: EncryptedSecret): Buffer {
  return Buffer.from(JSON.stringify(secret), "utf8");
}

export function encryptedSecretFromBytes(bytes: Buffer): EncryptedSecret {
  const parsed = JSON.parse(bytes.toString("utf8")) as EncryptedSecret;
  if (
    typeof parsed.v !== "number" ||
    typeof parsed.iv !== "string" ||
    typeof parsed.tag !== "string" ||
    typeof parsed.ciphertext !== "string"
  ) {
    throw new Error("Invalid encrypted secret envelope");
  }
  return parsed;
}
