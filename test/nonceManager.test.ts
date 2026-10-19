import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  NonceManager,
  InvalidNonceError,
  DuplicateNonceError,
  StaleNonceError,
  NonceGapError,
  type NonceEvent,
} from "../src/nonceManager.js";

const ACCOUNT_A = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const ACCOUNT_B = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

describe("NonceManager", () => {
  let manager: NonceManager;

  beforeEach(() => {
    manager = new NonceManager();
  });

  describe("Nonce tracking", () => {
    it("tracks new accounts with default initial nonce 0n", () => {
      const state = manager.trackAccount(ACCOUNT_A);
      expect(state.accountId).toBe(ACCOUNT_A);
      expect(state.currentNonce).toBe(0n);
      expect(manager.getNonce(ACCOUNT_A)).toBe(0n);
      expect(manager.hasAccount(ACCOUNT_A)).toBe(true);
      expect(manager.size).toBe(1);
    });

    it("tracks accounts with specified initial nonce", () => {
      manager.trackAccount(ACCOUNT_A, 42n);
      expect(manager.getNonce(ACCOUNT_A)).toBe(42n);
    });

    it("tracks multiple accounts independently", () => {
      manager.trackAccount(ACCOUNT_A, 10n);
      manager.trackAccount(ACCOUNT_B, 100n);

      expect(manager.getNonce(ACCOUNT_A)).toBe(10n);
      expect(manager.getNonce(ACCOUNT_B)).toBe(100n);
      expect(manager.size).toBe(2);
    });

    it("does not overwrite existing account state on re-tracking", () => {
      manager.trackAccount(ACCOUNT_A, 5n);
      manager.acquireNextNonce(ACCOUNT_A); // becomes 6n
      manager.trackAccount(ACCOUNT_A, 99n); // should keep existing
      expect(manager.getNonce(ACCOUNT_A)).toBe(6n);
    });

    it("rejects invalid accountId", () => {
      expect(() => manager.trackAccount("")).toThrow(InvalidNonceError);
    });

    it("clears all tracking data on clear()", () => {
      manager.trackAccount(ACCOUNT_A);
      manager.trackAccount(ACCOUNT_B);
      manager.clear();
      expect(manager.size).toBe(0);
      expect(manager.hasAccount(ACCOUNT_A)).toBe(false);
    });
  });

  describe("Auto-increment", () => {
    it("auto-increments sequentially on acquireNextNonce", () => {
      manager.trackAccount(ACCOUNT_A, 1n);

      const n1 = manager.acquireNextNonce(ACCOUNT_A);
      expect(n1).toBe(1n);
      expect(manager.getNonce(ACCOUNT_A)).toBe(2n);

      const n2 = manager.acquireNextNonce(ACCOUNT_A);
      expect(n2).toBe(2n);
      expect(manager.getNonce(ACCOUNT_A)).toBe(3n);

      const n3 = manager.consumeNonce(ACCOUNT_A);
      expect(n3).toBe(3n);
      expect(manager.getNonce(ACCOUNT_A)).toBe(4n);
    });

    it("peekNextNonce returns next value without incrementing", () => {
      manager.trackAccount(ACCOUNT_A, 10n);

      expect(manager.peekNextNonce(ACCOUNT_A)).toBe(10n);
      expect(manager.getNonce(ACCOUNT_A)).toBe(10n);

      const acquired = manager.acquireNextNonce(ACCOUNT_A);
      expect(acquired).toBe(10n);
      expect(manager.peekNextNonce(ACCOUNT_A)).toBe(11n);
    });

    it("tracks in-flight nonces until committed or rolled back", () => {
      manager.trackAccount(ACCOUNT_A, 0n);
      manager.acquireNextNonce(ACCOUNT_A); // 0n
      manager.acquireNextNonce(ACCOUNT_A); // 1n

      const state = manager.getNonceState(ACCOUNT_A);
      expect(state.inFlightNonces).toEqual([0n, 1n]);

      manager.commitNonce(ACCOUNT_A, 0n);
      expect(manager.getNonceState(ACCOUNT_A).inFlightNonces).toEqual([1n]);

      manager.rollbackNonce(ACCOUNT_A, 1n);
      expect(manager.getNonceState(ACCOUNT_A).inFlightNonces).toEqual([]);
      // Rolled back last acquired nonce should step counter back
      expect(manager.getNonce(ACCOUNT_A)).toBe(1n);
    });

    it("supports custom increment step", () => {
      const customManager = new NonceManager({ incrementStep: 5n });
      customManager.trackAccount(ACCOUNT_A, 10n);

      const n1 = customManager.acquireNextNonce(ACCOUNT_A);
      expect(n1).toBe(10n);
      expect(customManager.getNonce(ACCOUNT_A)).toBe(15n);
    });
  });

  describe("Resets handled", () => {
    it("resets nonce to zero by default", () => {
      manager.trackAccount(ACCOUNT_A, 100n);
      manager.resetNonce(ACCOUNT_A);
      expect(manager.getNonce(ACCOUNT_A)).toBe(0n);
    });

    it("resets nonce to a specific value with bigint", () => {
      manager.trackAccount(ACCOUNT_A, 10n);
      manager.resetNonce(ACCOUNT_A, 500n);
      expect(manager.getNonce(ACCOUNT_A)).toBe(500n);
    });

    it("resets nonce with options including reason and clearing replay", () => {
      manager.trackAccount(ACCOUNT_A, 10n);
      manager.commitNonce(ACCOUNT_A, 5n);

      manager.resetNonce(ACCOUNT_A, {
        newNonce: 20n,
        reason: "reorg",
        clearReplayHistory: true,
      });

      expect(manager.getNonce(ACCOUNT_A)).toBe(20n);
    });

    it("rejects resetting to negative values", () => {
      manager.trackAccount(ACCOUNT_A);
      expect(() => manager.resetNonce(ACCOUNT_A, -1n)).toThrow(InvalidNonceError);
    });

    it("syncNonce loads on-chain sequence and resets state", async () => {
      manager.trackAccount(ACCOUNT_A, 5n);

      const mockOnChainFetcher = vi.fn().mockResolvedValue(12345n);
      const synced = await manager.syncNonce(ACCOUNT_A, mockOnChainFetcher);

      expect(synced).toBe(12345n);
      expect(manager.getNonce(ACCOUNT_A)).toBe(12345n);
      expect(mockOnChainFetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe("Validation before send", () => {
    it("validates valid next nonce successfully", () => {
      manager.trackAccount(ACCOUNT_A, 10n);
      expect(() => manager.validateBeforeSend(ACCOUNT_A, 10n)).not.toThrow();
    });

    it("accepts string and number inputs that represent non-negative integers", () => {
      manager.trackAccount(ACCOUNT_A, 5n);
      expect(() => manager.validateBeforeSend(ACCOUNT_A, "5")).not.toThrow();
      expect(() => manager.validateBeforeSend(ACCOUNT_A, 5)).not.toThrow();
    });

    it("detects replay attack when a committed nonce is reused", () => {
      manager.trackAccount(ACCOUNT_A, 1n);
      manager.commitNonce(ACCOUNT_A, 1n);

      expect(() => manager.validateBeforeSend(ACCOUNT_A, 1n)).toThrow(DuplicateNonceError);
    });

    it("detects stale nonce that is lower than current expected", () => {
      manager.trackAccount(ACCOUNT_A, 10n);
      expect(() => manager.validateBeforeSend(ACCOUNT_A, 8n)).toThrow(StaleNonceError);
    });

    it("allows in-flight nonces that are below current counter", () => {
      manager.trackAccount(ACCOUNT_A, 10n);
      const n1 = manager.acquireNextNonce(ACCOUNT_A); // 10n, counter is 11n
      // n1 (10n) is in-flight, so validateBeforeSend should allow it
      expect(() => manager.validateBeforeSend(ACCOUNT_A, n1)).not.toThrow();
    });

    it("detects nonce gap when strict ordering is enabled", () => {
      manager.trackAccount(ACCOUNT_A, 5n);
      expect(() => manager.validateBeforeSend(ACCOUNT_A, 10n)).toThrow(NonceGapError);
    });

    it("allows nonce gap when strict ordering is disabled", () => {
      manager.trackAccount(ACCOUNT_A, 5n);
      expect(() => manager.validateBeforeSend(ACCOUNT_A, 10n, { strictOrdering: false })).not.toThrow();
    });

    it("rejects negative or malformed nonces", () => {
      manager.trackAccount(ACCOUNT_A, 0n);
      expect(() => manager.validateBeforeSend(ACCOUNT_A, -5n)).toThrow(InvalidNonceError);
      expect(() => manager.validateBeforeSend(ACCOUNT_A, 3.14)).toThrow(InvalidNonceError);
      expect(() => manager.validateBeforeSend(ACCOUNT_A, "abc")).toThrow(InvalidNonceError);
    });

    it("returns validation object without throwing when using validate()", () => {
      manager.trackAccount(ACCOUNT_A, 10n);
      const ok = manager.validate(ACCOUNT_A, 10n);
      expect(ok.valid).toBe(true);

      const bad = manager.validate(ACCOUNT_A, 2n);
      expect(bad.valid).toBe(false);
      expect(bad.error).toContain("Stale nonce");
    });
  });

  describe("Events", () => {
    it("emits events on acquire, commit, rollback, reset, and validation failure", () => {
      const events: NonceEvent[] = [];
      const unsub = manager.onEvent((e) => events.push(e));

      manager.trackAccount(ACCOUNT_A, 1n);
      manager.acquireNextNonce(ACCOUNT_A); // acquired
      manager.rollbackNonce(ACCOUNT_A, 1n); // rolled_back
      manager.acquireNextNonce(ACCOUNT_A); // acquired
      manager.commitNonce(ACCOUNT_A, 1n); // committed
      manager.resetNonce(ACCOUNT_A, 10n); // reset

      try {
        manager.validateBeforeSend(ACCOUNT_A, 1n); // fails (duplicate/stale)
      } catch {
        // expected
      }

      const types = events.map((e) => e.type);
      expect(types).toContain("nonce:acquired");
      expect(types).toContain("nonce:rolled_back");
      expect(types).toContain("nonce:committed");
      expect(types).toContain("nonce:reset");
      expect(types).toContain("nonce:validation_failed");

      unsub();
      manager.resetNonce(ACCOUNT_A, 0n);
      expect(events.length).toBe(6); // unsubscribed, no new events added
    });
  });
});
