import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ContractAbiCache,
  StaticContractAbiFetcher,
  MemoryAbiStorage,
  AdapterAbiStorage,
} from "../src/abiCache.js";
import type { ContractAbi } from "../src/abiCache.js";
import { MemoryStorageAdapter } from "../src/storage/storageAdapter.js";
import { AbiNotFoundError } from "../src/errors.js";

const CONTRACT_A = "CA1111111111111111111111111111111111111111111111111111111111";
const CONTRACT_B = "CB2222222222222222222222222222222222222222222222222222222222";

function sampleAbi(contractId: string, overrides: Partial<ContractAbi> = {}): ContractAbi {
  return {
    contractId,
    wasmHash: "wasm-hash-abc123",
    functions: [
      {
        name: "split_payment",
        doc: "Splits incoming payments across recipients",
        inputs: [{ name: "invoice_id", type: "u64", doc: "Invoice ID" }],
        outputs: [{ type: "bool", doc: "True on success" }],
      },
    ],
    types: [
      {
        name: "InvoiceInfo",
        kind: "struct",
        doc: "Invoice record struct",
        fields: [{ name: "id", type: "u64" }],
      },
    ],
    fetchedAt: Date.now(),
    ...overrides,
  };
}

describe("Smart Contract ABI Caching (#1054)", () => {
  let fetcher: StaticContractAbiFetcher;

  beforeEach(() => {
    fetcher = new StaticContractAbiFetcher();
    fetcher.registerAbi(CONTRACT_A, sampleAbi(CONTRACT_A));
    fetcher.registerAbi(CONTRACT_B, sampleAbi(CONTRACT_B, { wasmHash: "wasm-hash-xyz" }));
  });

  describe("Caching works", () => {
    it("fetches and caches on first call, returns from cache on second call", async () => {
      const fetchSpy = vi.fn(async (id: string) => fetcher.fetchAbi(id));
      const cache = new ContractAbiCache({ fetcher: fetchSpy });

      const abi1 = await cache.get(CONTRACT_A);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(abi1.contractId).toBe(CONTRACT_A);

      const abi2 = await cache.get(CONTRACT_A);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // Cached! No 2nd fetch
      expect(abi2).toEqual(abi1);

      const stats = await cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe(0.5);
    });

    it("throws AbiNotFoundError when contract is not registered and not in cache", async () => {
      const cache = new ContractAbiCache({ fetcher });
      await expect(cache.get("UNKNOWN_CONTRACT")).rejects.toThrow(AbiNotFoundError);
    });
  });

  describe("Performance improved", () => {
    it("shows substantial speedup between cache miss and cache hit", async () => {
      // Simulate network latency in fetcher
      const slowFetcher = async (id: string) => {
        await new Promise((r) => setTimeout(r, 20));
        return sampleAbi(id);
      };

      const cache = new ContractAbiCache({ fetcher: slowFetcher });

      const t0 = performance.now();
      await cache.get(CONTRACT_A);
      const missDuration = performance.now() - t0;

      const t1 = performance.now();
      await cache.get(CONTRACT_A);
      const hitDuration = performance.now() - t1;

      expect(missDuration).toBeGreaterThan(15);
      expect(hitDuration).toBeLessThan(10);
      expect(missDuration).toBeGreaterThan(hitDuration * 2);
    });
  });

  describe("Invalidation sound", () => {
    it("invalidates specific contract entry", async () => {
      const fetchSpy = vi.fn(async (id: string) => fetcher.fetchAbi(id));
      const cache = new ContractAbiCache({ fetcher: fetchSpy });

      await cache.get(CONTRACT_A);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const invalidated = await cache.invalidate(CONTRACT_A);
      expect(invalidated).toBe(true);

      expect(await cache.has(CONTRACT_A)).toBe(false);

      await cache.get(CONTRACT_A);
      expect(fetchSpy).toHaveBeenCalledTimes(2); // Re-fetched
    });

    it("invalidates contracts by WASM hash", async () => {
      const cache = new ContractAbiCache({ fetcher });
      await cache.get(CONTRACT_A);
      await cache.get(CONTRACT_B);

      const removed = await cache.invalidateByWasmHash("wasm-hash-abc123");
      expect(removed).toBe(1);
      expect(await cache.has(CONTRACT_A)).toBe(false);
      expect(await cache.has(CONTRACT_B)).toBe(true);
    });

    it("invalidates expired entries based on TTL", async () => {
      const cache = new ContractAbiCache({ fetcher, ttlMs: 10 });
      await cache.get(CONTRACT_A);

      await new Promise((r) => setTimeout(r, 20));
      expect(await cache.has(CONTRACT_A)).toBe(false);

      const purged = await cache.invalidateExpired();
      expect(purged).toBe(1);
    });

    it("supports clearing all cached entries", async () => {
      const cache = new ContractAbiCache({ fetcher });
      await cache.get(CONTRACT_A);
      await cache.get(CONTRACT_B);

      await cache.clear();
      const stats = await cache.getStats();
      expect(stats.entryCount).toBe(0);
      expect(await cache.has(CONTRACT_A)).toBe(false);
    });
  });

  describe("Storage efficient", () => {
    it("strips comments in compact mode to reduce storage footprint", async () => {
      const normalCache = new ContractAbiCache({ fetcher, compact: false });
      const compactCache = new ContractAbiCache({ fetcher, compact: true });

      const normalAbi = await normalCache.get(CONTRACT_A);
      const compactAbi = await compactCache.get(CONTRACT_A);

      expect(normalAbi.functions[0]!.doc).toBeDefined();
      expect(compactAbi.functions[0]!.doc).toBeUndefined();

      const normalStats = await normalCache.getStats();
      const compactStats = await compactCache.getStats();
      expect(compactStats.storageBytes).toBeLessThan(normalStats.storageBytes);
    });

    it("evicts least recently used items when capacity is reached", async () => {
      const storage = new MemoryAbiStorage({ maxEntries: 2 });
      const cache = new ContractAbiCache({ fetcher, storage });

      const CONTRACT_C = "CC33333333333333333333333333333333333333333333333333333333";
      fetcher.registerAbi(CONTRACT_C, sampleAbi(CONTRACT_C));

      await cache.get(CONTRACT_A);
      await cache.get(CONTRACT_B);
      // Access A again to make B the oldest
      await cache.get(CONTRACT_A);

      // Add C, which should evict B
      await cache.get(CONTRACT_C);

      expect(await cache.has(CONTRACT_A)).toBe(true);
      expect(await cache.has(CONTRACT_C)).toBe(true);
      expect(await cache.has(CONTRACT_B)).toBe(false);

      const stats = await cache.getStats();
      expect(stats.evictions).toBe(1);
    });

    it("works with AdapterAbiStorage backed by Web Storage / MemoryStorageAdapter", async () => {
      const adapter = new MemoryStorageAdapter();
      const storage = new AdapterAbiStorage(adapter);
      const cache = new ContractAbiCache({ fetcher, storage });

      await cache.get(CONTRACT_A);
      expect(await cache.has(CONTRACT_A)).toBe(true);
      expect(await cache.get(CONTRACT_A)).toBeDefined();
    });
  });
});
