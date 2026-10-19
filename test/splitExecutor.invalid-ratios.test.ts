import { afterEach, describe, expect, it, vi } from "vitest";
import {
  splitExecutor,
  SplitRatioSumError,
  SPLIT_RATIO_TOLERANCE,
  validateSplitRatioSum,
  type SplitRecipient,
} from "../src/payments/splitExecutor.js";
import { checkSubentryCapacity } from "../src/account/subentryGuard.js";

// Isolate ratio pre-flight from the Horizon-backed capacity guard. Invalid
// ratios must fail before this dependency is called.
vi.mock("../src/account/subentryGuard.js", () => ({
  checkSubentryCapacity: vi.fn().mockResolvedValue({ available: 1, limit: 1 }),
  SubentryCapacityGuardError: class extends Error {},
}));

const A = "GABC00000000000000000000000000000000000000000000000000AA";
const B = "GDEF00000000000000000000000000000000000000000000000000BB";
const r = (address: string, ratio?: number): SplitRecipient => ({
  address,
  amount: 1_000_000n,
  ...(ratio === undefined ? {} : { ratio }),
});

afterEach(() => vi.clearAllMocks());

describe("split ratio leg validation", () => {
  it("rejects out-of-range ratios even when their hostile aggregate equals 1", () => {
    expect(() => validateSplitRatioSum([r(A, -1), r(B, 2)])).toThrow(
      SplitRatioSumError,
    );
  });

  it.each([
    ["NaN", Number.NaN, 1],
    ["opposite infinities", Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
  ])("rejects non-finite %s ratios", (_label, a, b) => {
    expect(() => validateSplitRatioSum([r(A, a), r(B, b)])).toThrow(
      SplitRatioSumError,
    );
  });

  it("accepts zero and one at the allowed boundaries", () => {
    expect(validateSplitRatioSum([r(A, 0), r(B, 1)])).toBe(1);
  });

  it("preserves the floating-point sum tolerance", () => {
    const actual = validateSplitRatioSum([
      r(A, 0.7), r(B, 0.2), r("GC", 0.1),
    ]);
    expect(Math.abs(actual - 1)).toBeLessThanOrEqual(SPLIT_RATIO_TOLERANCE);
  });

  it("preserves the existing error fields for an under-allocated split", () => {
    try {
      validateSplitRatioSum([r(A, 0.5), r(B, 0.4)]);
      throw new Error("expected ratio validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SplitRatioSumError);
      expect(error).toMatchObject({
        code: "SPLIT_RATIO_SUM_INVALID",
        actualSum: 0.9,
        expectedSum: 1,
        tolerance: SPLIT_RATIO_TOLERANCE,
      });
    }
  });
});

describe("splitExecutor ratio pre-flight", () => {
  it("rejects individually invalid ratios before any other pre-flight work", async () => {
    await expect(splitExecutor([r(A, -1), r(B, 2)])).rejects.toBeInstanceOf(
      SplitRatioSumError,
    );
    expect(checkSubentryCapacity).not.toHaveBeenCalled();
  });

  it.each([
    ["NaN", Number.NaN, 1],
    ["opposite infinities", Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
  ])("rejects %s before capacity work", async (_label, a, b) => {
    await expect(splitExecutor([r(A, a), r(B, b)])).rejects.toBeInstanceOf(
      SplitRatioSumError,
    );
    expect(checkSubentryCapacity).not.toHaveBeenCalled();
  });

  it("leaves amount-only splits unaffected", async () => {
    const result = await splitExecutor([r(A), r(B)], {
      skipCapacityCheck: true,
    });
    expect(result.success).toBe(true);
    expect(checkSubentryCapacity).not.toHaveBeenCalled();
  });
});
