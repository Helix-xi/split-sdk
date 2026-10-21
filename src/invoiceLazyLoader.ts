/**
 * Lazy loading for invoices with LRU cache and progress events.
 * Issue #1134
 */

import { EventEmitter } from "node:events";

export type LazyLoadEventType = "loading" | "loaded" | "error" | "cache_hit";

export interface LazyLoadEvent<T> {
  type: LazyLoadEventType;
  key: string;
  value?: T;
  error?: Error;
  durationMs?: number;
}

export type LazyLoadListener<T> = (event: LazyLoadEvent<T>) => void;

export interface InvoiceLazyLoaderOptions {
  /** Max items in LRU cache. Default: 100 */
  maxSize?: number;
  /** TTL in milliseconds. Default: 60000 (1 min) */
  ttlMs?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  lastUsed: number;
}

/**
 * Lazy loader with LRU cache for invoice data.
 */
export class InvoiceLazyLoader<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private pending = new Map<string, Promise<T>>();
  private emitter = new EventEmitter();
  private maxSize: number;
  private ttlMs: number;

  constructor(private fetchFn: (key: string) => Promise<T>, options: InvoiceLazyLoaderOptions = {}) {
    this.maxSize = options.maxSize ?? 100;
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  /** Load a single item by key, using cache if available. */
  async load(key: string): Promise<T> {
    const cached = this.getFromCache(key);
    if (cached !== undefined) {
      this.emit({ type: "cache_hit", key, value: cached });
      return cached;
    }

    // Coalesce concurrent requests for the same key
    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    this.emit({ type: "loading", key });
    const start = Date.now();

    const promise = this.fetchFn(key)
      .then((value) => {
        this.setCache(key, value);
        this.emit({ type: "loaded", key, value, durationMs: Date.now() - start });
        this.pending.delete(key);
        return value;
      })
      .catch((err: Error) => {
        this.emit({ type: "error", key, error: err });
        this.pending.delete(key);
        throw err;
      });

    this.pending.set(key, promise);
    return promise;
  }

  /** Load multiple items in parallel. */
  async loadAll(keys: string[]): Promise<Map<string, T>> {
    const results = await Promise.allSettled(keys.map((k) => this.load(k).then((v) => [k, v] as [string, T])));
    const map = new Map<string, T>();
    for (const r of results) {
      if (r.status === "fulfilled") map.set(r.value[0], r.value[1]);
    }
    return map;
  }

  /** Pre-warm cache for a set of keys in the background. */
  preload(keys: string[]): void {
    for (const key of keys) {
      if (!this.getFromCache(key)) this.load(key).catch(() => {});
    }
  }

  /** Invalidate a cache entry. */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /** Clear all cache entries. */
  clear(): void {
    this.cache.clear();
  }

  on(listener: LazyLoadListener<T>): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  get size(): number { return this.cache.size; }

  private getFromCache(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    entry.lastUsed = Date.now();
    return entry.value;
  }

  private setCache(key: string, value: T): void {
    if (this.cache.size >= this.maxSize) this.evictLRU();
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs, lastUsed: Date.now() });
  }

  private evictLRU(): void {
    let oldest: [string, CacheEntry<T>] | null = null;
    for (const entry of this.cache.entries()) {
      if (!oldest || entry[1].lastUsed < oldest[1].lastUsed) oldest = entry;
    }
    if (oldest) this.cache.delete(oldest[0]);
  }

  private emit(event: LazyLoadEvent<T>): void {
    this.emitter.emit("event", event);
  }
}

/** Factory function to create a lazy-loading proxy for a single invoice. */
export function createLazyInvoiceProxy<T>(
  fetchFn: () => Promise<T>,
  options?: InvoiceLazyLoaderOptions
): InvoiceLazyLoader<T> {
  return new InvoiceLazyLoader<T>(() => fetchFn(), options);
}
