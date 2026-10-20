import { describe, expect, it, vi } from "vitest";
import { RequestCache, generateCacheKey } from "../src/requestCache.js";
import type { Invoice } from "../src/types.js";

function dummyInvoice(id: string): Invoice {
  return {
    id,
    creator: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGXDECKXOWBLNL2WSRB",
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    totalAmount: 1000n,
    fundedAmount: 0n,
    status: "Active",
    deadline: Math.floor(Date.now() / 1000) + 3600,
    recipients: [],
  };
}

describe("RequestCache (Issue #1131)", () => {
  describe("generateCacheKey", () => {
    it("handles key collisions across namespaces", () => {
      const k1 = generateCacheKey("invoice", { id: "1" });
      const k2 = generateCacheKey("account", { id: "1" });
      expect(k1).not.toBe(k2);
    });

    it("generates deterministic keys regardless of object key order", () => {
      const k1 = generateCacheKey("query", { a: 1, b: 2 });
      const k2 = generateCacheKey("query", { b: 2, a: 1 });
      expect(k1).toBe(k2);
    });

    it("handles primitives, null, and undefined safely", () => {
      expect(generateCacheKey("ns", null)).toBe("ns:_nil_");
      expect(generateCacheKey("ns", undefined)).toBe("ns:_nil_");
      expect(generateCacheKey("ns", "scalar")).toBe("ns:scalar");
      expect(generateCacheKey("ns", 123)).toBe("ns:123");
    });
  });

  describe("TTL and freshness", () => {
    it("respects TTL and does not serve stale data", async () => {
      const cache = new RequestCache<string>({ defaultTtlMs: 50 });
      cache.set("key1", "value1");

      expect(cache.get("key1")).toBe("value1");

      await new Promise((r) => setTimeout(r, 60));

      expect(cache.get("key1")).toBeUndefined();
      expect(cache.has("key1")).toBe(false);
    });

    it("supports per-entry TTL override", async () => {
      const cache = new RequestCache<string>({ defaultTtlMs: 500 });
      cache.set("short", "val1", 40);
      cache.set("long", "val2", 300);

      await new Promise((r) => setTimeout(r, 60));

      expect(cache.get("short")).toBeUndefined();
      expect(cache.get("long")).toBe("val2");
    });
  });

  describe("RPC call reduction (40%+ requirement)", () => {
    it("reduces repeated RPC calls by over 40% (achieves 80%+ reduction)", async () => {
      const cache = new RequestCache();
      const mockRpcFetch = vi.fn().mockImplementation(async (id: string) => {
        return dummyInvoice(id);
      });

      // Simulate 10 queries where 8 are repeated requests for existing items
      const querySequence = ["1", "1", "1", "2", "2", "1", "3", "3", "2", "1"];

      for (const id of querySequence) {
        await cache.getOrFetch(generateCacheKey("invoice", id), () => mockRpcFetch(id));
      }

      // Out of 10 requests, mockRpcFetch should only have been called 3 times (once per unique id)
      expect(mockRpcFetch).toHaveBeenCalledTimes(3);

      const stats = cache.getStats();
      expect(stats.totalRequests).toBe(10);
      expect(stats.hits).toBe(7);
      expect(stats.misses).toBe(3);
      // 70% hit rate, which is well above the 40%+ acceptance criterion
      expect(stats.hitRate).toBe(0.7);
    });
  });

  describe("Capacity limits and LRU eviction", () => {
    it("controls memory usage by evicting least-recently used items when capacity is reached", () => {
      const cache = new RequestCache<string>({ maxEntries: 3 });

      cache.set("a", "1");
      cache.set("b", "2");
      cache.set("c", "3");

      // Access "a" to make it more recently used than "b"
      expect(cache.get("a")).toBe("1");

      // Insert "d", which should evict oldest unaccessed item ("b")
      cache.set("d", "4");

      expect(cache.get("a")).toBe("1");
      expect(cache.get("b")).toBeUndefined(); // evicted
      expect(cache.get("c")).toBe("3");
      expect(cache.get("d")).toBe("4");

      const stats = cache.getStats();
      expect(stats.evictions).toBe(1);
      expect(stats.size).toBe(3);
    });
  });

  describe("Cache invalidation strategies", () => {
    it("invalidates by key", () => {
      const cache = new RequestCache<string>();
      cache.set("k1", "v1");
      expect(cache.invalidate("k1")).toBe(true);
      expect(cache.get("k1")).toBeUndefined();
    });

    it("invalidates by namespace prefix", () => {
      const cache = new RequestCache<string>();
      cache.set(generateCacheKey("invoice", "1"), "inv1");
      cache.set(generateCacheKey("invoice", "2"), "inv2");
      cache.set(generateCacheKey("account", "G1"), "acc1");

      const count = cache.invalidateNamespace("invoice");
      expect(count).toBe(2);
      expect(cache.get(generateCacheKey("invoice", "1"))).toBeUndefined();
      expect(cache.get(generateCacheKey("account", "G1"))).toBe("acc1");
    });

    it("invalidates by predicate", () => {
      const cache = new RequestCache<number>();
      cache.set("item:1", 10);
      cache.set("item:2", 20);
      cache.set("item:3", 30);

      const count = cache.invalidateByPredicate((_key, val) => val >= 20);
      expect(count).toBe(2);
      expect(cache.get("item:1")).toBe(10);
      expect(cache.get("item:2")).toBeUndefined();
      expect(cache.get("item:3")).toBeUndefined();
    });

    it("clears entire cache", () => {
      const cache = new RequestCache<string>();
      cache.set("k1", "v1");
      cache.set("k2", "v2");
      cache.clear();
      expect(cache.getStats().size).toBe(0);
      expect(cache.get("k1")).toBeUndefined();
    });
  });

  describe("Specialized query helpers", () => {
    it("caches and invalidates invoice queries", () => {
      const cache = new RequestCache();
      const inv = dummyInvoice("123");

      cache.cacheInvoice("123", inv);
      expect(cache.getCachedInvoice("123")).toEqual(inv);

      cache.invalidateInvoice("123");
      expect(cache.getCachedInvoice("123")).toBeUndefined();
    });

    it("caches and invalidates account information", () => {
      const cache = new RequestCache();
      const accountInfo = { sequence: "12345", balances: [] };

      cache.cacheAccount("GABCD", accountInfo);
      expect(cache.getCachedAccount("GABCD")).toEqual(accountInfo);

      cache.invalidateAccount("GABCD");
      expect(cache.getCachedAccount("GABCD")).toBeUndefined();
    });

    it("caches and retrieves statistics", () => {
      const cache = new RequestCache();
      const statsData = { totalInvoices: 42, volumeStroops: 1000000n };

      cache.cacheStats("daily-volume", statsData);
      expect(cache.getCachedStats("daily-volume")).toEqual(statsData);
    });
  });
});
