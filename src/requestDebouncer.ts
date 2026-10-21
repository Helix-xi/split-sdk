/**
 * Issue #1137: Add request debouncing
 *
 * Debounces rapid duplicate requests to the same endpoint or cache key,
 * coalescing in-flight queries and returning shared promises to multiple callers.
 */

export interface DebounceConfig {
  windowMs?: number;
}

export class RequestDebouncer {
  private inFlight: Map<string, Promise<unknown>> = new Map();
  private requestCounts: Map<string, number> = new Map();
  private duplicateSavedCount = 0;
  private windowMs: number;

  constructor(config: DebounceConfig = {}) {
    this.windowMs = config.windowMs ?? 50;
  }

  public execute<T>(key: string, requestFn: () => Promise<T>): Promise<T> {
    const current = this.requestCounts.get(key) ?? 0;
    this.requestCounts.set(key, current + 1);

    if (this.inFlight.has(key)) {
      this.duplicateSavedCount++;
      return this.inFlight.get(key) as Promise<T>;
    }

    const promise = (async () => {
      try {
        if (this.windowMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.windowMs));
        }
        return await requestFn();
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  public getInFlightCount(): number {
    return this.inFlight.size;
  }

  public getDuplicateSavedCount(): number {
    return this.duplicateSavedCount;
  }

  public clear(): void {
    this.inFlight.clear();
    this.requestCounts.clear();
    this.duplicateSavedCount = 0;
  }
}
