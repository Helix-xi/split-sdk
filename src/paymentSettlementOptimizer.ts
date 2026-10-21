/**
 * Payment settlement optimization engine.
 *
 * Analyzes a set of pending payments and produces an optimized {@link SettlementPlan}
 * that batches payments to the same recipients, orders operations for maximum
 * throughput or minimum fees, and estimates the total fee cost before submission.
 *
 * Three optimization strategies are available:
 * - `"minimize-fees"` — combine payments to the same recipient into one operation.
 * - `"maximize-throughput"` — order batches by size (most payments first).
 * - `"balanced"` — apply batching then sort by descending total amount.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Strategy to use when optimizing settlement. */
export type OptimizationStrategy =
  | "minimize-fees"
  | "maximize-throughput"
  | "balanced";

/** A single pending payment to settle. */
export interface PendingPayment {
  /** Unique identifier for this payment. */
  id: string;
  /** Source (payer) Stellar address. */
  from: string;
  /** Destination (recipient) Stellar address. */
  to: string;
  /** Payment amount in stroops. */
  amount: bigint;
  /** Optional priority hint (higher = more urgent; default 0). */
  priority?: number;
  /** Optional fee budget in stroops (per-payment cap). */
  maxFeeStroops?: number;
}

/** A batch of payments that can be settled in a single transaction. */
export interface SettlementBatch {
  /** Unique batch identifier. */
  batchId: string;
  /** Payments included in this batch. */
  payments: PendingPayment[];
  /** Total amount in stroops for all payments in this batch. */
  totalAmount: bigint;
  /** Estimated fee in stroops for submitting this batch. */
  estimatedFeeStroops: number;
  /** Recipient address(es) covered by this batch. */
  recipients: string[];
}

/** The complete optimized settlement plan. */
export interface SettlementPlan {
  /** Ordered list of batches to execute. */
  batches: SettlementBatch[];
  /** Total number of payments across all batches. */
  totalPayments: number;
  /** Total amount to be settled in stroops. */
  totalAmount: bigint;
  /** Total estimated fee in stroops. */
  totalEstimatedFeeStroops: number;
  /** Number of individual operations saved by batching. */
  operationsSaved: number;
  /** Optimization strategy used. */
  strategy: OptimizationStrategy;
}

/** Callback invoked when a settlement plan is ready. */
export type SettlementReadyCallback = (plan: SettlementPlan) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base fee per Stellar operation in stroops (100 stroops = 0.00001 XLM). */
const BASE_FEE_PER_OP = 100;
/** Marginal fee per additional operation when batching (lower than base). */
const MARGINAL_FEE_PER_OP = 50;

// ---------------------------------------------------------------------------
// Optimizer
// ---------------------------------------------------------------------------

let _batchCounter = 0;

function nextBatchId(): string {
  return `batch-${++_batchCounter}`;
}

/**
 * Estimate the fee in stroops for submitting a batch of operations.
 *
 * The first operation carries a full base fee; subsequent operations in the
 * same transaction pay a reduced marginal fee due to multi-operation packing.
 *
 * @param operationCount - Number of payment operations in the batch.
 * @returns Estimated fee in stroops.
 */
export function estimateBatchFee(operationCount: number): number {
  if (operationCount <= 0) return 0;
  return BASE_FEE_PER_OP + Math.max(0, operationCount - 1) * MARGINAL_FEE_PER_OP;
}

/**
 * Re-order a list of payments for optimal settlement without batching.
 *
 * Payments are sorted by:
 * 1. Priority (descending) — higher-priority payments execute first.
 * 2. Amount (descending) — larger payments are settled first within the same priority.
 *
 * @param payments - Payments to reorder.
 * @returns A new array with payments in optimal order.
 */
export function reorderForOptimalSettlement(
  payments: PendingPayment[]
): PendingPayment[] {
  return [...payments].sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pb !== pa) return pb - pa;
    return a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0;
  });
}

/**
 * Payment settlement optimizer.
 *
 * Accepts a list of pending payments, applies an optimization strategy, and
 * emits the resulting {@link SettlementPlan} to any registered callbacks.
 *
 * @example
 * ```ts
 * const optimizer = new PaymentSettlementOptimizer();
 * optimizer.onSettlementReady((plan) => console.log(plan));
 *
 * const plan = optimizer.optimize(pendingPayments, "minimize-fees");
 * console.log(`${plan.operationsSaved} operations saved`);
 * ```
 */
export class PaymentSettlementOptimizer {
  private readonly _callbacks: SettlementReadyCallback[] = [];

  // ---------------------------------------------------------------------------
  // Event registration
  // ---------------------------------------------------------------------------

  /**
   * Register a callback invoked each time {@link optimize} produces a plan.
   *
   * @param callback - Receives the completed {@link SettlementPlan}.
   * @returns An `unsubscribe` function.
   */
  onSettlementReady(callback: SettlementReadyCallback): () => void {
    this._callbacks.push(callback);
    return () => {
      const idx = this._callbacks.indexOf(callback);
      if (idx !== -1) this._callbacks.splice(idx, 1);
    };
  }

  // ---------------------------------------------------------------------------
  // Core optimization
  // ---------------------------------------------------------------------------

  /**
   * Compute an optimized settlement plan for a list of payments.
   *
   * Empty input returns a zeroed plan. Registered callbacks are invoked
   * synchronously before the plan is returned.
   *
   * @param payments  - Pending payments to settle.
   * @param strategy  - Optimization strategy (default `"balanced"`).
   * @returns The optimized {@link SettlementPlan}.
   */
  optimize(
    payments: PendingPayment[],
    strategy: OptimizationStrategy = "balanced"
  ): SettlementPlan {
    if (payments.length === 0) {
      const empty: SettlementPlan = {
        batches: [],
        totalPayments: 0,
        totalAmount: 0n,
        totalEstimatedFeeStroops: 0,
        operationsSaved: 0,
        strategy,
      };
      this._emit(empty);
      return empty;
    }

    // Step 1 — group by recipient
    const grouped = new Map<string, PendingPayment[]>();
    for (const payment of payments) {
      const existing = grouped.get(payment.to);
      if (existing) {
        existing.push(payment);
      } else {
        grouped.set(payment.to, [payment]);
      }
    }

    // Step 2 — build batches from groups
    const rawBatches: SettlementBatch[] = [];
    for (const [recipient, group] of grouped) {
      const sorted = reorderForOptimalSettlement(group);
      const totalAmount = sorted.reduce((s, p) => s + p.amount, 0n);
      const fee = estimateBatchFee(sorted.length);
      rawBatches.push({
        batchId: nextBatchId(),
        payments: sorted,
        totalAmount,
        estimatedFeeStroops: fee,
        recipients: [recipient],
      });
    }

    // Step 3 — apply strategy-specific ordering
    const batches = this._applyStrategy(rawBatches, strategy);

    // Step 4 — compute totals
    const totalAmount = batches.reduce((s, b) => s + b.totalAmount, 0n);
    const totalEstimatedFeeStroops = batches.reduce(
      (s, b) => s + b.estimatedFeeStroops,
      0
    );
    const totalPayments = batches.reduce((s, b) => s + b.payments.length, 0);
    // Operations saved = how many operations we avoided by batching same-recipient payments
    const operationsSaved = totalPayments - batches.length;

    const plan: SettlementPlan = {
      batches,
      totalPayments,
      totalAmount,
      totalEstimatedFeeStroops,
      operationsSaved,
      strategy,
    };

    this._emit(plan);
    return plan;
  }

  /**
   * Estimate the fee for a single settlement batch.
   *
   * @param batch - The batch to estimate.
   * @returns Estimated fee in stroops.
   */
  estimateFees(batch: SettlementBatch): number {
    return estimateBatchFee(batch.payments.length);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _applyStrategy(
    batches: SettlementBatch[],
    strategy: OptimizationStrategy
  ): SettlementBatch[] {
    switch (strategy) {
      case "minimize-fees":
        // Already batched by recipient — sort by fee ascending to put cheapest first
        return [...batches].sort(
          (a, b) => a.estimatedFeeStroops - b.estimatedFeeStroops
        );

      case "maximize-throughput":
        // Most payments per batch first → maximises the volume settled early
        return [...batches].sort(
          (a, b) => b.payments.length - a.payments.length
        );

      case "balanced":
      default:
        // Largest total amount first — prioritises high-value settlements
        return [...batches].sort((a, b) =>
          a.totalAmount > b.totalAmount ? -1 : a.totalAmount < b.totalAmount ? 1 : 0
        );
    }
  }

  private _emit(plan: SettlementPlan): void {
    for (const cb of this._callbacks) {
      cb(plan);
    }
  }
}
