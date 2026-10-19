/**
 * Test Suite: Batch Operations Atomicity (#1045)
 *
 * Requirements:
 * - Test success batch: all operations succeed and state updates atomically
 * - Test partial failure: isolated failure handling without corrupting valid state
 * - Test rollback: automatic and manual rollback restores prior consistent state
 * - Test consistency: balance conservation, idempotency, and lifecycle invariants
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RollbackCoordinator,
  RollbackTimeoutError,
} from "../src/splitRollbackCoordinator.js";
import { OptimisticCache } from "../src/cache/OptimisticCache.js";
import {
  InvoiceBatchProcessor,
  type InvoicePaymentSubmitter,
  type BatchInvoiceResult,
} from "../src/invoiceBatchProcessor.js";
import { IdempotencyManager } from "../src/idempotency.js";
import { auditSplitRounding, RoundingOverflowError } from "../src/invoice/rounding.js";
import { UnknownSplitError, ValidationError } from "../src/errors.js";
import type { SplitLine } from "../src/types.js";

describe("Batch Operations Atomicity (#1045)", () => {
  describe("Requirement: Test success batch", () => {
    it("successfully coordinates multi-leg split payment when all legs succeed", () => {
      const coordinator = new RollbackCoordinator();
      const splitId = "split-success-1";
      const invoiceId = "inv-success-1";
      const legs = [
        { recipient: "G_RECIPIENT_A", amount: 500n },
        { recipient: "G_RECIPIENT_B", amount: 300n },
        { recipient: "G_RECIPIENT_C", amount: 200n },
      ];

      const checkpoint = coordinator.begin(splitId, invoiceId, legs);
      expect(checkpoint.splitId).toBe(splitId);
      expect(checkpoint.invoiceId).toBe(invoiceId);
      expect(checkpoint.legs).toHaveLength(3);
      expect(checkpoint.legs.every((l) => l.state === "pending")).toBe(true);

      // Acknowledge all legs as succeeded
      coordinator.markLegSuccess(splitId, 0);
      coordinator.markLegSuccess(splitId, 1);
      coordinator.markLegSuccess(splitId, 2);

      // Verify no legs remain incomplete
      const incomplete = coordinator.getIncomplete(splitId);
      expect(incomplete).toHaveLength(0);

      const updated = coordinator.getCheckpointFor(splitId);
      expect(updated?.legs.every((l) => l.state === "succeeded")).toBe(true);
    });

    it("processes full invoice batch successfully with concurrency limits", async () => {
      const settledEvents: BatchInvoiceResult[] = [];
      const failedEvents: BatchInvoiceResult[] = [];

      const mockSubmitter: InvoicePaymentSubmitter = {
        submitPayment: vi.fn(async ({ invoiceId }) => {
          return { txHash: `tx_${invoiceId}` };
        }),
      };

      const processor = new InvoiceBatchProcessor(mockSubmitter);
      processor.events.on("batchInvoiceSettled", (res) => settledEvents.push(res));
      processor.events.on("batchInvoiceFailed", (res) => failedEvents.push(res));

      const invoiceIds = ["inv-1", "inv-2", "inv-3", "inv-4"];
      const amounts = {
        "inv-1": 100n,
        "inv-2": 200n,
        "inv-3": 300n,
        "inv-4": 400n,
      };

      const results: BatchInvoiceResult[] = [];
      for await (const result of processor.process(invoiceIds, {
        payer: "G_PAYER",
        amounts,
        maxConcurrent: 2,
      })) {
        results.push(result);
      }

      expect(results).toHaveLength(4);
      expect(results.every((r) => r.status === "success")).toBe(true);
      expect(settledEvents).toHaveLength(4);
      expect(failedEvents).toHaveLength(0);
      expect(mockSubmitter.submitPayment).toHaveBeenCalledTimes(4);
    });

    it("applies and commits batch optimistic cache mutations cleanly", () => {
      const cache = new OptimisticCache<{ balance: bigint }>();

      const commit1 = cache.applyOptimistic("inv-1", { balance: 100n }, { balance: 0n }).commit;
      const commit2 = cache.applyOptimistic("inv-2", { balance: 250n }, { balance: 50n }).commit;
      const commit3 = cache.applyOptimistic("inv-3", { balance: 500n }, { balance: 100n }).commit;

      expect(cache.pendingCount).toBe(3);
      expect(cache.get("inv-1")).toEqual({ balance: 100n });
      expect(cache.get("inv-2")).toEqual({ balance: 250n });
      expect(cache.get("inv-3")).toEqual({ balance: 500n });

      commit1();
      commit2();
      commit3();

      expect(cache.pendingCount).toBe(0);
      expect(cache.get("inv-1")).toEqual({ balance: 100n });
      expect(cache.get("inv-2")).toEqual({ balance: 250n });
      expect(cache.get("inv-3")).toEqual({ balance: 500n });
    });
  });

  describe("Requirement: Test partial failure", () => {
    it("safely isolates and tracks incomplete legs when some legs fail", () => {
      const coordinator = new RollbackCoordinator();
      const splitId = "split-partial-1";
      const legs = [
        { recipient: "G_REC_1", amount: 100n },
        { recipient: "G_REC_2", amount: 200n },
        { recipient: "G_REC_3", amount: 300n },
      ];

      coordinator.begin(splitId, "inv-partial-1", legs);

      // Leg 0 succeeds, Leg 1 fails, Leg 2 is untouched
      coordinator.markLegSuccess(splitId, 0);
      coordinator.markLegFailed(splitId, 1);

      const incomplete = coordinator.getIncomplete(splitId);
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0]?.recipient).toBe("G_REC_3");
      expect(incomplete[0]?.amount).toBe(300n);

      const checkpoint = coordinator.getCheckpointFor(splitId);
      expect(checkpoint?.legs[0]?.state).toBe("succeeded");
      expect(checkpoint?.legs[1]?.state).toBe("failed");
      expect(checkpoint?.legs[2]?.state).toBe("pending");
    });

    it("handles partial failure in invoice batch processor without aborting other operations", async () => {
      const mockSubmitter: InvoicePaymentSubmitter = {
        submitPayment: vi.fn(async ({ invoiceId }) => {
          if (invoiceId === "inv-fail") {
            throw new Error("RPC rejection for inv-fail");
          }
          return { txHash: `tx_${invoiceId}` };
        }),
      };

      const processor = new InvoiceBatchProcessor(mockSubmitter);
      const settled: BatchInvoiceResult[] = [];
      const failed: BatchInvoiceResult[] = [];

      processor.events.on("batchInvoiceSettled", (res) => settled.push(res));
      processor.events.on("batchInvoiceFailed", (res) => failed.push(res));

      const invoiceIds = ["inv-ok-1", "inv-fail", "inv-ok-2"];
      const amounts = {
        "inv-ok-1": 100n,
        "inv-fail": 200n,
        "inv-ok-2": 300n,
      };

      const results: BatchInvoiceResult[] = [];
      for await (const res of processor.process(invoiceIds, {
        payer: "G_PAYER",
        amounts,
        maxConcurrent: 1,
      })) {
        results.push(res);
      }

      expect(results).toHaveLength(3);
      const successfulResults = results.filter((r) => r.status === "success");
      const failedResults = results.filter((r) => r.status === "failed");

      expect(successfulResults).toHaveLength(2);
      expect(failedResults).toHaveLength(1);
      expect(failedResults[0]?.invoiceId).toBe("inv-fail");
      expect(failedResults[0]?.error).toContain("RPC rejection for inv-fail");

      expect(settled).toHaveLength(2);
      expect(failed).toHaveLength(1);
    });

    it("rejects unknown leg indices and unknown splits safely", () => {
      const coordinator = new RollbackCoordinator();
      coordinator.begin("split-known", "inv-1", [{ recipient: "G_A", amount: 10n }]);

      expect(() => coordinator.markLegSuccess("split-unknown", 0)).toThrow(UnknownSplitError);
      expect(() => coordinator.markLegSuccess("split-known", 99)).toThrow(UnknownSplitError);
      expect(() => coordinator.getIncomplete("split-nonexistent")).toThrow(UnknownSplitError);
    });
  });

  describe("Requirement: Test rollback", () => {
    it("initiates rollback snapshot for all incomplete legs and emits events", () => {
      const coordinator = new RollbackCoordinator();
      const splitId = "split-rollback-1";
      const legs = [
        { recipient: "G_A", amount: 100n },
        { recipient: "G_B", amount: 200n },
        { recipient: "G_C", amount: 300n },
      ];

      coordinator.begin(splitId, "inv-rb", legs);
      coordinator.markLegSuccess(splitId, 0);

      const initiatedEvents: unknown[] = [];
      const completedEvents: unknown[] = [];
      coordinator.on("splitRollbackInitiated", (e) => initiatedEvents.push(e));
      coordinator.on("splitRollbackCompleted", (e) => completedEvents.push(e));

      const record = coordinator.initiateRollback(splitId);

      expect(record).toBeDefined();
      expect(record.checkpoint.splitId).toBe(splitId);
      expect(record.checkpoint.legs.filter((l) => l.state === "pending")).toHaveLength(2);
      expect(record.snapshotId).toBeDefined();

      expect(initiatedEvents).toHaveLength(1);
      expect(completedEvents).toHaveLength(1);
      expect(coordinator.getRollbackRecord(splitId)).toEqual(record);

      // Rollback initiation is idempotent
      const duplicateRecord = coordinator.initiateRollback(splitId);
      expect(duplicateRecord).toEqual(record);
      expect(initiatedEvents).toHaveLength(1); // not emitted again
    });

    it("rolls back optimistic cache state on failure while keeping unaffected keys intact", () => {
      const cache = new OptimisticCache<{ balance: bigint }>();

      // Seed initial base state
      const { commit: commitBase } = cache.applyOptimistic(
        "inv-stable",
        { balance: 50n },
        { balance: 0n }
      );
      commitBase();

      const rollbackEvents: unknown[] = [];
      cache.onRollback((e) => rollbackEvents.push(e));

      const opA = cache.applyOptimistic("inv-stable", { balance: 100n }, { balance: 50n });
      const opB = cache.applyOptimistic("inv-failing", { balance: 200n }, { balance: 0n });

      expect(cache.get("inv-stable")).toEqual({ balance: 100n });
      expect(cache.get("inv-failing")).toEqual({ balance: 200n });

      // Roll back failing operation
      opB.rollback();

      expect(cache.get("inv-failing")).toEqual({ balance: 0n });
      expect(cache.get("inv-stable")).toEqual({ balance: 100n }); // unaffected
      expect(rollbackEvents).toHaveLength(1);

      // Rolling back again is safe idempotent no-op
      opB.rollback();
      expect(rollbackEvents).toHaveLength(1);
    });

    it("rolls back chained optimistic mutations in LIFO order preserving intermediate states", () => {
      const cache = new OptimisticCache<{ count: number }>();

      const op1 = cache.applyOptimistic("item-1", { count: 1 }, { count: 0 });
      const op2 = cache.applyOptimistic("item-1", { count: 2 }, { count: 1 });
      const op3 = cache.applyOptimistic("item-1", { count: 3 }, { count: 2 });

      expect(cache.get("item-1")).toEqual({ count: 3 });

      // Rolling back newest mutation (op3) restores op2's predicted value
      op3.rollback();
      expect(cache.get("item-1")).toEqual({ count: 2 });

      // Rolling back op2 restores op1's predicted value
      op2.rollback();
      expect(cache.get("item-1")).toEqual({ count: 1 });

      // Rolling back op1 restores base value
      op1.rollback();
      expect(cache.get("item-1")).toEqual({ count: 0 });
    });

    it("cleans up partial state when rollback execution times out", async () => {
      vi.useFakeTimers();
      const coordinator = new RollbackCoordinator();
      const splitId = "split-timeout-1";
      coordinator.begin(splitId, "inv-t", [{ recipient: "G_DEST", amount: 50n }]);

      const cleanupSpy = vi.fn();
      const timeoutPromise = coordinator.initiateRollbackWithTimeout(splitId, {
        timeoutMs: 150,
        execute: () => new Promise<void>(() => undefined), // never resolves
        cleanup: cleanupSpy,
      });

      const assertRejection = expect(timeoutPromise).rejects.toBeInstanceOf(RollbackTimeoutError);
      await vi.advanceTimersByTimeAsync(150);
      await assertRejection;

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(coordinator.getRollbackRecord(splitId)).toBeUndefined();
      expect(coordinator.getCheckpointFor(splitId)).toBeUndefined();

      vi.useRealTimers();
    });
  });

  describe("Requirement: Test consistency", () => {
    it("preserves exact balance conservation across split legs (no stroops created or lost)", () => {
      const totalAmount = 1000n;
      const splits: SplitLine[] = [
        { recipientId: "G_A", ratio: 0.3333333 },
        { recipientId: "G_B", ratio: 0.3333333 },
        { recipientId: "G_C", ratio: 0.3333334 },
      ];

      const audited = auditSplitRounding(totalAmount, splits);
      const sumOfAmounts = Object.values(audited.amounts).reduce((acc, v) => acc + v, 0n);

      expect(sumOfAmounts).toBe(totalAmount);
      expect(audited.total).toBe(totalAmount);
    });

    it("enforces idempotency preventing duplicate execution or duplicate rollbacks", () => {
      const idempotency = new IdempotencyManager();
      const coordinator = new RollbackCoordinator(idempotency);

      const splitId = "split-idempotent";
      coordinator.begin(splitId, "inv-idem", [{ recipient: "G_REC", amount: 100n }]);

      const record1 = coordinator.initiateRollback(splitId);
      const record2 = coordinator.initiateRollback(splitId);

      expect(record1.snapshotId).toBe(record2.snapshotId);
      expect(record1).toBe(record2);
    });

    it("detects and rejects invalid split ratios that exceed rounding threshold", () => {
      // Ratios sum to 1.5 (drastically inconsistent)
      const splits: SplitLine[] = [
        { recipientId: "G_A", ratio: 0.8 },
        { recipientId: "G_B", ratio: 0.7 },
      ];

      expect(() => auditSplitRounding(1000n, splits)).toThrow(RoundingOverflowError);
    });
  });
});
