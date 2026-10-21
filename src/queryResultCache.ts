/**
 * Query result cache with per-query-type TTL, mutation invalidation, and metrics.
 * Issue #1135
 */

export interface QueryResultCacheOptions {
  /** TTL per query name. Falls back to defaultTtlMs. */
  queryTtlMap?: Record<string, number>;
  /** Default TTL in ms. Default: 30000 */
  defaultTtlMs?: number;
  /** Max cache entries. Default: 500 */
  maxSize?: number;
}

export interface QueryCacheMetrics {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  queryName: string;
}

/**
 * Builds a stable cache key from query name and params.
 */
export function buildCacheKey(queryName: string, params: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
  return `${queryName}:${JSON.stringify(sorted)}`;
}

export class QueryResultCache {
  private store = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private queryTtlMap: Record<string, number>;
  private defaultTtlMs: number;
  private maxSize: number;

  constructor(options: QueryResultCacheOptions = {}) {
    this.queryTtlMap = options.queryTtlMap ?? {};
    this.defaultTtlMs = options.defaultTtlMs ?? 30_000;
    this.maxSize = options.maxSize ?? 500;
  }

  /**
   * Wraps an async fetcher with caching. Returns cached result if valid, else fetches.
   */
  async wrap<T>(
    queryName: string,
    params: Record<string, unknown>,
    fetcher: () => Promise<T>
  ): Promise<T> {
    const key = buildCacheKey(queryName, params);
    const cached = this.get<T>(key);
    if (cached !== undefined) { this.hits++; return cached; }
    this.misses++;
    const value = await fetcher();
    this.set(key, value, queryName);
    return value;
  }

  /** Manually get a cached value by key. */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) { this.store.delete(key); return undefined; }
    return entry.value as T;
  }

  /** Manually set a cached value. */
  set(key: string, value: unknown, queryName: string): void {
    if (this.store.size >= this.maxSize) this.evictExpired();
    const ttl = this.queryTtlMap[queryName] ?? this.defaultTtlMs;
    this.store.set(key, { value, expiresAt: Date.now() + ttl, queryName });
  }

  /** Invalidate all cache entries belonging to the given query names. */
  invalidateOnMutation(queryNames: string[]): void {
    const names = new Set(queryNames);
    for (const [key, entry] of this.store.entries()) {
      if (names.has(entry.queryName)) this.store.delete(key);
    }
  }

  /** Invalidate all entries whose key starts with a namespace prefix. */
  invalidateNamespace(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  /** Return hit/miss metrics. */
  getMetrics(): QueryCacheMetrics {
    const total = this.hits + this.misses;
    return { hits: this.hits, misses: this.misses, hitRate: total > 0 ? this.hits / total : 0, size: this.store.size };
  }

  clear(): void { this.store.clear(); this.hits = 0; this.misses = 0; }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }
}
