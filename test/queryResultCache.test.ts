import { describe, it, expect, vi } from "vitest";
import { QueryResultCache, buildCacheKey } from "../src/queryResultCache.js";

describe("QueryResultCache", () => {
  it("caches and returns results on subsequent calls", async () => {
    const cache = new QueryResultCache();
    const fetcher = vi.fn(async () => ({ data: "result" }));
    await cache.wrap("getInvoice", { id: "1" }, fetcher);
    await cache.wrap("getInvoice", { id: "1" }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses per-query TTL from queryTtlMap", async () => {
    const cache = new QueryResultCache({ queryTtlMap: { fast: 1 }, defaultTtlMs: 60000 });
    const fetcher = vi.fn(async () => "value");
    await cache.wrap("fast", {}, fetcher);
    await new Promise((r) => setTimeout(r, 10));
    await cache.wrap("fast", {}, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("invalidateOnMutation removes entries for specified queries", async () => {
    const cache = new QueryResultCache();
    const fetcher = vi.fn(async () => "v");
    await cache.wrap("listInvoices", { page: 1 }, fetcher);
    cache.invalidateOnMutation(["listInvoices"]);
    await cache.wrap("listInvoices", { page: 1 }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports correct metrics", async () => {
    const cache = new QueryResultCache();
    const fetcher = vi.fn(async () => 42);
    await cache.wrap("q", { a: 1 }, fetcher);
    await cache.wrap("q", { a: 1 }, fetcher);
    const metrics = cache.getMetrics();
    expect(metrics.hits).toBe(1);
    expect(metrics.misses).toBe(1);
    expect(metrics.hitRate).toBe(0.5);
  });

  it("buildCacheKey produces stable keys regardless of param order", () => {
    const k1 = buildCacheKey("q", { b: 2, a: 1 });
    const k2 = buildCacheKey("q", { a: 1, b: 2 });
    expect(k1).toBe(k2);
  });

  it("invalidateNamespace removes matching prefix entries", async () => {
    const cache = new QueryResultCache();
    await cache.wrap("invoice:list", {}, async () => []);
    await cache.wrap("invoice:get", { id: "1" }, async () => ({}));
    await cache.wrap("payment:list", {}, async () => []);
    cache.invalidateNamespace("invoice:");
    const metrics = cache.getMetrics();
    expect(metrics.size).toBe(1);
  });
});
