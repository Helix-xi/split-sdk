import { describe, expect, it } from "vitest";
import {
  PaymentRouteOptimizer,
  type PaymentRouteCandidate,
} from "../src/paymentRouteOptimizer.js";

const candidates: PaymentRouteCandidate[] = [
  { id: "cheap", fee: 1, successProbability: 0.6, latencyMs: 100, liquidity: 100 },
  { id: "reliable", fee: 10, successProbability: 1, latencyMs: 0, liquidity: 1000 },
];

describe("PaymentRouteOptimizer", () => {
  it("ranks routes using normalized cost, reliability, latency, and liquidity", () => {
    const optimizer = new PaymentRouteOptimizer();

    const result = optimizer.optimize(candidates);

    expect(result.ranked.map((route) => route.id)).toEqual(["reliable", "cheap"]);
    expect(result.recommended?.id).toBe("reliable");
    expect(result.recommended?.componentScores).toEqual({
      fee: 0,
      reliability: 1,
      latency: 1,
      liquidity: 1,
    });
    expect(result.evaluatedCount).toBe(2);
  });

  it("rejects routes that violate configured hard constraints", () => {
    const optimizer = new PaymentRouteOptimizer({
      constraints: { maxFee: 5, minSuccessProbability: 0.8 },
    });

    const result = optimizer.optimize(candidates);

    expect(result.ranked).toHaveLength(0);
    expect(result.recommended).toBeNull();
    expect(result.rejected).toEqual([
      { id: "cheap", reason: "success probability is below minSuccessProbability" },
      { id: "reliable", reason: "fee exceeds maxFee" },
    ]);
  });

  it("keeps original order when candidate scores tie", () => {
    const optimizer = new PaymentRouteOptimizer({
      weights: { fee: 0, reliability: 1, latency: 0, liquidity: 0 },
    });
    const routes = [
      { ...candidates[0], id: "first", successProbability: 0.8 },
      { ...candidates[1], id: "second", successProbability: 0.8 },
    ];

    expect(optimizer.optimize(routes).ranked.map((route) => route.id)).toEqual(["first", "second"]);
  });

  it("emits optimization and validation error events", () => {
    const optimizer = new PaymentRouteOptimizer();
    const optimized: string[] = [];
    const errors: Error[] = [];
    optimizer.on("optimized", (result) => optimized.push(result.recommended?.id ?? "none"));
    optimizer.on("error", (error) => errors.push(error));

    optimizer.optimize([]);
    expect(() => optimizer.optimize([{ ...candidates[0], successProbability: 2 }])).toThrow(RangeError);

    expect(optimized).toEqual(["none"]);
    expect(errors).toHaveLength(1);
  });

  it("rejects invalid weights and duplicate candidate IDs", () => {
    expect(() => new PaymentRouteOptimizer({ weights: { fee: -1 } })).toThrow(RangeError);
    const optimizer = new PaymentRouteOptimizer();
    expect(() => optimizer.optimize([candidates[0], { ...candidates[1], id: "cheap" }])).toThrow(TypeError);
  });
});