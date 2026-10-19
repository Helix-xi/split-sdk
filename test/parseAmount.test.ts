import { describe, it, expect } from "vitest";
import { parseAmount, formatAmount } from "../src/utils.js";

describe("parseAmount unit tests and edge cases (#1037)", () => {
  describe("Valid inputs", () => {
    it("parses whole integer strings", () => {
      expect(parseAmount("0")).toBe(0n);
      expect(parseAmount("1")).toBe(10_000_000n);
      expect(parseAmount("10")).toBe(100_000_000n);
      expect(parseAmount("1000")).toBe(10_000_000_000n);
      expect(parseAmount("999999")).toBe(9_999_990_000_000n);
    });

    it("parses single decimal place", () => {
      expect(parseAmount("0.1")).toBe(1_000_000n);
      expect(parseAmount("1.5")).toBe(15_000_000n);
      expect(parseAmount("2.9")).toBe(29_000_000n);
    });

    it("parses decimals up to 7 decimal places (stroops)", () => {
      expect(parseAmount("0.01")).toBe(100_000n);
      expect(parseAmount("0.001")).toBe(10_000n);
      expect(parseAmount("0.0001")).toBe(1_000n);
      expect(parseAmount("0.00001")).toBe(100n);
      expect(parseAmount("0.000001")).toBe(10n);
      expect(parseAmount("0.0000001")).toBe(1n);
      expect(parseAmount("1.1234567")).toBe(11_234_567n);
      expect(parseAmount("0.9999999")).toBe(9_999_999n);
    });

    it("parses leading zeros and trailing zeros", () => {
      expect(parseAmount("001.5000")).toBe(15_000_000n);
      expect(parseAmount("00000.0000000")).toBe(0n);
      expect(parseAmount("10.0000000")).toBe(100_000_000n);
      expect(parseAmount("0.0000000")).toBe(0n);
    });

    it("handles omitted whole part (.5)", () => {
      expect(parseAmount(".5")).toBe(5_000_000n);
      expect(parseAmount(".0000001")).toBe(1n);
      expect(parseAmount(".0")).toBe(0n);
    });

    it("handles omitted fractional part (5.)", () => {
      expect(parseAmount("5.")).toBe(50_000_000n);
      expect(parseAmount("0.")).toBe(0n);
    });

    it("handles empty string defaulting to zero", () => {
      expect(parseAmount("")).toBe(0n);
    });

    it("handles explicit positive sign", () => {
      expect(parseAmount("+1")).toBe(10_000_000n);
      expect(parseAmount("+1.5")).toBe(15_000_000n);
      expect(parseAmount("+0.0000001")).toBe(1n);
    });

    it("handles negative amounts correctly", () => {
      expect(parseAmount("-1")).toBe(-10_000_000n);
      expect(parseAmount("-1.5")).toBe(-15_000_000n);
      expect(parseAmount("-0.5")).toBe(-5_000_000n);
      expect(parseAmount("-0.0000001")).toBe(-1n);
      expect(parseAmount("-0")).toBe(0n);
      expect(parseAmount("-0.0")).toBe(0n);
      expect(parseAmount("-.5")).toBe(-5_000_000n);
    });
  });

  describe("Rounding and truncation", () => {
    it("truncates 8th decimal place without rounding up", () => {
      // 0.00000019 has '9' in the 8th position; must drop 9, returning 1 stroop (not 2)
      expect(parseAmount("0.00000019")).toBe(1n);
      expect(parseAmount("0.00000015")).toBe(1n);
      expect(parseAmount("0.00000011")).toBe(1n);
    });

    it("truncates sub-stroop amounts to 0", () => {
      expect(parseAmount("0.00000009")).toBe(0n);
      expect(parseAmount("0.00000001")).toBe(0n);
      expect(parseAmount("0.0000000000001")).toBe(0n);
    });

    it("truncates 8th and beyond decimal digits on large numbers", () => {
      expect(parseAmount("123.4567890123")).toBe(1_234_567_890n);
      expect(parseAmount("0.999999999999")).toBe(9_999_999n);
    });

    it("preserves exact precision up to 7 decimal digits", () => {
      const original = "12345.6789012";
      const parsed = parseAmount(original);
      expect(formatAmount(parsed)).toBe(original);
    });
  });

  describe("Boundaries", () => {
    it("handles absolute zero", () => {
      expect(parseAmount("0")).toBe(0n);
      expect(parseAmount("0.0")).toBe(0n);
      expect(parseAmount("0.0000000")).toBe(0n);
    });

    it("handles minimum non-zero representable stroop amount (1 stroop = 0.0000001)", () => {
      expect(parseAmount("0.0000001")).toBe(1n);
    });

    it("handles maximum i64 stroops (922337203685.4775807)", () => {
      const maxI64Stroops = 9223372036854775807n;
      expect(parseAmount("922337203685.4775807")).toBe(maxI64Stroops);
    });

    it("handles large amounts exceeding 64-bit integers", () => {
      const largeDecimal = "1000000000000000.1234567";
      const expected = 10000000000000001234567n;
      expect(parseAmount(largeDecimal)).toBe(expected);
    });
  });

  describe("Invalid inputs & error handling", () => {
    it("throws SyntaxError on multiple decimal points", () => {
      expect(() => parseAmount("1.2.3")).toThrow(SyntaxError);
      expect(() => parseAmount("1..2")).toThrow(SyntaxError);
      expect(() => parseAmount("..")).toThrow(SyntaxError);
      expect(() => parseAmount("1.0.0.0")).toThrow(SyntaxError);
    });

    it("throws SyntaxError on non-numeric whole parts", () => {
      expect(() => parseAmount("abc")).toThrow(SyntaxError);
      expect(() => parseAmount("abc.123")).toThrow(SyntaxError);
      expect(() => parseAmount("foo")).toThrow(SyntaxError);
    });

    it("throws SyntaxError on non-numeric fractional parts", () => {
      expect(() => parseAmount("1.2x")).toThrow(SyntaxError);
      expect(() => parseAmount("0.abc")).toThrow(SyntaxError);
      expect(() => parseAmount("1.0000000x")).toThrow(SyntaxError);
    });

    it("throws SyntaxError on special numbers and strings", () => {
      expect(() => parseAmount("NaN")).toThrow(SyntaxError);
      expect(() => parseAmount("Infinity")).toThrow(SyntaxError);
      expect(() => parseAmount("-Infinity")).toThrow(SyntaxError);
    });

    it("throws SyntaxError on scientific notation or hex", () => {
      expect(() => parseAmount("1e6")).toThrow(SyntaxError);
      expect(() => parseAmount("1e-7")).toThrow(SyntaxError);
      expect(() => parseAmount("0x10")).toThrow(SyntaxError);
    });

    it("throws SyntaxError on currency symbols or comma formatting", () => {
      expect(() => parseAmount("$100")).toThrow(SyntaxError);
      expect(() => parseAmount("1,000.50")).toThrow(SyntaxError);
      expect(() => parseAmount("100 USDC")).toThrow(SyntaxError);
    });

    it("throws SyntaxError on embedded whitespace", () => {
      expect(() => parseAmount("1 0")).toThrow(SyntaxError);
      expect(() => parseAmount("1. 5")).toThrow(SyntaxError);
    });
  });
});
