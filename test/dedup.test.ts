import { beforeEach, describe, expect, it } from "vitest";
import {
  generateIdempotencyKey,
  isKnownKey,
  registerKey,
  clearKeys,
  Deduplicator,
} from "../src/dedup.js";

describe("generateIdempotencyKey & key registry", () => {
  beforeEach(() => {
    clearKeys();
  });

  const baseParams = {
    invoiceId: "inv-100",
    payer: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGXDECKXOWBLNL2WSRB",
    amount: 5000000n,
  };

  it("produces deterministic key: same params -> same key", () => {
    const key1 = generateIdempotencyKey(baseParams);
    const key2 = generateIdempotencyKey({ ...baseParams });
    expect(key1).toBe(key2);
    expect(typeof key1).toBe("string");
    expect(key1).toHaveLength(64); // SHA-256 hex string
  });

  it("produces different keys when amount differs", () => {
    const key1 = generateIdempotencyKey(baseParams);
    const key2 = generateIdempotencyKey({ ...baseParams, amount: 6000000n });
    expect(key1).not.toBe(key2);
  });

  it("produces different keys when nonce is provided or differs", () => {
    const keyWithoutNonce = generateIdempotencyKey(baseParams);
    const keyWithNonce1 = generateIdempotencyKey({ ...baseParams, nonce: "n1" });
    const keyWithNonce2 = generateIdempotencyKey({ ...baseParams, nonce: "n2" });

    expect(keyWithoutNonce).not.toBe(keyWithNonce1);
    expect(keyWithNonce1).not.toBe(keyWithNonce2);
  });

  it("tracks key registration with isKnownKey after registerKey", () => {
    const key = generateIdempotencyKey(baseParams);
    expect(isKnownKey(key)).toBe(false);

    registerKey(key);
    expect(isKnownKey(key)).toBe(true);
  });

  it("clearKeys resets module state", () => {
    const key1 = generateIdempotencyKey(baseParams);
    const key2 = generateIdempotencyKey({ ...baseParams, nonce: "nonce-xyz" });

    registerKey(key1);
    registerKey(key2);
    expect(isKnownKey(key1)).toBe(true);
    expect(isKnownKey(key2)).toBe(true);

    clearKeys();
    expect(isKnownKey(key1)).toBe(false);
    expect(isKnownKey(key2)).toBe(false);
  });

  it("Deduplicator handles deduplication of concurrent operations", async () => {
    const deduplicator = new Deduplicator<number>();
    let calls = 0;
    const worker = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    };

    const [r1, r2] = await Promise.all([
      deduplicator.dedupe("k1", worker),
      deduplicator.dedupe("k1", worker),
    ]);

    expect(r1).toBe(42);
    expect(r2).toBe(42);
    expect(calls).toBe(1);
    expect(deduplicator.cacheHitRate).toBe(0.5);
  });
});
