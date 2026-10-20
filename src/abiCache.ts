/**
 * Smart Contract ABI Caching Layer (#1054)
 *
 * Caches Soroban contract ABIs and interface specifications to eliminate redundant
 * network lookups, reduce RPC pressure, and improve invocation performance.
 */

import { AbiFetchError, AbiNotFoundError } from "./errors.js";
import type { StorageAdapter } from "./storage/storageAdapter.js";
import { MemoryStorageAdapter } from "./storage/storageAdapter.js";

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** Input or output parameter in a contract function spec. */
export interface AbiParamSpec {
  name: string;
  type: string;
  doc?: string;
}

/** Function specification in a contract ABI. */
export interface AbiFunctionSpec {
  name: string;
  doc?: string;
  inputs: AbiParamSpec[];
  outputs?: Array<{ type: string; doc?: string }>;
}

/** Custom User-Defined Type in a contract ABI. */
export interface AbiTypeSpec {
  name: string;
  kind: "struct" | "union" | "enum";
  doc?: string;
  fields?: Array<{ name: string; type: string }>;
  cases?: Array<{ name: string; value?: unknown }>;
}

/** Parsed Smart Contract ABI specification. */
export interface ContractAbi {
  /** Target contract address. */
  contractId: string;
  /** SHA-256 hash of the contract WASM bytecode (if known). */
  wasmHash?: string;
  /** Exported callable functions. */
  functions: AbiFunctionSpec[];
  /** Exported UDTs (types, structs, enums). */
  types?: AbiTypeSpec[];
  /** Raw base64 or hex encoded ScSpecEntry byte representation. */
  rawSpec?: string[];
  /** Timestamp when this ABI was fetched / created (ms). */
  fetchedAt: number;
  /** Semantic contract version if declared. */
  version?: string;
}

/** Stored entry wrapped with cache metadata. */
export interface CachedAbiEntry {
  contractId: string;
  abi: ContractAbi;
  cachedAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  accessCount: number;
  byteSize: number;
}

/** Cache performance and efficiency metrics. */
export interface AbiCacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  entryCount: number;
  storageBytes: number;
  evictions: number;
}

/** Memory pool monitoring snapshot. */
export interface AbiMemoryStats {
  entryCount: number;
  storageBytes: number;
  maxEntries: number;
  maxBytes: number;
  utilization: number;
  evictions: number;
  collections: number;
  lastCollectedAt: number | null;
}

/** Storage backend for cached contract ABIs. */
export interface AbiStorage {
  get(key: string): Promise<CachedAbiEntry | null> | CachedAbiEntry | null;
  set(key: string, entry: CachedAbiEntry): Promise<void> | void;
  delete(key: string): Promise<boolean> | boolean;
  clear(): Promise<void> | void;
  keys(): Promise<string[]> | string[];
  size(): Promise<number> | number;
  getStorageBytes(): Promise<number> | number;
}

/** Contract ABI Fetcher interface. */
export interface ContractAbiFetcher {
  fetchAbi(contractId: string): Promise<ContractAbi>;
}

/** Configuration options for {@link ContractAbiCache}. */
export interface AbiCacheOptions {
  /** ABI fetcher implementation or function. */
  fetcher?: ContractAbiFetcher | ((contractId: string) => Promise<ContractAbi>);
  /** Storage backend (defaults to MemoryAbiStorage). */
  storage?: AbiStorage;
  /** Time-to-live for cached ABIs in milliseconds (defaults to 1 hour = 3,600,000ms). */
  ttlMs?: number;
  /** Maximum number of ABIs to store concurrently (defaults to 500). */
  maxEntries?: number;
  /** Maximum storage budget in bytes before LRU eviction (defaults to 5MB = 5,242,880). */
  maxStorageBytes?: number;
  /** If true, removes docstrings to save storage (defaults to false). */
  compact?: boolean;
}

// ---------------------------------------------------------------------------
// Storage Implementations
// ---------------------------------------------------------------------------

/**
 * Fast in-memory storage with LRU eviction and byte-size tracking.
 */
export class MemoryAbiStorage implements AbiStorage {
  private readonly store = new Map<string, CachedAbiEntry>();
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private evictions = 0;
  private collections = 0;
  private lastCollectedAt: number | null = null;
  private accessSeq = 0;

  constructor(options?: { maxEntries?: number; maxBytes?: number }) {
    this.maxEntries = options?.maxEntries ?? 500;
    this.maxBytes = options?.maxBytes ?? 5 * 1024 * 1024;
  }

  get(key: string): CachedAbiEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    entry.lastAccessedAt = ++this.accessSeq;
    entry.accessCount++;
    return entry;
  }

  set(key: string, entry: CachedAbiEntry): void {
    const existing = this.store.get(key);
    if (existing) {
      this.totalBytes -= existing.byteSize;
    }

    entry.lastAccessedAt = ++this.accessSeq;

    // Check capacity and evict LRU entries if needed
    while (
      (this.store.size >= this.maxEntries || this.totalBytes + entry.byteSize > this.maxBytes) &&
      this.store.size > 0
    ) {
      this.evictLru();
    }

    this.store.set(key, entry);
    this.totalBytes += entry.byteSize;
  }

  delete(key: string): boolean {
    const existing = this.store.get(key);
    if (existing) {
      this.totalBytes -= existing.byteSize;
      return this.store.delete(key);
    }
    return false;
  }

  clear(): void {
    this.store.clear();
    this.totalBytes = 0;
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }

  size(): number {
    return this.store.size;
  }

  getStorageBytes(): number {
    return this.totalBytes;
  }

  getEvictions(): number {
    return this.evictions;
  }

  /**
   * Garbage-collects entries that have expired (past their `expiresAt`).
   * Returns the number of entries removed.
   */
  collectGarbage(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt > 0 && entry.expiresAt <= now) {
        this.delete(key);
        removed++;
      }
    }
    this.collections++;
    this.lastCollectedAt = now;
    return removed;
  }

  /** Returns a snapshot of current memory pool usage. */
  getMemoryStats(): AbiMemoryStats {
    const utilization =
      this.maxBytes > 0 ? Math.min(1, this.totalBytes / this.maxBytes) : 0;
    return {
      entryCount: this.store.size,
      storageBytes: this.totalBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      utilization,
      evictions: this.evictions,
      collections: this.collections,
      lastCollectedAt: this.lastCollectedAt,
    };
  }

  private evictLru(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.store) {
      if (entry.lastAccessedAt < oldestAccess) {
        oldestAccess = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.delete(oldestKey);
      this.evictions++;
    }
  }
}

/**
 * Storage adapter backed by {@link StorageAdapter} (e.g. localStorage/sessionStorage/MemoryStorageAdapter).
 */
export class AdapterAbiStorage implements AbiStorage {
  private readonly adapter: StorageAdapter;
  private readonly prefix: string;

  constructor(adapter: StorageAdapter = new MemoryStorageAdapter(), prefix = "stellar_abi_cache:") {
    this.adapter = adapter;
    this.prefix = prefix;
  }

  get(key: string): CachedAbiEntry | null {
    const raw = this.adapter.getItem(this.prefix + key);
    if (!raw) return null;
    try {
      const entry = JSON.parse(raw) as CachedAbiEntry;
      entry.lastAccessedAt = Date.now();
      entry.accessCount = (entry.accessCount || 0) + 1;
      return entry;
    } catch {
      return null;
    }
  }

  set(key: string, entry: CachedAbiEntry): void {
    const raw = JSON.stringify(entry);
    entry.byteSize = Buffer.byteLength(raw, "utf8");
    this.adapter.setItem(this.prefix + key, raw);
  }

  delete(key: string): boolean {
    const existed = this.adapter.getItem(this.prefix + key) !== null;
    this.adapter.removeItem(this.prefix + key);
    return existed;
  }

  clear(): void {
    // Collect keys under prefix
    const keys = this.keys();
    for (const k of keys) {
      this.adapter.removeItem(this.prefix + k);
    }
  }

  keys(): string[] {
    // Fallback inspect if possible, or maintain key registry
    const registryKey = `${this.prefix}__all_keys__`;
    const raw = this.adapter.getItem(registryKey);
    return raw ? JSON.parse(raw) : [];
  }

  size(): number {
    return this.keys().length;
  }

  getStorageBytes(): number {
    const keys = this.keys();
    let bytes = 0;
    for (const k of keys) {
      const item = this.adapter.getItem(this.prefix + k);
      if (item) bytes += Buffer.byteLength(item, "utf8");
    }
    return bytes;
  }
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

/**
 * Static in-memory registry fetcher for pre-configured or mock contract ABIs.
 */
export class StaticContractAbiFetcher 

/* … truncated 7865 chars — edit only what you need near the top … */
