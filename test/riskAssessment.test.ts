import { describe, expect, it } from "vitest";
import { RiskAssessmentEngine } from "../src/riskAssessment.js";

const subject = {
  id: "invoice-1",
  type: "invoice",
  attributes: { amount: 100 },
};

describe("RiskAssessmentEngine", () => {
  it("combines applicable rule scores by relative weight", () => {
    const engine = new RiskAssessmentEngine({
      now: () => 123,
      rules: [
        { id: "low-factor", weight: 1, assess: () => ({ score: 0.2, reason: "Low signal" }) },
        { id: "high-factor", weight: 3, assess: () => ({ score: 0.8, reason: "High signal" }) },
        { id: "not-applicable", weight: 10, assess: () => null },
      ],
    });

    const result = engine.assess(subject);

    expect(result.score).toBeCloseTo(0.65);
    expect(result.level).toBe("high");
    expect(result.assessedAt).toBe(123);
    expect(result.factors).toHaveLength(2);
    expect(result.factors[1]).toMatchObject({ id: "high-factor", weight: 3, score: 0.8 });
  });

  it("emits assessed for every result and highRisk only for high results", () => {
    const engine = new RiskAssessmentEngine({
      rules: [{ id: "risk", weight: 1, assess: () => ({ score: 0.9, reason: "High risk" }) }],
    });
    const assessed: string[] = [];
    const highRisk: string[] = [];
    const unsubscribe = engine.on("assessed", (result) => assessed.push(result.subject.id));
    engine.on("highRisk", (result) => highRisk.push(result.subject.id));

    engine.assess(subject);
    unsubscribe();
    engine.assess({ ...subject, id: "invoice-2" });

    expect(assessed).toEqual(["invoice-1"]);
    expect(highRisk).toEqual(["invoice-1", "invoice-2"]);
  });

  it("returns a low zero score when no rules apply", () => {
    const result = new RiskAssessmentEngine().assess(subject);

    expect(result).toMatchObject({ score: 0, level: "low", factors: [] });
  });

  it("validates threshold ordering and risk rule definitions", () => {
    expect(() => new RiskAssessmentEngine({ highThreshold: 0.2 })).toThrow(RangeError);
    expect(() => new RiskAssessmentEngine({ rules: [
      { id: "duplicate", weight: 1, assess: () => null },
      { id: "duplicate", weight: 1, assess: () => null },
    ] })).toThrow(TypeError);
    expect(() => new RiskAssessmentEngine({
      rules: [{ id: "invalid-weight", weight: 0, assess: () => null }],
    })).toThrow(RangeError);
  });

  it("rejects rule scores outside the normalized range", () => {
    const engine = new RiskAssessmentEngine({
      rules: [{ id: "invalid-score", weight: 1, assess: () => ({ score: 1.1, reason: "Invalid" }) }],
    });

    expect(() => engine.assess(subject)).toThrow(RangeError);
  });
});