/**
 * Outbound request rate limiting (issue #1058).
 *
 * Guards the SDK's RPC/transaction submission paths against abuse and
 * self-inflicted DoS by enforcing:
 *
 * - **A global token bucket** — `maxRequestsPerSecond` requests are allowed
 *   per `windowMs` window across all callers.
 * - **Optional per-key limits** — a second, independent budget per caller id
 *   (`perKeyLimit`) so one noisy key cannot starve the shared budget.
 * - **Checks** — {@link RateLimiter.check} observes capacity without
 *   consuming it, {@link RateLimiter.tryAcquire} consumes a slot only when
 *   one is available (fail-fast, never blocks), and {@link RateLimiter.acquire}
 *   queues the caller until a slot frees (the original blocking behavior).
 * - **Storage** — per-key counters live in {@link RateLimitStore}, a
 *   fixed-window map with least-recently-used eviction (`maxTrackedKeys`) and
 *   expired-window pruning, so memory stays bounded no matter how many
 *   distinct keys appear.
 *
 * Configuration is a plain {@link RateLimiterConfig} object (validated at
 * construction) which the `StellarSplitClient` accepts via its `rateLimit`
 * option.
 *
 * Issue #1058
 */

/** Configuration for {@link RateLimiter}. */
export interface RateLimiterConfig {
  /** Requests allowed per window, globally. Must be a positive finite number. */
  maxRequestsPerSecond: number;
  /** Optional per-key budget within each window. Integer ≥ 1. */
  perKeyLimit?: number;
  /** Window length in milliseconds (token refill + per-key counters). Defaults to 1000. */
  windowMs?: number;
  /** Maximum tracked keys before least-recently-used eviction. Defaults to 10 000. */
  maxTrackedKeys?: number;
}

/** Outcome of a rate-limit check or acquisition attempt. */
export interface RateLimitCheck {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** Slots left for the current window when allowed; `0` when denied. */
  remaining: number;
  /** Milliseconds until capacity is available (0 when allowed). */
  retryAfterMs: number;
}

interface WindowEntry {
  /** Start of the window the count belongs to (epoch ms). */
  windowStart: number;
  /** Units consumed within the current window. */
  count: number;
}

/**
 * Bounded fixed-window counter storage for per-key rate limits.
 *
 * Each key owns an independent window that starts at its first use; when the
 * window elapses the counter rolls over automatically. Insertion order doubles
 * as a least-recently-used ranking: entries are re-inserted on access and the
 * oldest entry is evicted once `maxKeys` is reached, keeping storage O(1) and
 * memory bounded even under key-squatting floods.
 */
export class RateLimitStore {
  private readonly _entries = new Map<string, WindowEntry>();
  /** Hard cap on tracked keys (LRU-evicted above this). */
  readonly maxKeys: number;

  constructor(maxKeys: number = 10_000) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new RangeError("maxKeys must be an integer of at least 1");
    }
    this.maxKeys = maxKeys;
  }

  /** Number of keys currently tracked. */
  get size(): number {
    return this._entries.size;
  }

  /**
   * Observe consumption for `key` without consuming a unit.
   *
   * @returns A {@link RateLimitCheck} reflecting the key's current window.
   */
  peek(key: string, limit: number, windowMs: number, now: number = Date.now()): RateLimitCheck {
    return this._evaluate(key, limit, windowMs, now, false);
  }

  /**
   * Consume one unit for `key` when the budget allows it.
   *
   * @returns A {@link RateLimitCheck}; `allowed` is false when the key's
   *   budget for the current window is exhausted.
   */
  consume(key: string, limit: number, windowMs: number, now: number = Date.now()): RateLimitCheck {
    return this._evaluate(key, limit, windowMs, now, true);
  }

  /**
   * Drop every entry whose window has fully elapsed.
   *
   * @returns Number of entries removed.
   */
  prune(windowMs: number, now: number = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this._entries) {
      if (now - entry.windowStart >= windowMs) {
        this._entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Forget every tracked key (e.g. when the limiter is reconfigured). */
  clear(): void {
    this._entries.clear();
  }

  private _evaluate(
    key: string,
    limit: number,
    windowMs: number,
    now: number,
    take: boolean,
  ): RateLimitCheck {
    const entry = this._touch(key, windowMs, now);
    const available = limit - entry.count;
    if (available <= 0) {
      return { allowed: false, remaining: 0, retryAfterMs: entry.windowStart + windowMs - now };
    }
    if (take) {
      entry.count++;
    }
    return {
      allowed: true,
      remaining: available - (take ? 1 : 0),
      retryAfterMs: 0,
    };
  }

  private _touch(key: string, windowMs: number, now: number): WindowEntry {
    let entry = this._entries.get(key);
    if (entry && now - entry.windowStart >= windowMs) {
      // Window elapsed: roll the counter over in place.
      entry.windowStart = now;
      entry.count = 0;
    }
    if (!entry) {
      while (this._entries.size >= this.maxKeys) {
        const oldest = this._entries.keys().next();
        if (oldest.done) break;
        this._entries.delete(oldest.value);
      }
      entry = { windowStart: now, count: 0 };
      this._entries.set(key, entry);
      return entry;
    }
    // Re-insert to mark the key as most recently used for LRU eviction.
    this._entries.delete(key);
    this._entries.set(key, entry);
    return entry;
  }
}

interface PendingAcquire {
  key?: string;
  resolve: () => void;
}

/**
 * Token-bucket rate limiter with optional per-key budgets.
 *
 * @example
 * const limiter = new RateLimiter({ maxRequestsPerSecond: 10, perKeyLimit: 5 });
 * await limiter.acquire("wallet-1");   // blocks until a slot is free
 * limiter.tryAcquire("wallet-1");      // fail-fast: { allowed, remaining, retryAfterMs }
 * limiter.check("wallet-1");           // observe without consuming
 */
export class RateLimiter {
  private _tokens: number;
  private readonly _maxTokens: number;
  private readonly _perKeyLimit: number | undefined;
  private readonly _windowMs: number;
  private readonly _store: RateLimitStore;
  private _lastRefillTime: number;
  private _queue: PendingAcquire[] = [];
  private _processing = false;

  constructor(config: RateLimiterConfig) {
    if (!config || typeof config !== "object") {
      throw new RangeError("RateLimiter requires a config object");
    }
    const { maxRequestsPerSecond, perKeyLimit, windowMs, maxTrackedKeys } = config;
    if (
      typeof maxRequestsPerSecond !== "number" ||
      !Number.isFinite(maxRequestsPerSecond) ||
      maxRequestsPerSecond <= 0
    ) {
      throw new RangeError("maxRequestsPerSecond must be a positive finite number");
    }
    if (perKeyLimit !== undefined && (!Number.isInteger(perKeyLimit) || perKeyLimit < 1)) {
      throw new RangeError("perKeyLimit must be an integer of at least 1");
    }
    if (windowMs !== undefined && (!Number.isFinite(windowMs) || windowMs < 1)) {
      throw new RangeError("windowMs must be a finite number of at least 1");
    }

    this._maxTokens = maxRequestsPerSecond;
    this._perKeyLimit = perKeyLimit;
    this._windowMs = windowMs ?? 1000;
    this._tokens = this._maxTokens;
    this._lastRefillTime = Date.now();
    this._store = new RateLimitStore(maxTrackedKeys);
  }

  /** Effective window length in milliseconds. */
  get windowMs(): number {
    return this._windowMs;
  }

  /** Per-key counter storage (exposed for inspection/metrics). */
  get store(): RateLimitStore {
    return this._store;
  }

  /**
   * Observe current capacity without consuming a slot.
   *
   * @param key - Optional per-key scope.
   * @returns Whether a request would be admitted, remaining slots, and the
   *   wait in milliseconds when denied.
   */
  check(key?: string): RateLimitCheck {
    return this._evaluate(key, false);
  }

  /**
   * Consume a slot when one is available — never blocks.
   *
   * @param key - Optional per-key scope.
   * @returns Admission result; when denied, `retryAfterMs` indicates when to
   *   retry.
   */
  tryAcquire(key?: string): RateLimitCheck {
    return this._evaluate(key, true);
  }

  /**
   * Acquire a slot, queueing until one frees (blocking behavior).
   *
   * @param key - Optional per-key scope.
   * @returns A promise that resolves once the slot has been granted.
   */
  acquire(key?: string): Promise<void> {
    if (this._evaluate(key, true).allowed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._queue.push({ key, resolve });
      if (!this._processing) {
        this._processQueue();
      }
    });
  }

  private _refill(now: number = Date.now()): void {
    const elapsed = now - this._lastRefillTime;
    if (elapsed >= this._windowMs) {
      const periods = Math.floor(elapsed / this._windowMs);
      this._tokens = Math.min(this._maxTokens, this._tokens + periods * this._maxTokens);
      this._lastRefillTime += periods * this._windowMs;
    }
  }

  private _msUntilRefill(now: number = Date.now()): number {
    return Math.max(0, this._windowMs - (now - this._lastRefillTime));
  }

  private _evaluate(key: string | undefined, consume: boolean): RateLimitCheck {
    const now = Date.now();
    this._refill(now);

    if (this._tokens <= 0) {
      return { allowed: false, remaining: 0, retryAfterMs: this._msUntilRefill(now) };
    }

    if (key && this._perKeyLimit !== undefined) {
      const keyResult = consume
        ? this._store.consume(key, this._perKeyLimit, this._windowMs, now)
        : this._store.peek(key, this._perKeyLimit, this._windowMs, now);
      if (!keyResult.allowed) {
        return { allowed: false, remaining: 0, retryAfterMs: keyResult.retryAfterMs };
      }
      if (consume) {
        this._tokens--;
      }
      return {
        allowed: true,
        remaining: Math.min(Math.floor(this._tokens), keyResult.remaining),
        retryAfterMs: 0,
      };
    }

    if (consume) {
      this._tokens--;
    }
    return { allowed: true, remaining: Math.floor(this._tokens), retryAfterMs: 0 };
  }

  private _processQueue(): void {
    this._processing = true;
    const msUntilRefill = this._msUntilRefill();
    setTimeout(() => {
      const now = Date.now();
      this._refill(now);
      let index = 0;
      while (index < this._queue.length) {
        const next = this._queue[index];
        if (!next) {
          index++;
          continue;
        }
        if (this._evaluate(next.key, true).allowed) {
          this._queue.splice(index, 1);
          next.resolve();
          continue;
        }
        index++;
      }
      if (this._queue.length > 0) {
        this._processQueue();
      } else {
        this._processing = false;
      }
    }, msUntilRefill);
  }
}

