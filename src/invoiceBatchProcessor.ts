/**
 * Concurrency-limited batch invoice payment processor.
 *
 * Submits a set of invoice payments with a configurable concurrency ceiling
 * so month-end batch billing doesn't overwhelm Horizon's rate limits, and
 * reports each result as it settles rather than waiting for the whole batch.
 */

import { TypedEventEmitter } from "./events/TypedEventEmitter.js";

/** Result of submitting a single invoice's payment within a batch. */
export interface BatchInvoiceResult {
  invoiceId: string;
  status: "success" | "failed";
  txHash?: string;
  error?: string;
}

/** Configuration for a batch run. */
export interface InvoiceBatchConfig {
  /** Stellar address submitting each payment. */
  payer: string;
  /** Amount (in stroops) to pay per invoice ID. */
  amounts: Record<string, bigint>;
  /** Maximum number of submissions in flight at once. Default: 3. */
  maxConcurrent?: number;
  /** Fallback pause duration (ms) on a rate-limit error when no explicit `retryAfterMs` is available. Default: 2000. */
  rateLimitPauseMs?: number;
  /** Per-submission deadline (ms). A submission exceeding it is aborted and reported as timed out. Default: 30000. */
  timeoutMs?: number;
}

/** Snapshot of a batch run's concurrency counters. */
export interface InvoiceBatchMetrics {
  /** Submissions currently in flight. */
  active: number;
  /** Submissions dispatched but not yet settled (active + awaiting a slot). */
  queued: number;
  /** Submissions that settled successfully. */
  completed: number;
  /** Submissions that failed for any reason. */
  failed: number;
  /** Submissions aborted because they exceeded `timeoutMs`. */
  timedOut: number;
}

interface InvoiceBatchEvents {
  batchInvoiceSettled: BatchInvoiceResult;
  batchInvoiceFailed: BatchInvoiceResult;
}

/** Minimal client surface required to submit a batched invoice payment. */
export interface InvoicePaymentSubmitter {
  submitPayment(params: {
    invoiceId: string;
    payer: string;
    amount: bigint;
  }): Promise<{ txHash: string }>;
}

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_RATE_LIMIT_PAUSE_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown): boolean {
  return error instanceof Error && /429|rate.?limit|too many requests/i.test(error.message);
}

function isValidPauseMs(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function retryAfterMs(error: unknown, fallbackMs: number): number {
  const withRetryAfter = error as { retryAfterMs?: number } | undefined;
  const candidate = withRetryAfter?.retryAfterMs;
  return typeof candidate === "number" && isValidPauseMs(candidate) ? candidate : fallbackMs;
}

/**
 * Semaphore-style concurrency limiter. Callers `acquire()` a slot before
 * running work and `release()` it when done; at most `limit` slots are ever
 * held at once. Waiting acquirers are served FIFO.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("ConcurrencyLimiter limit must be a positive integer");
    }
  }

  /** Number of slots currently held. */
  get activeCount(): number {
    return this.active;
  }

  /** Number of callers waiting for a slot. */
  get pendingCount(): number {
    return this.waiters.length;
  }

  /** Resolve once a slot is available and mark it held. */
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  /** Release a held slot, waking the next waiter if any. */
  release(): void {
    if (this.active > 0) this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Run `task` while holding a slot, releasing it even on rejection. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}

/**
 * Race `promise` against a deadline. Rejects with a timeout error if the
 * deadline elapses first; the underlying promise is left to settle on its own.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label = "operation"): Promise<T> {
  if (!isValidPauseMs(timeoutMs)) {
    throw new RangeError("timeoutMs must be a non-negative integer");
  }
  if (timeoutMs === 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timed out after/i.test(error.message);
}

export class InvoiceBatchProcessor {
  readonly events = new TypedEventEmitter<InvoiceBatchEvents>();

  private readonly metrics: InvoiceBatchMetrics = {
    active: 0,
    queued: 0,
    completed: 0,
    failed: 0,
    timedOut: 0,
  };

  constructor(private readonly client: InvoicePaymentSubmitter) {}

  /** Current concurrency counters for the most recent (or in-progress) run. */
  getMetrics(): InvoiceBatchMetrics {
    return { ...this.metrics };
  }

  /**
   * Submit payments for `invoiceIds`, yielding a {@link BatchInvoiceResult} as
   * each one settles. No more than `config.maxConcurrent` submissions are
   * in-flight at once. On a 429 from any submission, all further dispatch
   * pauses until the rate limit's backoff window elapses. Each submission is
   * bounded by `config.timeoutMs`.
   */
  async *process(
    invoiceIds: string[],
    config: InvoiceBatchConfig
  ): AsyncIterableIterator<BatchInvoiceResult> {
    const maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    const rateLimitPauseMs = config.rateLimitPauseMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError("maxConcurrent must be a positive integer");
    }

    if (!isValidPauseMs(rateLimitPauseMs)) {
      throw new RangeError("rateLimitPauseMs must be a non-negative integer");
    }

    if (!isValidPauseMs(timeoutMs)) {
      throw new RangeError("timeoutMs must be a non-negative integer");
    }

    this.metrics.active = 0;
    this.metrics.queued = 0;
    this.metrics.completed = 0;
    this.metrics.failed = 0;
    this.metrics.timedOut = 0;

    const limiter = new ConcurrencyLimiter(maxConcurrent);
    let cursor = 0;
    let pausedUntil = 0;
    let slotSeq = 0;
    const inFlight = new Map<number, Promise<{ slot: number; result: BatchInvoiceResult }>>();

    const waitForGlobalPause = async (): Promise<void> => {
      while (true) {
        const wait = pausedUntil - Date.now();
        if (wait <= 0) return;
        await sleep(wait);
      }
    };

    const runOne = async (invoiceId: string): Promise<BatchInvoiceResult> => {
      await waitForGlobalPause();

      const amount = config.amounts[invoiceId];
      if (amount === undefined) {
        const result: BatchInvoiceResult = {
          invoiceId,
          status: "failed",
          error: `No amount specified for invoice ${invoiceId}`,
        };
        this.metrics.failed++;
        this.events.emit("batchInvoiceFailed", result);
        return result;
      }

      try {
        const { txHash } = await limiter.run(() =>
          withTimeout(
            this.client.submitPayment({ invoiceId, payer: config.payer, amount }),
            timeoutMs,
            `submitPayment(${invoiceId})`
          )
        );
        const result: BatchInvoiceResult = { invoiceId, status: "success", txHash };
        this.metrics.completed++;
        this.events.emit("batchInvoiceSettled", result);
        return result;
      } catch (error) {
        if (isRateLimitError(error)) {
          const nextPausedUntil = Date.now() + retryAfterMs(error, rateLimitPauseMs);
          pausedUntil = Math.max(pausedUntil, nextPausedUntil);
        }
        if (isTimeoutError(error)) {
          this.metrics.timedOut++;
        }
        const result: BatchInvoiceResult = {
          invoiceId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
        this.metrics.failed++;
        this.events.emit("batchInvoiceFailed", result);
        return result;
      }
    };

    const launch = (): void => {
      if (cursor >= invoiceIds.length) return;
      const invoiceId = invoiceIds[cursor++]!;
      const slot = slotSeq++;
      this.metrics.active++;
      this.metrics.queued++;
      inFlight.set(
        slot,
        runOne(invoiceId).then((result) => {
          this.metrics.active--;
          this.metrics.queued--;
          return { slot, result };
        })
      );
    };

    const initialLaunches = Math.min(maxConcurrent, invoiceIds.length);
    for (let i = 0; i < initialLaunches; i++) launch();

    while (inFlight.size > 0) {
      const { slot, result } = await Promise.race(inFlight.values());
      inFlight.delete(slot);
      launch();
      yield result;
    }
  }

  /**
   * Process a batch and return a single result object with `succeeded` and
   * `failed` arrays, making it easy to inspect partial-failure outcomes.
   *
   * Internally delegates to {@link process} so all concurrency and
   * rate-limit behaviour is preserved.
   *
   * @param invoiceIds - Ordered list of invoice IDs to process.
   * @param config     - Batch configuration (payer, amounts, concurrency).
   * @returns `{ succeeded, failed }` — results split by outcome.
   */
  async processAll(
    invoiceIds: string[],
    config: InvoiceBatchConfig,
  ): Promise<{ succeeded: BatchInvoiceResult[]; failed: BatchInvoiceResult[] }> {
    const succeeded: BatchInvoiceResult[] = [];
    const failed: BatchInvoiceResult[] = [];

    for await (const result of this.process(invoiceIds, config)) {
      if (result.status === "success") {
        succeeded.push(result);
      } else {
        failed.push(result);
      }
    }

    return { succeeded, failed };
  }
}
