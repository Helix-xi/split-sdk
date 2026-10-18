/**
 * Tests for issue #1067 — Comprehensive error codes
 *
 * Verifies that every SdkErrorCode has a description and a suggestion, that
 * retryability is classified correctly, and that the new typed errors work.
 */
import { describe, it, expect } from "vitest";
import {
  SdkError,
  SdkErrorCode,
  SDK_ERROR_CODE_DESCRIPTIONS,
  RETRYABLE_ERROR_CODES,
  describeSdkErrorCode,
  isRetryableErrorCode,
  StellarSplitError,
  TransactionVerificationError,
  isTransactionVerificationError,
} from "../src/errors.js";
import { getSuggestion } from "../src/errorSuggestions.js";

describe("SdkErrorCode — comprehensive coverage (#1067)", () => {
  it("includes the original codes from issue #607", () => {
    for (const code of [
      SdkErrorCode.INVOICE_NOT_FOUND,
      SdkErrorCode.ACCOUNT_NOT_FOUND,
      SdkErrorCode.INSUFFICIENT_FUNDS,
      SdkErrorCode.DEADLINE_EXPIRED,
      SdkErrorCode.INVALID_RECIPIENT,
      SdkErrorCode.CONTRACT_REJECTED,
      SdkErrorCode.NETWORK_TIMEOUT,
      SdkErrorCode.RATE_LIMITED,
    ]) {
      expect(Object.values(SdkErrorCode)).toContain(code);
    }
  });

  it("has unique string values that match their member names", () => {
    const values = Object.values(SdkErrorCode);
    expect(new Set(values).size).toBe(values.length);
    for (const [name, value] of Object.entries(SdkErrorCode)) {
      expect(value).toBe(name);
    }
  });

  it("covers every failure category with at least one code", () => {
    const values = Object.values(SdkErrorCode);
    // One representative per category — guards against accidental removal.
    expect(values).toContain(SdkErrorCode.INVALID_CONTRACT_ADDRESS);
    expect(values).toContain(SdkErrorCode.VERIFICATION_FAILED);
    expect(values).toContain(SdkErrorCode.SEQUENCE_MISMATCH);
    expect(values).toContain(SdkErrorCode.SIMULATION_FAILED);
    expect(values).toContain(SdkErrorCode.WALLET_NOT_CONNECTED);
    expect(values).toContain(SdkErrorCode.CIRCUIT_OPEN);
    expect(values).toContain(SdkErrorCode.INTERNAL_ERROR);
    expect(values.length).toBeGreaterThanOrEqual(30);
  });
});

describe("SDK_ERROR_CODE_DESCRIPTIONS (#1067)", () => {
  it("has a non-empty description for every code", () => {
    for (const code of Object.values(SdkErrorCode)) {
      const description = SDK_ERROR_CODE_DESCRIPTIONS[code];
      expect(description, `missing description for ${code}`).toBeTruthy();
      expect(description.length).toBeGreaterThan(10);
    }
  });

  it("describeSdkErrorCode returns the description for a code", () => {
    expect(describeSdkErrorCode(SdkErrorCode.SEQUENCE_MISMATCH)).toBe(
      SDK_ERROR_CODE_DESCRIPTIONS[SdkErrorCode.SEQUENCE_MISMATCH],
    );
  });

  it("describeSdkErrorCode is case-insensitive for strings", () => {
    expect(describeSdkErrorCode("rate_limited")).toBe(
      SDK_ERROR_CODE_DESCRIPTIONS[SdkErrorCode.RATE_LIMITED],
    );
  });

  it("describeSdkErrorCode falls back for unknown codes", () => {
    expect(describeSdkErrorCode("NOT_A_REAL_CODE")).toBe("Unknown SDK error code.");
  });
});

describe("RETRYABLE_ERROR_CODES (#1067)", () => {
  it("marks transient network failures as retryable", () => {
    for (const code of [
      SdkErrorCode.NETWORK_TIMEOUT,
      SdkErrorCode.NETWORK_ERROR,
      SdkErrorCode.RPC_FAILED,
      SdkErrorCode.HORIZON_ERROR,
      SdkErrorCode.SERVICE_UNAVAILABLE,
      SdkErrorCode.RATE_LIMITED,
      SdkErrorCode.CONFIRMATION_TIMEOUT,
    ]) {
      expect(isRetryableErrorCode(code), `${code} should be retryable`).toBe(true);
    }
  });

  it("does not mark state/input failures as retryable", () => {
    for (const code of [
      SdkErrorCode.SEQUENCE_MISMATCH,
      SdkErrorCode.TRANSACTION_FAILED,
      SdkErrorCode.INVALID_INPUT,
      SdkErrorCode.UNAUTHORIZED,
      SdkErrorCode.INVOICE_FROZEN,
      SdkErrorCode.DEADLINE_EXPIRED,
    ]) {
      expect(isRetryableErrorCode(code), `${code} should not be retryable`).toBe(false);
    }
  });

  it("isRetryableErrorCode is case-insensitive and safe for unknown codes", () => {
    expect(isRetryableErrorCode("network_timeout")).toBe(true);
    expect(isRetryableErrorCode("bogus_code")).toBe(false);
  });

  it("RETRYABLE_ERROR_CODES only contains real enum members", () => {
    const values = new Set(Object.values(SdkErrorCode));
    for (const code of RETRYABLE_ERROR_CODES) {
      expect(values.has(code)).toBe(true);
    }
  });
});

describe("every code has a remediation suggestion (#1067)", () => {
  it("getSuggestion returns a specific suggestion (not the fallback) for every code", () => {
    const fallback = getSuggestion("TOTALLY_UNKNOWN_CODE");
    for (const code of Object.values(SdkErrorCode)) {
      expect(getSuggestion(code), `no suggestion for ${code}`).not.toBe(fallback);
      expect(getSuggestion(code).length).toBeGreaterThan(20);
    }
  });
});

describe("TransactionVerificationError (#1066/#1067)", () => {
  it("carries the failed check names and VERIFICATION_FAILED code", () => {
    const err = new TransactionVerificationError(["signatures", "fee"]);
    expect(err).toBeInstanceOf(StellarSplitError);
    expect(err.code).toBe("VERIFICATION_FAILED");
    expect(err.failedChecks).toEqual(["signatures", "fee"]);
    expect(err.message).toContain("signatures");
    expect(err.message).toContain("fee");
  });

  it("isTransactionVerificationError guard works", () => {
    expect(isTransactionVerificationError(new TransactionVerificationError(["x"]))).toBe(true);
    expect(isTransactionVerificationError(new Error("plain"))).toBe(false);
    expect(isTransactionVerificationError(null)).toBe(false);
  });
});

describe("SdkError with extended codes (#1067)", () => {
  it("constructs with a new code and preserves details", () => {
    const err = new SdkError("stale sequence", SdkErrorCode.SEQUENCE_MISMATCH, { expected: "5" });
    expect(err).toBeInstanceOf(SdkError);
    expect(err.code).toBe(SdkErrorCode.SEQUENCE_MISMATCH);
    expect(err.details).toEqual({ expected: "5" });
  });
});

