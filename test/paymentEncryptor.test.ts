/**
 * Tests for #961 — Advanced Payment Encryption with Key Rotation
 *
 * Verifies:
 * - Key registration (addKey, setActiveKey, retireKey)
 * - Key derivation (deriveKey, generateKey, generateSalt)
 * - Encrypt / decrypt round-trip (including bigint amounts)
 * - Re-encryption across key versions (reEncrypt)
 * - Event emission (key:added, key:retired, key:rotated, payload:encrypted, payload:decrypted)
 * - Error paths (no active key, wrong key version, tampered ciphertext)
 * - Constant-time key comparison (keysEqual)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PaymentEncryptor,
  EncryptionError,
  DecryptionError,
  KeyRotationError,
} from "../src/paymentEncryptor.js";
import type { PaymentData } from "../src/paymentEncryptor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a random 32-byte key for tests (synchronous). */
function randomKey(): Uint8Array {
  return PaymentEncryptor.generateKey();
}

function makeSampleData(overrides: Partial<PaymentData> = {}): PaymentData {
  return {
    amount: 1_000_000n,
    payer: "GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB",
    memo: "Invoice #42",
    metadata: { invoiceId: "42" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

describe("PaymentEncryptor — key management", () => {
  it("registers a key with addKey", () => {
    const enc = new PaymentEncryptor();
    enc.addKey(1, randomKey());
    expect(enc.listKeyVersions()).toContain(1);
  });

  it("addKey is chainable", () => {
    const enc = new PaymentEncryptor();
    const returned = enc.addKey(1, randomKey());
    expect(returned).toBe(enc);
  });

  it("throws when registering duplicate version", () => {
    const enc = new PaymentEncryptor();
    enc.addKey(1, randomKey());
    expect(() => enc.addKey(1, randomKey())).toThrow(KeyRotationError);
  });

  it("throws for non-positive version", () => {
    const enc = new PaymentEncryptor();
    expect(() => enc.addKey(0, randomKey())).toThrow(KeyRotationError);
    expect(() => enc.addKey(-1, randomKey())).toThrow(KeyRotationError);
  });

  it("throws when key is not 32 bytes", () => {
    const enc = new PaymentEncryptor();
    expect(() => enc.addKey(1, new Uint8Array(16))).toThrow(KeyRotationError);
  });

  it("setActiveKey sets the active version", () => {
    const enc = new PaymentEncryptor();
    enc.addKey(1, randomKey());
    enc.setActiveKey(1);
    expect(enc.activeVersion).toBe(1);
  });

  it("setActiveKey is chainable", () => {
    const enc = new PaymentEncryptor();
    enc.addKey(1, randomKey());
    const returned = enc.setActiveKey(1);
    expect(returned).toBe(enc);
  });

  it("throws when activating an unregistered key", () => {
    const enc = new PaymentEncryptor();
    expect(() => enc.setActiveKey(99)).toThrow(KeyRotationError);
  });

  it("throws when activating a retired key", () => {
    const enc = new PaymentEncryptor();
    enc.addKey(1, randomKey());
    enc.retireKey(1);
    expect(() => enc.setActiveKey(1)).toThrow(KeyRotationError);
  });

  it("retireKey marks the key as retired", () => {
    const enc = new PaymentEncryptor();
    enc.addKey(1, randomKey());
    enc.retireKey(1);
    const info = enc.getKeyInfo(1);
    expect(info?.retired).toBe(true);
  });

  it("retireKey clears activeVersion when the active key is retired", () => {
    const enc = new PaymentEncryptor();
    enc.addKey(1, randomKey());
    enc.setActiveKey(1);
    enc.retireKey(1);
    expect(enc.activeVersion).toBeNull();
  });

  it("throws when retiring an unregistered key", () => {
    const enc = new PaymentEncryptor();
    expect(() => enc.retireKey(99)).toThrow(KeyRotationError);
  });

  it("getKeyInfo returns undefined for unknown version", () => {
    const enc = new PaymentEncryptor();
    expect(enc.getKeyInfo(999)).toBeUndefined();
  });

  it("getKeyInfo does not expose raw key bytes", () => {
    const enc = new PaymentEncryptor();
    enc.addKey(1, randomKey());
    const info = enc.getKeyInfo(1) as Record<string, unknown>;
    expect(info).not.toHaveProperty("key");
  });

  it("activeVersion is null before any setActiveKey call", () => {
    const enc = new PaymentEncryptor();
    expect(enc.activeVersion).toBeNull();
  });

  it("listKeyVersions returns all registered versions", () => {
    const enc = new PaymentEncryptor();
    enc.addKey(1, randomKey());
    enc.addKey(2, randomKey());
    expect(enc.listKeyVersions()).toEqual(expect.arrayContaining([1, 2]));
  });
});

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

describe("PaymentEncryptor — key derivation", () => {
  it("deriveKey returns a 32-byte Uint8Array", async () => {
    const salt = PaymentEncryptor.generateSalt();
    const key = await PaymentEncryptor.deriveKey("passphrase", { salt });
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("deriveKey produces the same key for same passphrase + salt", async () => {
    const salt = PaymentEncryptor.generateSalt();
    const k1 = await PaymentEncryptor.deriveKey("pass", { salt, iterations: 1000 });
    const k2 = await PaymentEncryptor.deriveKey("pass", { salt, iterations: 1000 });
    expect(PaymentEncryptor.keysEqual(k1, k2)).toBe(true);
  });

  it("deriveKey produces different keys for different passphrases", async () => {
    const salt = PaymentEncryptor.generateSalt();
    const k1 = await PaymentEncryptor.deriveKey("pass1", { salt, iterations: 1000 });
    const k2 = await PaymentEncryptor.deriveKey("pass2", { salt, iterations: 1000 });
    expect(PaymentEncryptor.keysEqual(k1, k2)).toBe(false);
  });

  it("generateKey returns 32 random bytes", () => {
    const k1 = PaymentEncryptor.generateKey();
    const k2 = PaymentEncryptor.generateKey();
    expect(k1.length).toBe(32);
    expect(PaymentEncryptor.keysEqual(k1, k2)).toBe(false); // astronomically unlikely to collide
  });

  it("generateSalt returns the requested number of bytes", () => {
    expect(PaymentEncryptor.generateSalt(16).length).toBe(16);
    expect(PaymentEncryptor.generateSalt(32).length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

describe("PaymentEncryptor — encrypt / decrypt", () => {
  let enc: PaymentEncryptor;

  beforeEach(() => {
    enc = new PaymentEncryptor();
    enc.addKey(1, randomKey());
    enc.setActiveKey(1);
  });

  it("encrypt returns an envelope with envelopeVersion 1", async () => {
    const envelope = await enc.encrypt(makeSampleData());
    expect(envelope.envelopeVersion).toBe(1);
  });

  it("encrypt returns an envelope with the active keyVersion", async () => {
    const envelope = await enc.encrypt(makeSampleData());
    expect(envelope.keyVersion).toBe(1);
  });

  it("encrypt produces base64 iv, tag and ciphertext", async () => {
    const envelope = await enc.encrypt(makeSampleData());
    expect(Buffer.from(envelope.iv, "base64").length).toBe(12);
    expect(Buffer.from(envelope.tag, "base64").length).toBe(16);
    expect(Buffer.from(envelope.ciphertext, "base64").length).toBeGreaterThan(0);
  });

  it("decrypt round-trips all fields including bigint amount", async () => {
    const data = makeSampleData({ amount: 999_999_999n });
    const envelope = await enc.encrypt(data);
    const decrypted = await enc.decrypt(envelope);
    expect(decrypted.amount).toBe(999_999_999n);
    expect(decrypted.payer).toBe(data.payer);
    expect(decrypted.memo).toBe(data.memo);
    expect(decrypted.metadata).toEqual(data.metadata);
  });

  it("decrypt round-trips zero amount", async () => {
    const envelope = await enc.encrypt(makeSampleData({ amount: 0n }));
    const decrypted = await enc.decrypt(envelope);
    expect(decrypted.amount).toBe(0n);
  });

  it("throws EncryptionError when no active key is set", async () => {
    const fresh = new PaymentEncryptor();
    fresh.addKey(1, randomKey());
    await expect(fresh.encrypt(makeSampleData())).rejects.toBeInstanceOf(EncryptionError);
  });

  it("throws DecryptionError for an unregistered key version", async () => {
    const envelope = await enc.encrypt(makeSampleData());
    const fresh = new PaymentEncryptor(); // no keys registered
    await expect(fresh.decrypt(envelope)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("throws DecryptionError when ciphertext is tampered", async () => {
    const envelope = await enc.encrypt(makeSampleData());
    const tampered = {
      ...envelope,
      ciphertext: Buffer.from("TAMPERED_DATA_TAMPERED").toString("base64"),
    };
    await expect(enc.decrypt(tampered)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("each encrypt call produces a different IV", async () => {
    const e1 = await enc.encrypt(makeSampleData());
    const e2 = await enc.encrypt(makeSampleData());
    expect(e1.iv).not.toBe(e2.iv);
  });
});

// ---------------------------------------------------------------------------
// Key rotation / re-encryption
// ---------------------------------------------------------------------------

describe("PaymentEncryptor — reEncrypt()", () => {
  it("re-encrypts under the new active key", async () => {
    const enc = new PaymentEncryptor();
    const k1 = randomKey();
    const k2 = randomKey();
    enc.addKey(1, k1).setActiveKey(1);

    const envelope = await enc.encrypt(makeSampleData({ amount: 5000n }));
    expect(envelope.keyVersion).toBe(1);

    enc.addKey(2, k2).setActiveKey(2);
    const rotated = await enc.reEncrypt(envelope);

    expect(rotated.keyVersion).toBe(2);
    const decrypted = await enc.decrypt(rotated);
    expect(decrypted.amount).toBe(5000n);
  });

  it("returns the same envelope when keyVersion already matches active", async () => {
    const enc = new PaymentEncryptor();
    enc.addKey(1, randomKey()).setActiveKey(1);
    const envelope = await enc.encrypt(makeSampleData());
    const result = await enc.reEncrypt(envelope);
    expect(result).toBe(envelope); // exact same reference
  });

  it("throws EncryptionError when no active key during reEncrypt", async () => {
    const enc = new PaymentEncryptor();
    const key = randomKey();
    enc.addKey(1, key).setActiveKey(1);
    const envelope = await enc.encrypt(makeSampleData());
    enc.retireKey(1); // clears active
    await expect(enc.reEncrypt(envelope)).rejects.toBeInstanceOf(EncryptionError);
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("PaymentEncryptor — events", () => {
  it("emits key:added when a key is registered", () => {
    const enc = new PaymentEncryptor();
    const handler = vi.fn();
    enc.on("key:added", handler);
    enc.addKey(1, randomKey());
    expect(handler).toHaveBeenCalledWith({ version: 1 });
  });

  it("emits key:retired when a key is retired", () => {
    const enc = new PaymentEncryptor();
    const handler = vi.fn();
    enc.on("key:retired", handler);
    enc.addKey(1, randomKey());
    enc.retireKey(1);
    expect(handler).toHaveBeenCalledWith({ version: 1 });
  });

  it("emits key:rotated when active key changes", () => {
    const enc = new PaymentEncryptor();
    const handler = vi.fn();
    enc.on("key:rotated", handler);
    enc.addKey(1, randomKey());
    enc.setActiveKey(1);
    expect(handler).toHaveBeenCalledWith({ fromVersion: null, toVersion: 1 });
  });

  it("emits key:rotated with previous version on key change", () => {
    const enc = new PaymentEncryptor();
    const handler = vi.fn();
    enc.on("key:rotated", handler);
    enc.addKey(1, randomKey()).setActiveKey(1);
    enc.addKey(2, randomKey()).setActiveKey(2);
    expect(handler).toHaveBeenLastCalledWith({ fromVersion: 1, toVersion: 2 });
  });

  it("emits payload:encrypted after encrypt()", async () => {
    const enc = new PaymentEncryptor();
    enc.addKey(1, randomKey()).setActiveKey(1);
    const handler = vi.fn();
    enc.on("payload:encrypted", handler);
    await enc.encrypt(makeSampleData());
    expect(handler).toHaveBeenCalledWith({ keyVersion: 1 });
  });

  it("emits payload:decrypted after decrypt()", async () => {
    const enc = new PaymentEncryptor();
    enc.addKey(1, randomKey()).setActiveKey(1);
    const handler = vi.fn();
    enc.on("payload:decrypted", handler);
    const envelope = await enc.encrypt(makeSampleData());
    await enc.decrypt(envelope);
    expect(handler).toHaveBeenCalledWith({ keyVersion: 1 });
  });
});

// ---------------------------------------------------------------------------
// keysEqual()
// ---------------------------------------------------------------------------

describe("PaymentEncryptor.keysEqual()", () => {
  it("returns true for identical keys", () => {
    const k = randomKey();
    expect(PaymentEncryptor.keysEqual(k, Uint8Array.from(k))).toBe(true);
  });

  it("returns false for different keys", () => {
    expect(
      PaymentEncryptor.keysEqual(randomKey(), randomKey()),
    ).toBe(false);
  });

  it("returns false for keys of different length", () => {
    const k1 = new Uint8Array(32);
    const k2 = new Uint8Array(16);
    expect(PaymentEncryptor.keysEqual(k1, k2)).toBe(false);
  });
});
