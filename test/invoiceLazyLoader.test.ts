import { describe, it, expect, vi, beforeEach } from "vitest";
import { InvoiceLazyLoader, createLazyInvoiceProxy } from "../src/invoiceLazyLoader.js";

describe("InvoiceLazyLoader", () => {
  let fetchFn: ReturnType<typeof vi.fn>;
  let loader: InvoiceLazyLoader<{ id: string; amount: number }>;

  beforeEach(() => {
    fetchFn = vi.fn(async (key: string) => ({ id: key, amount: 100 }));
    loader = new InvoiceLazyLoader(fetchFn, { ttlMs: 500 });
  });

  it("loads and caches items", async () => {
    const result = await loader.load("inv-1");
    expect(result).toEqual({ id: "inv-1", amount: 100 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await loader.load("inv-1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("emits cache_hit event on cache hits", async () => {
    const events: string[] = [];
    loader.on((e) => events.push(e.type));
    await loader.load("inv-1");
    await loader.load("inv-1");
    expect(events).toContain("cache_hit");
  });

  it("loadAll returns a map of results", async () => {
    const map = await loader.loadAll(["inv-1", "inv-2"]);
    expect(map.size).toBe(2);
    expect(map.get("inv-1")).toEqual({ id: "inv-1", amount: 100 });
  });

  it("invalidate removes item from cache", async () => {
    await loader.load("inv-1");
    loader.invalidate("inv-1");
    await loader.load("inv-1");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("evicts LRU when maxSize exceeded", async () => {
    const small = new InvoiceLazyLoader(fetchFn, { maxSize: 2 });
    await small.load("a");
    await small.load("b");
    await small.load("c");
    expect(small.size).toBeLessThanOrEqual(2);
  });

  it("createLazyInvoiceProxy works with factory function", async () => {
    let called = 0;
    const proxy = createLazyInvoiceProxy(async () => { called++; return { id: "x", amount: 50 }; });
    const r = await proxy.load("any");
    expect(r.amount).toBe(50);
    expect(called).toBe(1);
  });
});
