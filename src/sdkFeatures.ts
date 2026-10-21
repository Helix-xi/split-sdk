/**
 * SDK feature module registry with lazy loading.
 *
 * Modules are declared with their dependencies and a dynamic import factory.
 * They are only imported when first requested, which keeps startup time low.
 */

export interface ModuleMetrics {
  /** Number of times the module was requested. */
  loads: number;
  /** Number of times the dynamic import failed. */
  errors: number;
  /** Time spent resolving the module (ms), accumulated across loads. */
  totalLoadTimeMs: number;
  /** Time of the most recent successful load (ms since epoch). */
  lastLoadedAt?: number;
}

export interface ModuleDefinition<T = unknown> {
  /** Module name used for lookups. */
  name: string;
  /** Names of modules that must be loaded before this one. */
  dependencies: string[];
  /** Dynamic import factory, invoked on demand. */
  load: () => Promise<T>;
}

export interface ModuleRegistryOptions {
  /** Optional hook invoked whenever a module load fails. */
  onError?: (name: string, error: unknown) => void;
}

export class ModuleRegistry {
  private readonly definitions = new Map<string, ModuleDefinition>();
  private readonly instances = new Map<string, unknown>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly metrics = new Map<string, ModuleMetrics>();
  private readonly onError?: (name: string, error: unknown) => void;

  constructor(options: ModuleRegistryOptions = {}) {
    this.onError = options.onError;
  }

  /** Register a module definition. Re-registering replaces the definition. */
  register<T>(definition: ModuleDefinition<T>): void {
    if (!definition.name) {
      throw new Error('Module definition requires a name');
    }
    this.definitions.set(definition.name, definition as ModuleDefinition);
    this.metrics.set(definition.name, {
      loads: 0,
      errors: 0,
      totalLoadTimeMs: 0,
    });
  }

  /** Whether a module has been registered. */
  has(name: string): boolean {
    return this.definitions.has(name);
  }

  /** Whether a module has already been loaded. */
  isLoaded(name: string): boolean {
    return this.instances.has(name);
  }

  /**
   * Load a module on demand, resolving its dependencies first.
   * Concurrent requests for the same module share a single import.
   */
  async load<T = unknown>(name: string): Promise<T> {
    if (this.instances.has(name)) {
      return this.instances.get(name) as T;
    }

    const existing = this.pending.get(name);
    if (existing) {
      return existing as Promise<T>;
    }

    const definition = this.definitions.get(name);
    if (!definition) {
      throw new Error(`Unknown SDK module: ${name}`);
    }

    const promise = this.resolve(definition);
    this.pending.set(name, promise);

    try {
      const instance = await promise;
      this.instances.set(name, instance);
      return instance as T;
    } finally {
      this.pending.delete(name);
    }
  }

  /** Load several modules, resolving dependencies for each. */
  async loadAll(names: string[]): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};
    await Promise.all(
      names.map(async (name) => {
        results[name] = await this.load(name);
      }),
    );
    return results;
  }

  /** Snapshot of loading metrics keyed by module name. */
  getMetrics(): Record<string, ModuleMetrics> {
    const snapshot: Record<string, ModuleMetrics> = {};
    for (const [name, metrics] of this.metrics) {
      snapshot[name] = { ...metrics };
    }
    return snapshot;
  }

  private async resolve(definition: ModuleDefinition): Promise<unknown> {
    const metrics = this.metrics.get(definition.name);
    const startedAt = Date.now();

    try {
      for (const dependency of definition.dependencies) {
        await this.load(dependency);
      }

      const instance = await definition.load();

      if (metrics) {
        metrics.loads += 1;
        metrics.totalLoadTimeMs += Date.now() - startedAt;
        metrics.lastLoadedAt = Date.now();
      }

      return instance;
    } catch (error) {
      if (metrics) {
        metrics.errors += 1;
      }
      this.onError?.(definition.name, error);
      throw new Error(
        `Failed to load SDK module "${definition.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Shared registry used by SDK feature modules. */
export const sdkModules = new ModuleRegistry();

// Register built-in SDK feature modules with dynamic imports so they are only
// fetched when requested.
sdkModules.register({
  name: 'abiCache',
  dependencies: [],
  load: () => import('./abiCache'),
});

sdkModules.register({
  name: 'adapters',
  dependencies: [],
  load: () => import('./adapters/types'),
});

sdkModules.register({
  name: 'ledger',
  dependencies: ['adapters'],
  load: () => import('./adapters/ledger'),
});
