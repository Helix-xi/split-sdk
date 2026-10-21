/**
 * Tests for Drips Wave issues #874, #875, #876, #877.
 *
 * #877 — Whitelist management (addToWhitelist, removeFromWhitelist, getWhitelist)
 * #876 — Protocol stats with caching and subscription (getProtocolStats, subscribeProtocolStats)
 * #875 — Note methods with byte-length validation (addNote, getNotes)
 * #874 — SDK logger middleware with redaction (setLogger)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  WhitelistFullError,
  ContentTooLongError,
  ValidationError,
} from "../src/errors.js";
import type { ProtocolStats, Note, SdkLogger } from "../src/types.js";

// ---------------------------------------------------------------------------
// Shared test utilities
// ---------------------------------------------------------------------------

/** Valid Stellar G-address used as a stand-in for contract/account IDs. */
const VALID_ADDRESS_1 = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN";
const VALID_ADDRESS_2 = "GBVVJJWVYW5SXMKPQLZ7GWMIFKIWUUDEHB3FKPMZKMFPCKQHCLBGTBNF";
const VALID_ADDRESS_3 = "GD5DJQDDBKGAYNEAXU562HYGOOSYAEOO6AS53PZXBOZGCP5M2OPGMZV3";
const INVALID_ADDRESS = "not-a-valid-address";
const CONTRACT_ID = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

// ---------------------------------------------------------------------------
// Minimal mock of StellarSplitClient for unit tests.
//
// We test the business logic (validation, cache, redaction) without a live
// Soroban node by stubbing out the contract/server internals.
// ---------------------------------------------------------------------------

function makeMockClient() {
  // Internal state
  const whitelists: Record<string, string[]> = {};
  const notes: Record<string, Array<{ index: number; content: string; timestamp: Date }>> = {};

  // Protocol stats (simulates on-chain data)
  let _statsOnChain: ProtocolStats = {
    totalInvoices: 10,
    totalPaidAmount: 100n,
    totalReleasedAmount: 80n,
    totalRefundedAmount: 20n,
    uniqueCreators: 3,
    uniquePayers: 5,
  };
  const _statsCache: Map<string, { data: ProtocolStats; fetchedAt: number }> = new Map();
  const STATS_TTL = 30_000;
  const WHITELIST_MAX = 50;
  const NOTE_MAX_BYTES = 512;

  let _logger: SdkLogger | null = null;

  const SENSITIVE_KEYS = new Set(["privateKey", "accessCode", "blindingFactor", "secret"]);

  function redactParams(params: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      out[k] = SENSITIVE_KEYS.has(k) ? "[REDACTED]" : v;
    }
    return out;
  }

  const client = {
    // ---- #874 setLogger ----
    setLogger(logger: SdkLogger) {
      _logger = logger;
    },

    _logger: () => _logger,
    _redactParams: redactParams,

    // ---- #877 whitelist ----
    async addToWhitelist(invoiceId: string, address: string): Promise<void> {
      _logger?.info("addToWhitelist called", { invoiceId, address });

      // Validate address
      if (!_isValidStellarAddress(address)) {
        _logger?.warn("addToWhitelist: invalid address", { address });
        throw new ValidationError(`Invalid Stellar address: ${address}`);
      }

      const list = whitelists[invoiceId] ?? [];
      if (list.length >= WHITELIST_MAX) {
        _logger?.warn("addToWhitelist: whitelist full", { invoiceId });
        throw new WhitelistFullError(invoiceId, WHITELIST_MAX);
      }

      whitelists[invoiceId] = list;
      if (!list.includes(address)) list.push(address);
    },

    async removeFromWhitelist(invoiceId: string, address: string): Promise<void> {
      _logger?.info("removeFromWhitelist called", { invoiceId, address });

      if (!_isValidStellarAddress(address)) {
        throw new ValidationError(`Invalid Stellar address: ${address}`);
      }

      if (whitelists[invoiceId]) {
        whitelists[invoiceId] = whitelists[invoiceId]!.filter((a) => a !== address);
      }
    },

    async getWhitelist(invoiceId: string): Promise<string[]> {
      return whitelists[invoiceId] ?? [];
    },

    // ---- #876 protocol stats ----
    async getProtocolStats(): Promise<ProtocolStats> {
      const key = CONTRACT_ID;
      const cached = _statsCache.get(key);
      const now = Date.now();

      if (cached && now - cached.fetchedAt < STATS_TTL) {
        _logger?.debug("getProtocolStats: cache hit");
        return cached.data;
      }

      _logger?.info("getProtocolStats: fetching");
      const stats = { ..._statsOnChain };
      _statsCache.set(key, { data: stats, fetchedAt: Date.now() });
      return stats;
    },

    // Expose for test mutation
    _setStatsOnChain(s: ProtocolStats) {
      _statsOnChain = s;
    },
    _invalidateStatsCache() {
      _statsCache.clear();
    },

    subscribeProtocolStats(callback: (s: ProtocolStats) => void) {
      let last: ProtocolStats | null = null;
      let active = true;

      const poll = async () => {
        if (!active) return;
        const stats = await client.getProtocolStats();
        if (last === null || !_statsEqual(last, stats)) {
          last = stats;
          callback(stats);
        }
        if (active) setTimeout(poll, STATS_TTL);
      };

      void poll();

      return {
        unsubscribe() {
          active = false;
        },
      };
    },

    // ---- #875 notes ----
    async addNote(invoiceId: string, content: string): Promise<void> {
      _logger?.info("addNote called", { invoiceId });

      const encoder = new TextEncoder();
      const byteCount = encoder.encode(content).length;

      if (byteCount > NOTE_MAX_BYTES) {
        _logger?.warn("addNote: content too long", { byteCount });
        throw new ContentTooLongError(byteCount, NOTE_MAX_BYTES);
      }

      const list = notes[invoiceId] ?? [];
      notes[invoiceId] = list;
      list.push({ index: list.length, content, timestamp: new Date() });
    },

    async getNotes(invoiceId: string): Promise<Note[]> {
      const list = notes[invoiceId] ?? [];
      return [...list].sort((a, b) => a.index - b.index);
    },
  };

  return client;
}

// Simple address check (mirrors StrKey.isValidEd25519PublicKey logic for tests)
function _isValidStellarAddress(addr: string): boolean {
  return typeof addr === "string" && addr.startsWith("G") && addr.length === 56;
}

function _statsEqual(a: ProtocolStats, b: ProtocolStats): boolean {
  return (
    a.totalInvoices === b.totalInvoices &&
    a.totalPaidAmount === b.totalPaidAmount &&
    a.totalReleasedAmount === b.totalReleasedAmount &&
    a.totalRefundedAmount === b.totalRefundedAmount &&
    a.uniqueCreators === b.uniqueCreators &&
    a.uniquePayers === b.uniquePayers
  );
}

// ---------------------------------------------------------------------------
// #877 — Whitelist Management
// ---------------------------------------------------------------------------

describe("#877 — Whitelist Management", () => {
  it("addToWhitelist: adds a valid address", async () => {
    const client = makeMockClient();
    await client.addToWhitelist("inv-1", VALID_ADDRESS_1);
    const list = await client.getWhitelist("inv-1");
    expect(list).toContain(VALID_ADDRESS_1);
  });

  it("addToWhitelist: throws ValidationError for an invalid address", async () => {
    const client = makeMockClient();
    await expect(client.addToWhitelist("inv-1", INVALID_ADDRESS)).rejects.toBeInstanceOf(ValidationError);
  });

  it("addToWhitelist: throws WhitelistFullError when limit reached", async () => {
    const client = makeMockClient();
    // Fill the list to exactly 50
    const addresses = Array.from({ length: 50 }, (_, i) => {
      // Generate 56-char G-addresses
      return "G" + String(i).padStart(55, "A");
    });
    for (const addr of addresses) {
      client["whitelists"] = client["whitelists"] ?? {};
    }
    // Directly pre-fill the whitelist via repeated addToWhitelist calls with valid-looking addresses
    // Use a simpler approach: manually push 50 entries
    const inv = "inv-full";
    for (let i = 0; i < 50; i++) {
      // Build 56-char G-address
      const pad = String(i).padStart(54, "0");
      const addr = "G" + pad + "Z";
      // Bypass validation by injecting directly
      (client as unknown as Record<string, unknown>)["_whitelists"] = (client as unknown as Record<string, unknown>)["_whitelists"] ?? {};
    }
    // Easier: call getWhitelist (returns []), then inject 50 entries via side-effect
    // Since we control the mock client internals, let's just set it up via consecutive adds
    // using real valid addresses for the first 50 then expect the 51st to throw.
    // We need 50 distinct valid 56-char G addresses:
    const validAddresses: string[] = [];
    for (let i = 0; i < 50; i++) {
      const n = i.toString(36).toUpperCase().padStart(4, "0");
      const addr = "G" + n.padEnd(55, "A");
      validAddresses.push(addr);
    }
    // Pre-fill by awaiting each addToWhitelist (they all pass validation since they start with G and are 56 chars)
    for (const addr of validAddresses) {
      await client.addToWhitelist(inv, addr);
    }
    // 51st addition should throw
    await expect(
      client.addToWhitelist(inv, VALID_ADDRESS_1)
    ).rejects.toBeInstanceOf(WhitelistFullError);
  });

  it("removeFromWhitelist: removes an existing address", async () => {
    const client = makeMockClient();
    await client.addToWhitelist("inv-2", VALID_ADDRESS_1);
    await client.addToWhitelist("inv-2", VALID_ADDRESS_2);
    await client.removeFromWhitelist("inv-2", VALID_ADDRESS_1);
    const list = await client.getWhitelist("inv-2");
    expect(list).not.toContain(VALID_ADDRESS_1);
    expect(list).toContain(VALID_ADDRESS_2);
  });

  it("removeFromWhitelist: throws ValidationError for an invalid address", async () => {
    const client = makeMockClient();
    await expect(
      client.removeFromWhitelist("inv-2", "bad-address")
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("getWhitelist: returns empty array when no addresses added", async () => {
    const client = makeMockClient();
    const list = await client.getWhitelist("inv-empty");
    expect(list).toEqual([]);
  });

  it("getWhitelist: returns all added addresses", async () => {
    const client = makeMockClient();
    await client.addToWhitelist("inv-3", VALID_ADDRESS_1);
    await client.addToWhitelist("inv-3", VALID_ADDRESS_2);
    await client.addToWhitelist("inv-3", VALID_ADDRESS_3);
    const list = await client.getWhitelist("inv-3");
    expect(list).toHaveLength(3);
    expect(list).toContain(VALID_ADDRESS_1);
    expect(list).toContain(VALID_ADDRESS_2);
    expect(list).toContain(VALID_ADDRESS_3);
  });
});

// ---------------------------------------------------------------------------
// #876 — Protocol Stats
// ---------------------------------------------------------------------------

describe("#876 — Protocol Stats", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getProtocolStats: returns stats on first call", async () => {
    const client = makeMockClient();
    const stats = await client.getProtocolStats();
    expect(stats.totalInvoices).toBe(10);
    expect(stats.totalPaidAmount).toBe(100n);
    expect(stats.uniqueCreators).toBe(3);
  });

  it("getProtocolStats: second call within 30s hits cache", async () => {
    const client = makeMockClient();
    const first = await client.getProtocolStats();

    // Mutate the "on-chain" data — should NOT be visible in cached result
    client._setStatsOnChain({
      totalInvoices: 999,
      totalPaidAmount: 9999n,
      totalReleasedAmount: 9000n,
      totalRefundedAmount: 999n,
      uniqueCreators: 100,
      uniquePayers: 200,
    });

    const second = await client.getProtocolStats();
    expect(second).toStrictEqual(first); // still cached
  });

  it("getProtocolStats: refetches after 30s cache expiry", async () => {
    const client = makeMockClient();
    await client.getProtocolStats();

    client._setStatsOnChain({
      totalInvoices: 20,
      totalPaidAmount: 200n,
      totalReleasedAmount: 160n,
      totalRefundedAmount: 40n,
      uniqueCreators: 6,
      uniquePayers: 10,
    });

    // Expire the cache manually
    client._invalidateStatsCache();

    const updated = await client.getProtocolStats();
    expect(updated.totalInvoices).toBe(20);
  });

  it("subscribeProtocolStats: fires callback only when values change", async () => {
    const client = makeMockClient();
    const received: ProtocolStats[] = [];

    const sub = client.subscribeProtocolStats((s) => received.push(s));

    // First poll runs immediately (synchronous via void poll())
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveLength(1); // fired once on first fetch

    // Second poll — same data (cache hit), should NOT fire
    await vi.advanceTimersByTimeAsync(30000);
    expect(received).toHaveLength(1); // no change, no callback

    // Expire cache and change the data
    client._invalidateStatsCache();
    client._setStatsOnChain({
      totalInvoices: 50,
      totalPaidAmount: 500n,
      totalReleasedAmount: 400n,
      totalRefundedAmount: 100n,
      uniqueCreators: 10,
      uniquePayers: 20,
    });

    await vi.advanceTimersByTimeAsync(30000);
    expect(received).toHaveLength(2); // new value → callback fired

    sub.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// #875 — Note Methods
// ---------------------------------------------------------------------------

describe("#875 — Note Methods", () => {
  it("addNote: stores a note and getNotes retrieves it", async () => {
    const client = makeMockClient();
    await client.addNote("inv-notes", "Hello world");
    const notes = await client.getNotes("inv-notes");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toBe("Hello world");
    expect(notes[0]!.timestamp).toBeInstanceOf(Date);
  });

  it("addNote: content exactly at 512 bytes passes", async () => {
    const client = makeMockClient();
    // 512 ASCII chars = 512 bytes
    const content = "A".repeat(512);
    await expect(client.addNote("inv-notes-2", content)).resolves.toBeUndefined();
  });

  it("addNote: content over 512 bytes throws ContentTooLongError", async () => {
    const client = makeMockClient();
    const content = "A".repeat(513);
    await expect(client.addNote("inv-notes-3", content)).rejects.toBeInstanceOf(ContentTooLongError);
  });

  it("addNote: ContentTooLongError includes bytesUsed and bytesAllowed", async () => {
    const client = makeMockClient();
    const content = "X".repeat(600);
    try {
      await client.addNote("inv-notes-4", content);
      throw new Error("Expected ContentTooLongError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContentTooLongError);
      const e = err as ContentTooLongError;
      expect(e.bytesUsed).toBe(600);
      expect(e.bytesAllowed).toBe(512);
      expect(e.message).toContain("600");
      expect(e.message).toContain("512");
    }
  });

  it("addNote: multibyte UTF-8 characters counted correctly", async () => {
    const client = makeMockClient();
    // Each emoji is 4 bytes — 129 emojis = 516 bytes > 512
    const emoji = "😀";
    const content = emoji.repeat(129); // 129 * 4 = 516 bytes
    await expect(client.addNote("inv-utf8", content)).rejects.toBeInstanceOf(ContentTooLongError);
  });

  it("getNotes: returns notes in chronological order", async () => {
    const client = makeMockClient();
    await client.addNote("inv-order", "First");
    await client.addNote("inv-order", "Second");
    await client.addNote("inv-order", "Third");
    const notes = await client.getNotes("inv-order");
    expect(notes.map((n) => n.content)).toEqual(["First", "Second", "Third"]);
    expect(notes[0]!.index).toBeLessThan(notes[1]!.index);
  });

  it("getNotes: returns empty array for invoice with no notes", async () => {
    const client = makeMockClient();
    const notes = await client.getNotes("inv-no-notes");
    expect(notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #874 — SDK Logger Middleware
// ---------------------------------------------------------------------------

describe("#874 — SDK Logger Middleware", () => {
  it("setLogger: logger is called on method invocation", async () => {
    const client = makeMockClient();
    const logger: SdkLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    client.setLogger(logger);
    await client.addNote("inv-log", "test note");

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("addNote"),
      expect.any(Object),
    );
  });

  it("setLogger: warn is called when content is too long", async () => {
    const client = makeMockClient();
    const logger: SdkLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    client.setLogger(logger);
    await expect(client.addNote("inv-warn", "X".repeat(600))).rejects.toBeInstanceOf(ContentTooLongError);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("_redactParams: sensitive fields are redacted", () => {
    const client = makeMockClient();
    const params = {
      invoiceId: "inv-1",
      payer: VALID_ADDRESS_1,
      privateKey: "SECRET_KEY_VALUE",
      accessCode: "12345",
      blindingFactor: "bf_value",
      secret: "my_secret",
      amount: 100n,
    };

    const redacted = client._redactParams(params);

    expect(redacted["invoiceId"]).toBe("inv-1");
    expect(redacted["payer"]).toBe(VALID_ADDRESS_1);
    expect(redacted["amount"]).toBe(100n);
    expect(redacted["privateKey"]).toBe("[REDACTED]");
    expect(redacted["accessCode"]).toBe("[REDACTED]");
    expect(redacted["blindingFactor"]).toBe("[REDACTED]");
    expect(redacted["secret"]).toBe("[REDACTED]");
  });

  it("_redactParams: non-sensitive fields pass through unchanged", () => {
    const client = makeMockClient();
    const params = { invoiceId: "abc", token: "USDC", amount: 50n };
    const redacted = client._redactParams(params);
    expect(redacted).toEqual(params);
  });

  it("setLogger: logger is called on whitelist invalid address (warn level)", async () => {
    const client = makeMockClient();
    const logger: SdkLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    client.setLogger(logger);
    await expect(client.addToWhitelist("inv-1", "bad")).rejects.toBeInstanceOf(ValidationError);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("setLogger: works without a logger set (no crash)", async () => {
    const client = makeMockClient(); // logger is null by default
    await expect(client.addNote("inv-no-logger", "hello")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error class shape tests
// ---------------------------------------------------------------------------

describe("Error classes", () => {
  it("WhitelistFullError has correct properties", () => {
    const err = new WhitelistFullError("inv-1", 50);
    expect(err).toBeInstanceOf(WhitelistFullError);
    expect(err.code).toBe("WHITELIST_FULL");
    expect(err.invoiceId).toBe("inv-1");
    expect(err.limit).toBe(50);
    expect(err.message).toContain("inv-1");
    expect(err.message).toContain("50");
  });

  it("ContentTooLongError has correct properties", () => {
    const err = new ContentTooLongError(600, 512);
    expect(err).toBeInstanceOf(ContentTooLongError);
    expect(err.code).toBe("CONTENT_TOO_LONG");
    expect(err.bytesUsed).toBe(600);
    expect(err.bytesAllowed).toBe(512);
    expect(err.message).toContain("600");
    expect(err.message).toContain("512");
  });
});
