/**
 * Issue #1138: Optimize memory usage
 *
 * Implements object pooling for frequent allocations and tracks SDK memory footprint.
 */

export interface MemoryReport {
  heapUsedBytes?: number;
  poolAllocations: number;
  poolReuses: number;
  poolActiveObjects: number;
}

export class ObjectPool<T> {
  private pool: T[] = [];
  private totalAllocated = 0;
  private totalReused = 0;

  constructor(
    private readonly factory: () => T,
    private readonly resetFn?: (item: T) => void,
    initialSize: number = 0
  ) {
    for (let i = 0; i < initialSize; i++) {
      this.pool.push(this.factory());
      this.totalAllocated++;
    }
  }

  public acquire(): T {
    if (this.pool.length > 0) {
      this.totalReused++;
      return this.pool.pop()!;
    }
    this.totalAllocated++;
    return this.factory();
  }

  public release(item: T): void {
    if (this.resetFn) {
      this.resetFn(item);
    }
    this.pool.push(item);
  }

  public getStats(): { available: number; totalAllocated: number; totalReused: number } {
    return {
      available: this.pool.length,
      totalAllocated: this.totalAllocated,
      totalReused: this.totalReused,
    };
  }

  public clear(): void {
    this.pool = [];
  }
}

export class MemoryOptimizer {
  private static pools: Map<string, ObjectPool<unknown>> = new Map();

  public static getOrCreatePool<T>(
    key: string,
    factory: () => T,
    resetFn?: (item: T) => void
  ): ObjectPool<T> {
    if (!this.pools.has(key)) {
      this.pools.set(key, new ObjectPool<T>(factory, resetFn) as ObjectPool<unknown>);
    }
    return this.pools.get(key) as ObjectPool<T>;
  }

  public static report(): MemoryReport {
    let poolAllocations = 0;
    let poolReuses = 0;
    let poolActiveObjects = 0;

    for (const pool of this.pools.values()) {
      const stats = pool.getStats();
      poolAllocations += stats.totalAllocated;
      poolReuses += stats.totalReused;
      poolActiveObjects += stats.available;
    }

    const memUsage = typeof process !== "undefined" && process.memoryUsage ? process.memoryUsage() : null;

    return {
      heapUsedBytes: memUsage?.heapUsed,
      poolAllocations,
      poolReuses,
      poolActiveObjects,
    };
  }
}
