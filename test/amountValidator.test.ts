import { describe, it, expect } from "vitest";
import {
  validateAmount,
  validateAmountOrThrow,
  isValidAmount,
  parseToStroops,
  AmountValidator,
  STELLAR_MAX_INT64,
  STELLAR_MIN_AMOUNT,
  STELLAR_MAX_DECIMALS,
  STROOPS_PER_UNIT,
} from "../src/validators/amountValidator.js";
import {
  AmountValidationError,
  ValidationError,
  isAmountValidationError,
} from "../src/errors.js";

describe("AmountValidator (Issue #1063)", () => {
  describe("Range validation", () => {
    it("accepts valid positive bigint amounts", () => {
      const result = validateAmount(10_000_000n);
      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(10_000_000n);
      expect(result.errors).toHaveLength(0);
    });

    it("accepts valid decimal strings", () => {
      const result = validateAmount("1.50");
      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(15_000_000n);
    });

    it("rejects zero by default", () => {
      const result = validateAmount(0n);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("must be greater than zero");
    });

    it("accepts zero when allowZero is true", () => {
      const result = validateAmount(0n, { allowZero: true });
      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(0n);
    });

    it("rejects negative amounts by default", () => {
      const result = validateAmount(-10n);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("cannot be negative");
    });

    it("accepts negative amounts when allowNegative is true", () => {
      const result = validateAmount(-10n, { allowNegative: true });
      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(-10n);
    });

    it("enforces custom minimum bounds", () => {
      const min = 500n;

      expect(validateAmount(500n, { min }).valid).toBe(true);
      expect(validateAmount(501n, { min }).valid).toBe(true);

      const belowResult = validateAmount(499n, { min });
      expect(belowResult.valid).toBe(false);
      expect(belowResult.errors[0]).toContain("is below the minimum allowed limit of 500 stroops");
    });

    it("enforces custom maximum bounds", () => {
      const max = 1_000_000n;

      expect(validateAmount(1_000_000n, { max }).valid).toBe(true);
      expect(validateAmount(999_999n, { max }).valid).toBe(true);

      const aboveResult = validateAmount(1_000_001n, { max });
      expect(aboveResult.valid).toBe(false);
      expect(aboveResult.errors[0]).toContain("exceeds the maximum allowed limit of 1000000 stroops");
    });

    it("enforces Stellar protocol INT64_MAX bound", () => {
      // Exactly INT64_MAX -> valid
      expect(validateAmount(STELLAR_MAX_INT64).valid).toBe(true);

      // Above INT64_MAX -> invalid
      const aboveResult = validateAmount(STELLAR_MAX_INT64 + 1n);
      expect(aboveResult.valid).toBe(false);
      expect(aboveResult.errors[0]).toContain("exceeds the maximum allowed limit");
    });
  });

  describe("Precision validation", () => {
    it("accepts amounts with up to 7 decimal places (Stellar standard)", () => {
      expect(validateAmount("1.1").valid).toBe(true);
      expect(validateAmount("1.123456").valid).toBe(true);
      expect(validateAmount("1.1234567").valid).toBe(true);
      expect(validateAmount("0.0000001").valid).toBe(true);
      expect(validateAmount("0.0000001").stroops).toBe(1n);
    });

    it("rejects amounts exceeding 7 decimal places", () => {
      const result = validateAmount("1.12345678");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Amount precision (8 decimals) exceeds maximum allowed 7 decimal places");
    });

    it("enforces custom maxDecimals limit", () => {
      const options = { maxDecimals: 2 };

      expect(validateAmount("10.5", options).valid).toBe(true);
      expect(validateAmount("10.55", options).valid).toBe(true);

      const exceedResult = validateAmount("10.555", options);
      expect(exceedResult.valid).toBe(false);
      expect(exceedResult.errors[0]).toContain("Amount precision (3 decimals) exceeds maximum allowed 2 decimal places");
    });

    it("rejects scientific notation", () => {
      const result = validateAmount("1e-5");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Scientific notation is not supported");
    });

    it("rejects malformed number strings", () => {
      expect(validateAmount("1.2.3").valid).toBe(false);
      expect(validateAmount("abc").valid).toBe(false);
      expect(validateAmount("").valid).toBe(false);
      expect(validateAmount("   ").valid).toBe(false);
    });

    it("handles decimal strings with leading dot or trailing dot", () => {
      expect(validateAmount(".5").valid).toBe(true);
      expect(validateAmount(".5").stroops).toBe(5_000_000n);

      expect(validateAmount("5.").valid).toBe(true);
      expect(validateAmount("5.").stroops).toBe(50_000_000n);
    });
  });

  describe("Boundaries and edge cases", () => {
    it("validates smallest possible non-zero amount (1 stroop)", () => {
      expect(validateAmount(STELLAR_MIN_AMOUNT).valid).toBe(true);
      expect(validateAmount(STELLAR_MIN_AMOUNT).stroops).toBe(1n);
    });

    it("rejects null, undefined, and non-numeric types", () => {
      expect(validateAmount(null).valid).toBe(false);
      expect(validateAmount(undefined).valid).toBe(false);
      expect(validateAmount(true).valid).toBe(false);
      expect(validateAmount({}).valid).toBe(false);
      expect(validateAmount(NaN).valid).toBe(false);
      expect(validateAmount(Infinity).valid).toBe(false);
    });

    it("rejects fractional numbers when unit is explicitly stroops", () => {
      const result = validateAmount(10.5, { unit: "stroops" });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Stroop amounts must be integers");
    });
  });

  describe("validateAmountOrThrow", () => {
    it("returns bigint stroops on valid input", () => {
      const stroops = validateAmountOrThrow("2.5");
      expect(stroops).toBe(25_000_000n);
    });

    it("throws AmountValidationError on invalid input", () => {
      expect(() => validateAmountOrThrow("-1")).toThrow(AmountValidationError);

      try {
        validateAmountOrThrow("0");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AmountValidationError);
        expect(err).toBeInstanceOf(ValidationError);
        expect(isAmountValidationError(err)).toBe(true);
        expect((err as AmountValidationError).code).toBe("AMOUNT_VALIDATION_ERROR");
      }
    });
  });

  describe("isValidAmount helper", () => {
    it("returns boolean correctly", () => {
      expect(isValidAmount(100n)).toBe(true);
      expect(isValidAmount(-100n)).toBe(false);
      expect(isValidAmount("invalid")).toBe(false);
    });
  });

  describe("parseToStroops utility", () => {
    it("parses diverse inputs to stroops", () => {
      expect(parseToStroops(500n)).toBe(500n);
      expect(parseToStroops("1.0")).toBe(10_000_000n);
      expect(parseToStroops("0.0000001")).toBe(1n);
      expect(parseToStroops(5, "decimal")).toBe(50_000_000n);
    });

    it("throws on precision violation or bad format", () => {
      expect(() => parseToStroops("1.12345678")).toThrow(AmountValidationError);
      expect(() => parseToStroops("bad")).toThrow(AmountValidationError);
    });
  });

  describe("AmountValidator class", () => {
    it("reuses default options across validation calls", () => {
      const validator = new AmountValidator({
        min: 1_000n,
        max: 50_000n,
      });

      expect(validator.validate(25_000n).valid).toBe(true);
      expect(validator.validate(500n).valid).toBe(false);
      expect(validator.validate(60_000n).valid).toBe(false);

      expect(() => validator.validateOrThrow(500n)).toThrow(AmountValidationError);
    });
  });
});
