import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  InvoiceRecommendationEngine,
  type RecommendationContext,
  type RecommendationSignal,
} from "../src/invoiceRecommendation.js";
import type { Invoice } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000; // fixed "now" in seconds

function makeInvoice(overrides: Partial<Invoice> & { id: string }): Invoice {
  return {
    id: overrides.id,
    creator: overrides.creator ?? "GCREATOR",
    recipients: overrides.recipients ?? [{ address: "GRECIPIENT", amount: 100n }],
    token: overrides.token ?? "USDC",
    deadline: overrides.deadline ?? NOW + 86_400 * 3, // 3 days from now
    funded: overrides.funded ?? 0n,
    status: overrides.status ?? "Pending",
    payments: overrides.payments ?? [],
    ...overrides,
  };
}

const ctx: RecommendationContext = { userId: "GUSER", nowSeconds: NOW };

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("InvoiceRecommendationEngine — constructor", () => {
  it("creates with default options", () => {
    const engine = new InvoiceRecommendationEngine();
    expect(engine).toBeTruthy();
  });

  it("throws when topK < 1", () => {
    expect(() => new InvoiceRecommendationEngine({ topK: 0 })).toThrow("topK");
  });

  it("throws when minScore is out of range", () => {
    expect(() => new InvoiceRecommendationEngine({ minScore: 1.5 })).toThrow("minScore");
    expect(() => new InvoiceRecommendationEngine({ minScore: -0.1 })).toThrow("minScore");
  });

  it("accepts minScore edge values 0 and 1", () => {
    expect(() => new InvoiceRecommendationEngine({ minScore: 0 })).not.toThrow();
    expect(() => new InvoiceRecommendationEngine({ minScore: 1 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Signal management
// ---------------------------------------------------------------------------

describe("InvoiceRecommendationEngine — signal management", () => {
  let engine: InvoiceRecommendationEngine;

  beforeEach(() => {
    engine = new InvoiceRecommendationEngine();
  });

  it("has three built-in signals by default", () => {
    expect(engine.getSignals()).toHaveLength(3);
    const names = engine.getSignals().map((s) => s.name);
    expect(names).toContain("urgency");
    expect(names).toContain("fundingProgress");
    expect(names).toContain("userRelevance");
  });

  it("registerSignal adds a new signal", () => {
    const custom: RecommendationSignal = { name: "custom", weight: 1, score: () => 0.5 };
    engine.registerSignal(custom);
    expect(engine.getSignals()).toHaveLength(4);
  });

  it("registerSignal replaces an existing signal with the same name", () => {
    const updated: RecommendationSignal = { name: "urgency", weight: 3, score: () => 1 };
    engine.registerSignal(updated);
    expect(engine.getSignals()).toHaveLength(3);
    const found = engine.getSignals().find((s) => s.name === "urgency");
    expect(found?.weight).toBe(3);
  });

  it("registerSignal throws when name is empty", () => {
    expect(() =>
      engine.registerSignal({ name: "", weight: 1, score: () => 0 })
    ).toThrow("Signal name");
  });

  it("registerSignal throws when weight <= 0", () => {
    expect(() =>
      engine.registerSignal({ name: "bad", weight: 0, score: () => 0 })
    ).toThrow("weight");
  });

  it("removeSignal removes an existing signal", () => {
    engine.removeSignal("urgency");
    const names = engine.getSignals().map((s) => s.name);
    expect(names).not.toContain("urgency");
    expect(engine.getSignals()).toHaveLength(2);
  });

  it("removeSignal is a no-op for unknown signal names", () => {
    engine.removeSignal("nonexistent");
    expect(engine.getSignals()).toHaveLength(3);
  });

  it("resetSignals restores the three default signals", () => {
    engine.removeSignal("urgency");
    engine.removeSignal("fundingProgress");
    engine.resetSignals();
    expect(engine.getSignals()).toHaveLength(3);
    expect(engine.getSignals().map((s) => s.name)).toContain("urgency");
  });

  it("getSignals returns a copy — mutations do not affect the engine", () => {
    const signals = engine.getSignals();
    signals.push({ name: "extra", weight: 1, score: () => 0 });
    expect(engine.getSignals()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Core recommendation — eligibility
// ---------------------------------------------------------------------------

describe("InvoiceRecommendationEngine — eligibility filtering", () => {
  let engine: InvoiceRecommendationEngine;

  beforeEach(() => {
    engine = new InvoiceRecommendationEngine();
  });

  it("returns empty array for empty input", () => {
    expect(engine.recommend([], ctx)).toEqual([]);
  });

  it("throws when userId is empty", () => {
    expect(() => engine.recommend([], { userId: "" })).toThrow("userId");
  });

  it("excludes non-Pending invoices by default", () => {
    const invoices = [
      makeInvoice({ id: "1", status: "Released" }),
      makeInvoice({ id: "2", status: "Refunded" }),
      makeInvoice({ id: "3", status: "Cancelled" }),
      makeInvoice({ id: "4", status: "Pending" }),
    ];
    const results = engine.recommend(invoices, ctx);
    expect(results).toHaveLength(1);
    expect(results[0].invoice.id).toBe("4");
  });

  it("respects custom eligibleStatuses option", () => {
    const engine2 = new InvoiceRecommendationEngine({ eligibleStatuses: ["Released"] });
    const invoices = [
      makeInvoice({ id: "1", status: "Pending" }),
      makeInvoice({ id: "2", status: "Released" }),
    ];
    const results = engine2.recommend(invoices, ctx);
    expect(results).toHaveLength(1);
    expect(results[0].invoice.id).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// Core recommendation — scoring
// ---------------------------------------------------------------------------

describe("InvoiceRecommendationEngine — scoring", () => {
  it("score is normalised to [0, 1]", () => {
    const engine = new InvoiceRecommendationEngine();
    const invoices = [makeInvoice({ id: "1", creator: ctx.userId })];
    const [rec] = engine.recommend(invoices, ctx);
    expect(rec.score).toBeGreaterThanOrEqual(0);
    expect(rec.score).toBeLessThanOrEqual(1);
  });

  it("breakdown contains one entry per registered signal", () => {
    const engine = new InvoiceRecommendationEngine();
    const [rec] = engine.recommend([makeInvoice({ id: "1" })], ctx);
    expect(Object.keys(rec.breakdown)).toEqual(
      expect.arrayContaining(["urgency", "fundingProgress", "userRelevance"])
    );
  });

  it("urgency signal scores 1 for invoices expiring within 24h", () => {
    const engine = new InvoiceRecommendationEngine();
    engine.removeSignal("fundingProgress").removeSignal("userRelevance");
    const inv = makeInvoice({ id: "1", deadline: NOW + 3_600 }); // 1 hour away
    const [rec] = engine.recommend([inv], ctx);
    expect(rec.breakdown["urgency"]).toBe(1);
  });

  it("urgency signal scores 0 for invoices with deadline >= 7 days", () => {
    const engine = new InvoiceRecommendationEngine();
    engine.removeSignal("fundingProgress").removeSignal("userRelevance");
    const inv = makeInvoice({ id: "1", deadline: NOW + 86_400 * 8 });
    const [rec] = engine.recommend([inv], ctx);
    expect(rec.breakdown["urgency"]).toBe(0);
  });

  it("urgency signal scores 0 for expired invoices", () => {
    const engine = new InvoiceRecommendationEngine();
    engine.removeSignal("fundingProgress").removeSignal("userRelevance");
    const inv = makeInvoice({ id: "1", deadline: NOW - 1 });
    const [rec] = engine.recommend([inv], ctx);
    expect(rec.breakdown["urgency"]).toBe(0);
  });

  it("fundingProgress signal scores 1 for fully funded invoices", () => {
    const engine = new InvoiceRecommendationEngine();
    engine.removeSignal("urgency").removeSignal("userRelevance");
    const inv = makeInvoice({
      id: "1",
      recipients: [{ address: "GREC", amount: 100n }],
      funded: 100n,
    });
    const [rec] = engine.recommend([inv], ctx);
    expect(rec.breakdown["fundingProgress"]).toBe(1);
  });

  it("fundingProgress signal scores 0 for invoices with no recipients", () => {
    const engine = new InvoiceRecommendationEngine();
    engine.removeSignal("urgency").removeSignal("userRelevance");
    const inv = makeInvoice({ id: "1", recipients: [], funded: 0n });
    const [rec] = engine.recommend([inv], ctx);
    expect(rec.breakdown["fundingProgress"]).toBe(0);
  });

  it("userRelevance scores 1 when userId is creator", () => {
    const engine = new InvoiceRecommendationEngine();
    engine.removeSignal("urgency").removeSignal("fundingProgress");
    const inv = makeInvoice({ id: "1", creator: ctx.userId });
    const [rec] = engine.recommend([inv], ctx);
    expect(rec.breakdown["userRelevance"]).toBe(1);
  });

  it("userRelevance scores 0.8 when userId is a recipient", () => {
    const engine = new InvoiceRecommendationEngine();
    engine.removeSignal("urgency").removeSignal("fundingProgress");
    const inv = makeInvoice({
      id: "1",
      creator: "GOTHER",
      recipients: [{ address: ctx.userId, amount: 50n }],
    });
    const [rec] = engine.recommend([inv], ctx);
    expect(rec.breakdown["userRelevance"]).toBe(0.8);
  });

  it("userRelevance scores 0 when userId is neither creator nor recipient", () => {
    const engine = new InvoiceRecommendationEngine();
    engine.removeSignal("urgency").removeSignal("fundingProgress");
    const inv = makeInvoice({ id: "1", creator: "GOTHER" });
    const [rec] = engine.recommend([inv], ctx);
    expect(rec.breakdown["userRelevance"]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// topK and minScore
// ---------------------------------------------------------------------------

describe("InvoiceRecommendationEngine — topK and minScore", () => {
  it("limits results to topK", () => {
    const engine = new InvoiceRecommendationEngine({ topK: 2 });
    const invoices = Array.from({ length: 5 }, (_, i) =>
      makeInvoice({ id: String(i + 1), creator: ctx.userId })
    );
    expect(engine.recommend(invoices, ctx)).toHaveLength(2);
  });

  it("excludes invoices scoring below minScore", () => {
    const engine = new InvoiceRecommendationEngine({ minScore: 0.99 });
    // Only userRelevance=1 signal — max score with equal weights won't reach 0.99
    // unless we set up a high-scoring invoice
    engine.removeSignal("urgency").removeSignal("fundingProgress");
    engine.registerSignal({ name: "userRelevance", weight: 1, score: () => 0 });
    const invoices = [makeInvoice({ id: "1" })];
    expect(engine.recommend(invoices, ctx)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deterministic sorting
// ---------------------------------------------------------------------------

describe("InvoiceRecommendationEngine — deterministic tie-breaking", () => {
  it("breaks ties by invoice id (ascending) for stable ordering", () => {
    const engine = new InvoiceRecommendationEngine();
    // All signals fixed to 0.5 → equal scores
    engine.registerSignal({ name: "urgency", weight: 1, score: () => 0.5 });
    engine.registerSignal({ name: "fundingProgress", weight: 1, score: () => 0.5 });
    engine.registerSignal({ name: "userRelevance", weight: 1, score: () => 0.5 });

    const invoices = ["c", "a", "b"].map((id) => makeInvoice({ id }));
    const results = engine.recommend(invoices, ctx);
    expect(results.map((r) => r.invoice.id)).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("InvoiceRecommendationEngine — events", () => {
  let engine: InvoiceRecommendationEngine;

  beforeEach(() => {
    engine = new InvoiceRecommendationEngine();
  });

  it("emits 'scored' with all scored invoices before truncation", () => {
    const handler = vi.fn();
    engine.on("scored", handler);

    const invoices = Array.from({ length: 3 }, (_, i) =>
      makeInvoice({ id: String(i + 1) })
    );
    engine.recommend(invoices, { ...ctx });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toHaveLength(3);
  });

  it("emits 'recommended' with the final truncated list", () => {
    const handler = vi.fn();
    const engine2 = new InvoiceRecommendationEngine({ topK: 1 });
    engine2.on("recommended", handler);

    const invoices = Array.from({ length: 3 }, (_, i) =>
      makeInvoice({ id: String(i + 1) })
    );
    engine2.recommend(invoices, ctx);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toHaveLength(1);
  });

  it("emits 'error' when a signal throws and continues scoring other invoices", () => {
    const errorHandler = vi.fn();
    engine.on("error", errorHandler);
    engine.registerSignal({
      name: "bomb",
      weight: 1,
      score() {
        throw new Error("signal error");
      },
    });

    const invoices = [makeInvoice({ id: "1" }), makeInvoice({ id: "2" })];
    const results = engine.recommend(invoices, ctx);

    expect(errorHandler).toHaveBeenCalledTimes(2);
    // Bomb threw on both — they are excluded from results
    expect(results).toHaveLength(0);
  });

  it("off() removes a listener", () => {
    const handler = vi.fn();
    engine.on("recommended", handler);
    engine.off("recommended", handler);
    engine.recommend([makeInvoice({ id: "1" })], ctx);
    expect(handler).not.toHaveBeenCalled();
  });
});
