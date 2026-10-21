import { describe, expect, it } from "vitest";
import { FraudDetectionIntegration } from "../src/fraudDetection.js";

describe("FraudDetectionIntegration", () => {
  it("allows the configured payment limit and flags payments above it", () => {
    const detector = new FraudDetectionIntegration({
      maxPaymentsPerWindow: 2,
      now: () => 100,
    });
    const payment = { payer: "GABC", amount: 10_000_000n };

    expect(detector.assessPayment(payment).flagged).toBe(false);
    expect(detector.assessPayment(payment).flagged).toBe(false);
    expect(detector.assessPayment(payment).signals).toContainEqual(
      expect.objectContaining({ kind: "VELOCITY_BREACH" }),
    );
  });

  it("emits assessed and fraud events for a blacklisted payer", () => {
    const detector = new FraudDetectionIntegration({
      blacklist: ["GBAD"],
      now: () => 100,
    });
    const assessed: unknown[] = [];
    const fraud: unknown[] = [];
    detector.on("assessed", (assessment) => assessed.push(assessment));
    detector.on("fraud", (assessment) => fraud.push(assessment));

    const result = detector.assessPayment({ payer: "GBAD", amount: 10_000_000n });

    expect(result.flagged).toBe(true);
    expect(result.riskScore).toBe(1);
    expect(assessed).toHaveLength(1);
    expect(fraud).toHaveLength(1);
    expect(fraud[0]).toMatchObject({ source: "payment", flagged: true });
  });

  it("runs custom payment rules with recent-payment context", () => {
    const detector = new FraudDetectionIntegration({
      now: () => 100,
      rules: [
        {
          id: "zero-payment",
          checkPayment: (payment, context) =>
            payment.amount === 0n && context.getRecentPayments(payment.payer).length === 1
              ? {
                  kind: "ZERO_PAYMENT",
                  reason: "Zero-value payment",
                  severity: "high",
                  detectedAt: context.now,
                }
              : null,
        },
      ],
    });

    const result = detector.assessPayment({ payer: "GPAYER", amount: 0n });

    expect(result.signals).toContainEqual(
      expect.objectContaining({ kind: "ZERO_PAYMENT", severity: "high" }),
    );
  });

  it("flags rapid invoice refunds and emits the event source", () => {
    const detector = new FraudDetectionIntegration({
      maxChurnCycles: 1,
      now: () => 100,
    });
    const fraud: unknown[] = [];
    detector.on("fraud", (assessment) => fraud.push(assessment));
    const created = {
      type: "created" as const,
      invoiceId: "invoice-1",
      data: { creator: "GCREATOR" },
      ledger: 1,
      timestamp: 100,
    };
    const refunded = { ...created, type: "refunded" as const, ledger: 2 };

    detector.assessEvent(created);
    const result = detector.assessEvent(refunded);

    expect(result.signals).toContainEqual(
      expect.objectContaining({ kind: "RAPID_INVOICE_CHURN" }),
    );
    expect(fraud[0]).toMatchObject({ source: "event", flagged: true });
  });
});