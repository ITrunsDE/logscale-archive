import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  encryptedSecretFromBytes,
  encryptedSecretToBytes,
  parseEncryptionKeyHex,
} from "@archive/core";

const KEY_A = parseEncryptionKeyHex(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const KEY_B = parseEncryptionKeyHex(
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
);

describe("encryption", () => {
  it("encrypts secrets into a versioned envelope distinct from plaintext", () => {
    const plaintext = "logscale-read-token-value";
    const secret = encryptSecret(plaintext, KEY_A);

    expect(secret.v).toBe(1);
    expect(secret.ciphertext).not.toBe(plaintext);
    expect(JSON.stringify(secret)).not.toContain(plaintext);

    const roundTrip = decryptSecret(secret, KEY_A);
    expect(roundTrip).toBe(plaintext);
  });

  it("rejects decryption with the wrong key", () => {
    const secret = encryptSecret("another-secret-token", KEY_A);
    expect(() => decryptSecret(secret, KEY_B)).toThrow();
  });

  it("round-trips through byte storage", () => {
    const secret = encryptSecret("stored-token", KEY_A);
    const bytes = encryptedSecretToBytes(secret);
    const restored = encryptedSecretFromBytes(bytes);
    expect(decryptSecret(restored, KEY_A)).toBe("stored-token");
  });

  it("rejects invalid encryption keys", () => {
    expect(() => parseEncryptionKeyHex("short")).toThrow(/64 hex/);
    expect(() => encryptSecret("token", randomBytes(16))).toThrow(/32 bytes/);
  });
});
