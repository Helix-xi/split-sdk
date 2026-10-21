import crypto from "crypto";

export interface IdempotencyKeyParams {
  invoiceId: string;
  payer: string;
  amount: bigint;
  nonce?: string;
}

const knownKeys = new Set<string>();

/**
 * Generate a canonical idempotency key for payment deduplication.
 *
 * Computes a deterministic SHA-256 hex digest over `{invoiceId}:{payer}:{amount}`
 * (with an optional `:{nonce}` suffix when supplied).
 */
export function generateIdempotencyKey(params: IdempotencyKeyParams): string {
  const base = `${params.invoiceId}:${params.payer}:${params.amount.toString()}`;
  const payload = params.nonce !== undefined ? `${base}:${params.nonce}` : base;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/** Check if an idempotency key has already been registered in memory. */
export function isKnownKey(key: string): boolean {
  return knownKeys.has(key);
}

/** Register an idempotency key in memory. */
export function registerKey(key: string): void {
  knownKeys.add(key);
}

/** Clear all registered idempotency keys (useful for test teardown). */
export function clearKeys(): void {
  knownKeys.clear();
}

export class Deduplicator<T> {
  private _inflight = new Map<string, Promise<T>>();
  private _hits = 0;
  private _misses = 0;

  dedupe(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this._inflight.get(key);
    if (existing) {
      this._hits++;
      return existing;
    }
    this._misses++;
    const promise = fn().finally(() => this._inflight.delete(key));
    this._inflight.set(key, promise);
    return promise;
  }

  get cacheHitRate(): number {
    const total = this._hits + this._misses;
    return total === 0 ? 0 : this._hits / total;
  }

  getDedupStats(): { deduped: number; total: number } {
    return { deduped: this._hits, total: this._hits + this._misses };
  }
}
