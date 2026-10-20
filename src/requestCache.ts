/**
 * Intelligent in-memory request caching layer with TTL support,
 * LRU eviction, and metrics for StellarSplit SDK.
 */

import type { Invoice } from "./types.js";

export interface CacheStats {
  hits: number;
  misses: number;
  totalRequests: number;
  hitRate: number;
  size: number;
  maxEntries: number;
  evictions: number;
  invalidations: number;
}

export interface RequestCacheOptions {
  /** Default time-to-live in milliseconds for cached entries (default: 60_000). */
  defaultTtlMs?: number;
  /** Maximum number of entries to retain before evicting least-recently used items (default: 1_000). */
  maxEntries?: number;
}

interface CacheItem<T> {
  value: T;
  expiresAt: number;
}

/**
 * Generate a deterministic, collision-resistant cache key.
 *
 * Parameters are sorted recursively so that parameter order does not alter
 * the generated key.
 */
export function generateCacheKey(
  namespace: string,
  params?: Record<string, unknown> | string | number | boolean | null
): string {
  if (params === undefined || params === null) {
    return `${namespace}:_nil_`;
  }

  if (typeof params !== "object") {
    return `${namespace}:${String(params)}`;
  }

  const serialize = (obj: unknown): string => {
    if (obj === null || typeof obj !== "object") {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return `[${obj.map(serialize).join(",")}]`;
    }
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${serialize((obj as Record<string, unknown>)[k])}`
    );
    return `{${parts.join(",")}}`;
  };

  return `${namespace}:${serialize(params)}`;
}

/**
 * Intelligent in-memory request cache supporting TTL expiration,
 * LRU eviction, namespace invalidation, and metrics collection.
 */
export class RequestCache<T = unknown> {
  private readonly store = new Map<string, CacheItem<T>>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private invalidations = 0;

  constructor(options: RequestCacheOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 1_000;
  }

  /**
   * Retrieve a value from the cache.
   * Updates LRU ordering if present and unexpired.
   */
  get(key: string): T | undefined {
    const item = this.store.get(key);
    if (!item) {
      this.misses++;
      return undefined;
    }

    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }

    // Refresh LRU order by re-inserting
    this.store.delete(key);
    this.store.set(key, item);
    this.hits++;
    return item.value;
  }

  /**
   * Store a value in the cache with an optional custom TTL.
   */
  set(key: string, value: T, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = Date.now() + ttl;

    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      // Evict least-recently used entry (first entry in Map iteration order)
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
        this.evictions++;
      }
    }

    this.store.set(key, { value, expiresAt });
  }

  /** Check if a valid, unexpired entry exists without updating LRU or hit/miss metrics. */
  has(key: string): boolean {
    const item = this.store.get(key);
    if (!item) return false;
    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Fetch a value from cache, or invoke the fetch function on cache miss
   * and store the result.
   */
  async getOrFetch<R extends T>(
    key: string,
    fetchFn: () => Promise<R>,
    ttlMs?: number
  ): Promise<R> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached as R;
    }

    const fresh = await fetchFn();
    this.set(key, fresh, ttlMs);
    return fresh;
  }

  /** Remove a specific key. */
  invalidate(key: string): boolean {
    const deleted = this.store.delete(key);
    if (deleted) {
      this.invalidations++;
    }
    return deleted;
  }

  /** Invalidate all entries starting with a namespace prefix. */
  invalidateNamespace(namespace: string): number {
    const prefix = `${namespace}:`;
    let count = 0;
    for (const key of Array.from(this.store.keys())) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        count++;
      }
    }
    this.invalidations += count;
    return count;
  }

  /** Invalidate entries matching a predicate function. */
  invalidateByPredicate(predicate: (key: string, value: T) => boolean): number {
    let count = 0;
    for (const [key, item] of Array.from(this.store.entries())) {
      if (predicate(key, item.value)) {
        this.store.delete(key);
        count++;
      }
    }
    this.invalidations += count;
    return count;
  }

  /** Clear all entries in the cache. */
  clear(): void {
    const size = this.store.size;
    this.store.clear();
    this.invalidations += size;
  }

  /** Get live cache performance and size metrics. */
  getStats(): CacheStats {
    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests === 0 ? 0 : this.hits / totalRequests;
    return {
      hits: this.hits,
      misses: this.misses,
      totalRequests,
      hitRate,
      size: this.store.size,
      maxEntries: this.maxEntries,
      evictions: this.evictions,
      invalidations: this.invalidations,
    };
  }

  /** Reset hit, miss, eviction, and invalidation counters. */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.invalidations = 0;
  }

  // ── Specialized domain helpers ──────────────────────────────────────────

  /** Cache an invoice query result. */
  cacheInvoice(invoiceId: string, invoice: Invoice, ttlMs?: number): void {
    this.set(generateCacheKey("invoice", { id: invoiceId }), invoice as unknown as T, ttlMs);
  }

  /** Retrieve a cached invoice if present. */
  getCachedInvoice(invoiceId: string): Invoice | undefined {
    return this.get(generateCacheKey("invoice", { id: invoiceId })) as unknown as Invoice | undefined;
  }

  /** Invalidate a specific cached invoice. */
  invalidateInvoice(invoiceId: string): boolean {
    return this.invalidate(generateCacheKey("invoice", { id: invoiceId }));
  }

  /** Cache user account information. */
  cacheAccount(address: string, accountInfo: unknown, ttlMs?: number): void {
    this.set(generateCacheKey("account", { address }), accountInfo as T, ttlMs);
  }

  /** Retrieve cached user account information. */
  getCachedAccount(address: string): unknown | undefined {
    return this.get(generateCacheKey("account", { address }));
  }

  /** Invalidate cached user account information. */
  invalidateAccount(address: string): boolean {
    return this.invalidate(generateCacheKey("account", { address }));
  }

  /** Cache invoice statistics or aggregations. */
  cacheStats(statsKey: string, statsData: unknown, ttlMs?: number): void {
    this.set(generateCacheKey("stats", { key: statsKey }), statsData as T, ttlMs);
  }

  /** Retrieve cached statistics. */
  getCachedStats(statsKey: string): unknown | undefined {
    return this.get(generateCacheKey("stats", { key: statsKey }));
  }
}
