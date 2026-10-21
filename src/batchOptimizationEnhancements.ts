/**
 * Batch operation optimization enhancements.
 * Adds parallel execution, recipient grouping, deduplication, and priority ordering.
 * Issue #1133
 */

export interface BatchOp {
  id: string;
  destination: string;
  amount: number;
  currency: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface BatchOpResult<T> {
  id: string;
  status: "fulfilled" | "rejected";
  value?: T;
  error?: Error;
  durationMs: number;
}

export interface BatchOptimizerOptions {
  /** Max concurrent operations. Default: 10 */
  concurrency?: number;
  /** Sort order for priority. Default: 'desc' (highest amount first) */
  priorityOrder?: "asc" | "desc";
}

/**
 * Execute batch operations in parallel with concurrency control.
 */
export async function executeInParallel<T>(
  ops: BatchOp[],
  executor: (op: BatchOp) => Promise<T>,
  options: BatchOptimizerOptions = {}
): Promise<BatchOpResult<T>[]> {
  const { concurrency = 10 } = options;
  const results: BatchOpResult<T>[] = [];

  for (let i = 0; i < ops.length; i += concurrency) {
    const chunk = ops.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      chunk.map(async (op) => {
        const start = Date.now();
        const value = await executor(op);
        return { id: op.id, value, durationMs: Date.now() - start };
      })
    );
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      if (s.status === "fulfilled") {
        results.push({ id: chunk[j].id, status: "fulfilled", value: s.value.value, durationMs: s.value.durationMs });
      } else {
        results.push({ id: chunk[j].id, status: "rejected", error: s.reason as Error, durationMs: 0 });
      }
    }
  }
  return results;
}

/**
 * Group batch operations by destination address.
 */
export function groupByRecipient(ops: BatchOp[]): Map<string, BatchOp[]> {
  const map = new Map<string, BatchOp[]>();
  for (const op of ops) {
    const group = map.get(op.destination) ?? [];
    group.push(op);
    map.set(op.destination, group);
  }
  return map;
}

/**
 * Merge operations to the same destination+currency into a single op.
 */
export function deduplicateOps(ops: BatchOp[]): BatchOp[] {
  const merged = new Map<string, BatchOp>();
  for (const op of ops) {
    const key = `${op.destination}:${op.currency}:${op.source ?? ""}`;
    const existing = merged.get(key);
    if (existing) {
      existing.amount += op.amount;
      existing.metadata = { ...existing.metadata, ...op.metadata };
    } else {
      merged.set(key, { ...op });
    }
  }
  return Array.from(merged.values());
}

/**
 * Reorder operations by amount (highest first by default).
 */
export function prioritizeOps(ops: BatchOp[], order: "asc" | "desc" = "desc"): BatchOp[] {
  return [...ops].sort((a, b) => order === "desc" ? b.amount - a.amount : a.amount - b.amount);
}

/**
 * All-in-one BatchOptimizer class.
 */
export class BatchOptimizer {
  private options: BatchOptimizerOptions;

  constructor(options: BatchOptimizerOptions = {}) {
    this.options = options;
  }

  groupByRecipient(ops: BatchOp[]): Map<string, BatchOp[]> {
    return groupByRecipient(ops);
  }

  deduplicate(ops: BatchOp[]): BatchOp[] {
    return deduplicateOps(ops);
  }

  prioritize(ops: BatchOp[], order?: "asc" | "desc"): BatchOp[] {
    return prioritizeOps(ops, order ?? this.options.priorityOrder);
  }

  async executeParallel<T>(
    ops: BatchOp[],
    executor: (op: BatchOp) => Promise<T>
  ): Promise<BatchOpResult<T>[]> {
    return executeInParallel(ops, executor, this.options);
  }

  /** Full optimization pipeline: deduplicate -> prioritize -> execute in parallel */
  async optimize<T>(
    ops: BatchOp[],
    executor: (op: BatchOp) => Promise<T>
  ): Promise<BatchOpResult<T>[]> {
    const deduped = this.deduplicate(ops);
    const prioritized = this.prioritize(deduped);
    return this.executeParallel(prioritized, executor);
  }
}
