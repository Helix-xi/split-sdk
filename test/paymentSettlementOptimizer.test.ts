import { describe, expect, it, vi } from "vitest";
import {
  PaymentSettlementOptimizer,
  estimateBatchFee,
  reorderForOptimalSettlement,
} from "../src/paymentSettlementOptimizer.js";
import type { PendingPayment } from "../src/paymentSettlementOptimizer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayment(overrides: Partial<PendingPayment> & { id: string }): PendingPayment {
  return {
    from: "GPAYER",
    to: "GRECIP",
    amount: 1_000n,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("estimateBatchFee()", () => {
  it("returns 0 for zero operations", () => {
    expect(estimateBatchFee(0)).toBe(0);
  });

  it("returns base fee for a single operation", () => {
    expect(estimateBatchFee(1)).toBe(100);
  });

  it("adds marginal fee for additional operations", () => {
    // 100 + (2-1)*50 = 150
    expect(estimateBatchFee(2)).toBe(150);
    // 100 + 2*50 = 200
    expect(estimateBatchFee(3)).toBe(200);
  });
});

describe("reorderForOptimalSettlement()", () => {
  it("returns a new array (does not mutate input)", () => {
    const payments = [makePayment({ id: "p1" })];
    const result = reorderForOptimalSettlement(payments);
    expect(result).not.toBe(payments);
  });

  it("sorts by priority descending", () => {
    const payments = [
      makePayment({ id: "p1", priority: 1 }),
      makePayment({ id: "p2", priority: 5 }),
      makePayment({ id: "p3", priority: 3 }),
    ];
    const result = reorderForOptimalSettlement(payments);
    expect(result.map((p) => p.id)).toEqual(["p2", "p3", "p1"]);
  });

  it("sorts by amount descending when priority is equal", () => {
    const payments = [
      makePayment({ id: "p1", amount: 100n }),
      makePayment({ id: "p2", amount: 500n }),
      makePayment({ id: "p3", amount: 300n }),
    ];
    const result = reorderForOptimalSettlement(payments);
    expect(result.map((p) => p.id)).toEqual(["p2", "p3", "p1"]);
  });

  it("treats missing priority as 0", () => {
    const payments = [
      makePayment({ id: "p1", amount: 100n }),
      makePayment({ id: "p2", priority: 1, amount: 50n }),
    ];
    const result = reorderForOptimalSettlement(payments);
    expect(result[0]!.id).toBe("p2");
  });
});

describe("PaymentSettlementOptimizer", () => {
  // ── optimize() — empty input ───────────────────────────────────────────────

  describe("optimize() with empty input", () => {
    it("returns zeroed plan", () => {
      const optimizer = new PaymentSettlementOptimizer();
      const plan = optimizer.optimize([]);

      expect(plan.batches).toEqual([]);
      expect(plan.totalPayments).toBe(0);
      expect(plan.totalAmount).toBe(0n);
      expect(plan.totalEstimatedFeeStroops).toBe(0);
      expect(plan.operationsSaved).toBe(0);
    });

    it("still fires registered callback", () => {
      const optimizer = new PaymentSettlementOptimizer();
      const cb = vi.fn();
      optimizer.onSettlementReady(cb);
      optimizer.optimize([]);
      expect(cb).toHaveBeenCalledOnce();
    });
  });

  // ── batching by recipient ──────────────────────────────────────────────────

  describe("recipient batching", () => {
    it("groups payments to the same recipient into one batch", () => {
      const optimizer = new PaymentSettlementOptimizer();
      const payments = [
        makePayment({ id: "p1", to: "R1", amount: 200n }),
        makePayment({ id: "p2", to: "R1", amount: 300n }),
        makePayment({ id: "p3", to: "R2", amount: 500n }),
      ];

      const plan = optimizer.optimize(payments, "minimize-fees");

      expect(plan.batches).toHaveLength(2);
      const r1batch = plan.batches.find((b) => b.recipients.includes("R1"))!;
      expect(r1batch.payments).toHaveLength(2);
      expect(r1batch.totalAmount).toBe(500n);
    });

    it("counts operations saved correctly", () => {
      const optimizer = new PaymentSettlementOptimizer();
      // 4 payments → 2 recipients → 2 batches → saved 4-2=2
      const payments = [
        makePayment({ id: "p1", to: "R1" }),
        makePayment({ id: "p2", to: "R1" }),
        makePayment({ id: "p3", to: "R2" }),
        makePayment({ id: "p4", to: "R2" }),
      ];

      const plan = optimizer.optimize(payments);
      expect(plan.operationsSaved).toBe(2);
    });

    it("operationsSaved is 0 when all recipients are unique", () => {
      const optimizer = new PaymentSettlementOptimizer();
      const payments = [
        makePayment({ id: "p1", to: "R1" }),
        makePayment({ id: "p2", to: "R2" }),
      ];

      const plan = optimizer.optimize(payments);
      expect(plan.operationsSaved).toBe(0);
    });
  });

  // ── strategies ────────────────────────────────────────────────────────────

  describe("strategy: minimize-fees", () => {
    it("assigns correct strategy label", () => {
      const optimizer = new PaymentSettlementOptimizer();
      const plan = optimizer.optimize([makePayment({ id: "p1" })], "minimize-fees");
      expect(plan.strategy).toBe("minimize-fees");
    });

    it("sorts batches by fee ascending", () => {
      const optimizer = new PaymentSettlementOptimizer();
      // R1 gets 3 payments (higher fee), R2 gets 1 payment (lower fee)
      const payments = [
        makePayment({ id: "p1", to: "R1" }),
        makePayment({ id: "p2", to: "R1" }),
        makePayment({ id: "p3", to: "R1" }),
        makePayment({ id: "p4", to: "R2" }),
      ];

      const plan = optimizer.optimize(payments, "minimize-fees");
      // First batch should be the cheaper one (1 payment → fee=100)
      expect(plan.batches[0]!.recipients[0]).toBe("R2");
    });
  });

  describe("strategy: maximize-throughput", () => {
    it("assigns correct strategy label", () => {
      const optimizer = new PaymentSettlementOptimizer();
      const plan = optimizer.optimize(
        [makePayment({ id: "p1" })],
        "maximize-throughput"
      );
      expect(plan.strategy).toBe("maximize-throughput");
    });

    it("sorts batches by payment count descending", () => {
      const optimizer = new PaymentSettlementOptimizer();
      const payments = [
        makePayment({ id: "p1", to: "R1" }),
        makePayment({ id: "p2", to: "R2" }),
        makePayment({ id: "p3", to: "R2" }),
        makePayment({ id: "p4", to: "R2" }),
      ];

      const plan = optimizer.optimize(payments, "maximize-throughput");
      expect(plan.batches[0]!.recipients[0]).toBe("R2");
      expect(plan.batches[0]!.payments).toHaveLength(3);
    });
  });

  describe("strategy: balanced", () => {
    it("sorts batches by total amount descending", () => {
      const optimizer = new PaymentSettlementOptimizer();
      const payments = [
        makePayment({ id: "p1", to: "R1", amount: 100n }),
        makePayment({ id: "p2", to: "R2", amount: 9_000n }),
      ];

      const plan = optimizer.optimize(payments, "balanced");
      expect(plan.batches[0]!.recipients[0]).toBe("R2");
    });
  });

  // ── totals ─────────────────────────────────────────────────────────────────

  describe("totals", () => {
    it("sums totalAmount across all batches", () => {
      const optimizer = new PaymentSettlementOptimizer();
      const payments = [
        makePayment({ id: "p1", to: "R1", amount: 500n }),
        makePayment({ id: "p2", to: "R2", amount: 300n }),
      ];

      const plan = optimizer.optimize(payments);
      expect(plan.totalAmount).toBe(800n);
    });

    it("sums totalEstimatedFeeStroops across all batches", () => {
      const optimizer = new PaymentSettlementOptimizer();
      const payments = [
        makePayment({ id: "p1", to: "R1" }),
        makePayment({ id: "p2", to: "R2" }),
      ];

      const plan = optimizer.optimize(payments);
      // Each batch has 1 payment → fee = 100 per batch → total = 200
      expect(plan.totalEstimatedFeeStroops).toBe(200);
    });
  });

  // ── onSettlementReady() ────────────────────────────────────────────────────

  describe("onSettlementReady()", () => {
    it("fires callback with the plan", () => {
      const optimizer = new PaymentSettlementOptimizer();
      const cb = vi.fn();
      optimizer.onSettlementReady(cb);

      const plan = optimizer.optimize([makePayment({ id: "p1" })]);
      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith(plan);
    });

    it("unsubscribe prevents future calls", () => {
      const optimizer = new PaymentSettlementOptimizer();
      const cb = vi.fn();
      const unsub = optimizer.onSettlementReady(cb);
      unsub();

      optimizer.optimize([makePayment({ id: "p1" })]);
      expect(cb).not.toHaveBeenCalled();
    });

    it("multiple callbacks fire in order", () => {
      const optimizer = new PaymentSettlementOptimizer();
      const order: number[] = [];
      optimizer.onSettlementReady(() => order.push(1));
      optimizer.onSettlementReady(() => order.push(2));

      optimizer.optimize([]);
      expect(order).toEqual([1, 2]);
    });
  });

  // ── estimateFees() ─────────────────────────────────────────────────────────

  describe("estimateFees()", () => {
    it("delegates to estimateBatchFee helper", () => {
      const optimizer = new PaymentSettlementOptimizer();
      const plan = optimizer.optimize([
        makePayment({ id: "p1", to: "R1" }),
        makePayment({ id: "p2", to: "R1" }),
      ]);

      const batch = plan.batches[0]!;
      expect(optimizer.estimateFees(batch)).toBe(estimateBatchFee(2));
    });
  });
});
