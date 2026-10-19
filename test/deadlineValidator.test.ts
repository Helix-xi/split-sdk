import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateDeadline,
  validateDeadlineOrThrow,
  isFutureDeadline,
  parseDeadline,
  DeadlineValidator,
  MAX_U64,
  MS_TIMESTAMP_THRESHOLD,
} from "../src/validators/deadlineValidator.js";
import {
  DeadlineValidationError,
  ValidationError,
  isDeadlineValidationError,
} from "../src/errors.js";

const BASE_TIME_SEC = 1_770_000_000n; // Fixed reference time in seconds
const BASE_TIME_MS = Number(BASE_TIME_SEC) * 1000;

describe("DeadlineValidator (Issue #1064)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Format validation", () => {
    it("accepts a valid future bigint in seconds", () => {
      const deadline = BASE_TIME_SEC + 3600n;
      const result = validateDeadline(deadline);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.deadlineSeconds).toBe(deadline);
    });

    it("accepts a valid future number in seconds", () => {
      const deadline = Number(BASE_TIME_SEC) + 7200;
      const result = validateDeadline(deadline);

      expect(result.valid).toBe(true);
      expect(result.deadlineSeconds).toBe(BigInt(deadline));
    });

    it("automatically normalizes millisecond timestamps to seconds", () => {
      const msTimestamp = (Number(BASE_TIME_SEC) + 3600) * 1000;
      expect(BigInt(msTimestamp)).toBeGreaterThanOrEqual(MS_TIMESTAMP_THRESHOLD);

      const result = validateDeadline(msTimestamp);
      expect(result.valid).toBe(true);
      expect(result.deadlineSeconds).toBe(BASE_TIME_SEC + 3600n);
    });

    it("accepts a valid future Date object", () => {
      const futureDate = new Date(BASE_TIME_MS + 86400 * 1000);
      const result = validateDeadline(futureDate);

      expect(result.valid).toBe(true);
      expect(result.deadlineSeconds).toBe(BASE_TIME_SEC + 86400n);
    });

    it("accepts an ISO-8601 string in the future", () => {
      const futureDate = new Date(BASE_TIME_MS + 3600 * 1000);
      const isoStr = futureDate.toISOString();

      const result = validateDeadline(isoStr);
      expect(result.valid).toBe(true);
      expect(result.deadlineSeconds).toBe(BASE_TIME_SEC + 3600n);
    });

    it("accepts a numeric string representing seconds", () => {
      const target = BASE_TIME_SEC + 5000n;
      const result = validateDeadline(target.toString());

      expect(result.valid).toBe(true);
      expect(result.deadlineSeconds).toBe(target);
    });

    it("rejects null and undefined", () => {
      expect(validateDeadline(null).valid).toBe(false);
      expect(validateDeadline(undefined).valid).toBe(false);
    });

    it("rejects empty string and whitespace", () => {
      expect(validateDeadline("").valid).toBe(false);
      expect(validateDeadline("   ").valid).toBe(false);
    });

    it("rejects non-numeric, non-date strings", () => {
      const result = validateDeadline("invalid-date-string");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Invalid deadline string format");
    });

    it("rejects non-finite numbers (NaN, Infinity)", () => {
      expect(validateDeadline(NaN).valid).toBe(false);
      expect(validateDeadline(Infinity).valid).toBe(false);
      expect(validateDeadline(-Infinity).valid).toBe(false);
    });

    it("rejects unsupported types (boolean, symbol, object)", () => {
      expect(validateDeadline(true).valid).toBe(false);
      expect(validateDeadline(Symbol("deadline")).valid).toBe(false);
      expect(validateDeadline({ foo: "bar" }).valid).toBe(false);
    });

    it("rejects invalid Date objects", () => {
      const invalidDate = new Date("invalid");
      const result = validateDeadline(invalidDate);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("NaN timestamp");
    });

    it("rejects negative and zero deadlines", () => {
      expect(validateDeadline(0n).valid).toBe(false);
      expect(validateDeadline(-100n).valid).toBe(false);
      expect(validateDeadline(-1).valid).toBe(false);
    });

    it("rejects values exceeding Soroban u64 limit", () => {
      const overflow = MAX_U64 + 1n;
      const result = validateDeadline(overflow, { autoConvertMs: false });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("exceeds maximum 64-bit unsigned integer limit");
    });
  });

  describe("Future validation requirements", () => {
    it("fails when deadline is in the past", () => {
      const pastDeadline = BASE_TIME_SEC - 3600n;
      const result = validateDeadline(pastDeadline);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("must be in the future");
    });

    it("fails when deadline is exactly equal to current reference time", () => {
      const result = validateDeadline(BASE_TIME_SEC);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("must be in the future");
    });

    it("passes when deadline is strictly 1 second in the future", () => {
      const result = validateDeadline(BASE_TIME_SEC + 1n);

      expect(result.valid).toBe(true);
      expect(result.deadlineSeconds).toBe(BASE_TIME_SEC + 1n);
    });

    it("enforces custom referenceTime parameter", () => {
      const customRef = 2_000_000_000n;
      const deadline = 2_000_000_500n;

      const result = validateDeadline(deadline, { referenceTime: customRef });
      expect(result.valid).toBe(true);

      const pastResult = validateDeadline(customRef - 10n, { referenceTime: customRef });
      expect(pastResult.valid).toBe(false);
    });

    it("enforces minLeadSeconds constraint", () => {
      const minLead = 3600; // 1 hour lead time required

      // Exactly at minLead -> passes
      const exactResult = validateDeadline(BASE_TIME_SEC + 3600n, { minLeadSeconds: minLead });
      expect(exactResult.valid).toBe(true);

      // 1 second below minLead -> fails
      const belowResult = validateDeadline(BASE_TIME_SEC + 3599n, { minLeadSeconds: minLead });
      expect(belowResult.valid).toBe(false);
      expect(belowResult.errors[0]).toContain("must be at least 3600 seconds in the future");
    });

    it("enforces maxFutureSeconds constraint", () => {
      const maxFuture = 86400 * 30; // 30 days max

      // Within limit -> passes
      const validResult = validateDeadline(BASE_TIME_SEC + BigInt(maxFuture), {
        maxFutureSeconds: maxFuture,
      });
      expect(validResult.valid).toBe(true);

      // Exceeding limit -> fails
      const exceedResult = validateDeadline(BASE_TIME_SEC + BigInt(maxFuture) + 1n, {
        maxFutureSeconds: maxFuture,
      });
      expect(exceedResult.valid).toBe(false);
      expect(exceedResult.errors[0]).toContain("exceeds maximum allowed future limit");
    });
  });

  describe("validateDeadlineOrThrow", () => {
    it("returns normalized seconds bigint on valid input", () => {
      const deadline = BASE_TIME_SEC + 1000n;
      const res = validateDeadlineOrThrow(deadline);
      expect(res).toBe(deadline);
    });

    it("throws DeadlineValidationError on invalid input", () => {
      expect(() => validateDeadlineOrThrow(BASE_TIME_SEC - 10n)).toThrow(DeadlineValidationError);

      try {
        validateDeadlineOrThrow(BASE_TIME_SEC - 10n);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(DeadlineValidationError);
        expect(err).toBeInstanceOf(ValidationError);
        expect(isDeadlineValidationError(err)).toBe(true);
        expect((err as DeadlineValidationError).code).toBe("DEADLINE_VALIDATION_ERROR");
      }
    });
  });

  describe("isFutureDeadline helper", () => {
    it("returns true for future deadlines and false for past/invalid", () => {
      expect(isFutureDeadline(BASE_TIME_SEC + 60n)).toBe(true);
      expect(isFutureDeadline(BASE_TIME_SEC - 60n)).toBe(false);
      expect(isFutureDeadline("invalid")).toBe(false);
    });
  });

  describe("parseDeadline utility", () => {
    it("parses various formats accurately", () => {
      expect(parseDeadline(1234567890n)).toBe(1234567890n);
      expect(parseDeadline(1234567890)).toBe(1234567890n);
      expect(parseDeadline(new Date(1234567890 * 1000))).toBe(1234567890n);
      expect(parseDeadline("1234567890")).toBe(1234567890n);
    });

    it("throws on unparseable inputs", () => {
      expect(() => parseDeadline(null)).toThrow(DeadlineValidationError);
      expect(() => parseDeadline("not a timestamp")).toThrow(DeadlineValidationError);
    });
  });

  describe("DeadlineValidator class", () => {
    it("reuses default options across validation calls", () => {
      const validator = new DeadlineValidator({
        minLeadSeconds: 1800,
      });

      expect(validator.validate(BASE_TIME_SEC + 3600n).valid).toBe(true);
      expect(validator.validate(BASE_TIME_SEC + 1000n).valid).toBe(false);

      expect(() => validator.validateOrThrow(BASE_TIME_SEC + 1000n)).toThrow(
        DeadlineValidationError
      );
    });
  });
});
