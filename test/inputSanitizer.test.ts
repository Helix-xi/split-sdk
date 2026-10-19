/**
 * Tests for #1057 — input sanitization and validation utilities.
 *
 * Covers:
 * - sanitizeString: control-char/CRLF/bidi stripping, trimming, length limits
 * - validateAmount: canonicalization, stroops precision, junk/NaN/exponent
 *   rejection, minimum bounds, maxDecimals
 * - validateAndParseAmount: validated conversion to stroops
 * - validateAddress: StrKey structure + checksum, kind enforcement
 * - sanitizeObject: deep sanitization, prototype-pollution blocking,
 *   non-finite numbers, cycles, depth/key/length limits
 * - performance sanity on large strings
 */

import { describe, expect, it } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import {
  InputSanitizationError,
  sanitizeObject,
  sanitizeString,
  validateAddress,
  validateAndParseAmount,
  validateAmount,
} from "../src/inputSanitizer.js";

/** Deterministic, checksum-valid addresses generated via StrKey encoding. */
const VALID_ACCOUNT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 7));
const VALID_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 9));
/** Flip the final character of a valid address — guaranteed CRC mismatch. */
const CORRUPT_ACCOUNT = `${VALID_ACCOUNT.slice(0, -1)}${
  VALID_ACCOUNT.endsWith("A") ? "B" : "A"
}`;

// ---------------------------------------------------------------------------
// sanitizeString
// ---------------------------------------------------------------------------

describe("sanitizeString", () => {
  it("strips NUL and control characters", () => {
    expect(sanitizeString("a\u0000b\u0007c\u009Fd")).toBe("abcd");
  });

  it("keeps newlines by default", () => {
    expect(sanitizeString("line1\nline2")).toBe("line1\nline2");
  });

  it("strips CR/LF when allowNewlines is false (header injection)", () => {
    expect(
      sanitizeString("X-Forwarded: 1\r\nInjected: yes", { allowNewlines: false }),
    ).toBe("X-Forwarded: 1Injected: yes");
  });

  it("strips Unicode bidi override and isolate characters", () => {
    expect(sanitizeString("\u202Egnp.exe")).toBe("gnp.exe");
    expect(sanitizeString("safe\u2066hidden\u2069")).toBe("safehidden");
  });

  it("trims surrounding whitespace by default and honors trim: false", () => {
    expect(sanitizeString("  hi  ")).toBe("hi");
    expect(sanitizeString("  hi  ", { trim: false })).toBe("  hi  ");
  });

  it("throws InputSanitizationError for non-string input", () => {
    expect(() => sanitizeString(42 as unknown as string)).toThrow(
      InputSanitizationError,
    );
  });

  it("enforces maxLength instead of truncating silently", () => {
    expect(sanitizeString("abc", { maxLength: 3 })).toBe("abc");
    expect(() => sanitizeString("abcd", { maxLength: 3 })).toThrow(
      InputSanitizationError,
    );
  });

  it("reports the field name in error messages", () => {
    expect(() => sanitizeString(1 as unknown as string, { field: "memo" })).toThrow(
      /memo/,
    );
  });
});

// ---------------------------------------------------------------------------
// validateAmount
// ---------------------------------------------------------------------------

describe("validateAmount", () => {
  it("canonicalizes decimal strings", () => {
    expect(validateAmount("001.5000")).toBe("1.5");
    expect(validateAmount("0")).toBe("0");
    expect(validateAmount("0.0")).toBe("0");
  });

  it("accepts numbers and bigints", () => {
    expect(validateAmount(42)).toBe("42");
    expect(validateAmount(100n)).toBe("100");
    expect(validateAmount(0.5)).toBe("0.5");
    // NOTE: String(1e-7) is "1e-7" (exponent notation), which the validator
    // intentionally rejects — decimal precision must be spelled out.
    expect(() => validateAmount(0.0000001)).toThrow(InputSanitizationError);
    expect(validateAmount("0.0000001")).toBe("0.0000001");
  });

  it("accepts exactly 7 decimal places (stroops precision)", () => {
    expect(validateAmount("1.1234567")).toBe("1.1234567");
  });

  it("rejects more than 7 decimal places", () => {
    expect(() => validateAmount("1.12345678")).toThrow(InputSanitizationError);
  });

  it("rejects exponent notation, separators, and junk", () => {
    for (const bad of ["1e7", "1,000", "abc", "", "1.2.3", "0x10", "1 2"]) {
      expect(() => validateAmount(bad)).toThrow(InputSanitizationError);
    }
  });

  it("rejects non-finite and unsafe numbers", () => {
    expect(() => validateAmount(Number.NaN)).toThrow(InputSanitizationError);
    expect(() => validateAmount(Number.POSITIVE_INFINITY)).toThrow(
      InputSanitizationError,
    );
    expect(() => validateAmount(2 ** 53)).toThrow(InputSanitizationError);
  });

  it("rejects negatives unless the minimum allows them", () => {
    expect(() => validateAmount("-1")).toThrow(InputSanitizationError);
    expect(validateAmount("-1", { min: "-10" })).toBe("-1");
  });

  it("enforces the minimum bound", () => {
    expect(() => validateAmount("1", { min: "5" })).toThrow(InputSanitizationError);
    expect(validateAmount("5", { min: "5" })).toBe("5");
  });

  it("supports reduced precision via maxDecimals", () => {
    expect(validateAmount("1.25", { maxDecimals: 2 })).toBe("1.25");
    expect(() => validateAmount("1.256", { maxDecimals: 2 })).toThrow(
      InputSanitizationError,
    );
    expect(validateAmount(5, { maxDecimals: 0 })).toBe("5");
    expect(validateAmount("-3", { maxDecimals: 0, min: "-10" })).toBe("-3");
    expect(() => validateAmount("5.5", { maxDecimals: 0 })).toThrow(
      InputSanitizationError,
    );
  });

  it("rejects maxDecimals outside the 0–7 range", () => {
    expect(() => validateAmount("1", { maxDecimals: 8 })).toThrow(
      InputSanitizationError,
    );
    expect(() => validateAmount("1", { maxDecimals: -1 })).toThrow(
      InputSanitizationError,
    );
  });
});

// ---------------------------------------------------------------------------
// validateAndParseAmount
// ---------------------------------------------------------------------------

describe("validateAndParseAmount", () => {
  it("converts validated amounts to stroops", () => {
    expect(validateAndParseAmount("1.5")).toBe(15_000_000n);
    expect(validateAndParseAmount("0.0000001")).toBe(1n);
    expect(validateAndParseAmount(2)).toBe(20_000_000n);
  });

  it("rejects malformed amounts before conversion", () => {
    expect(() => validateAndParseAmount("1.23456789")).toThrow(
      InputSanitizationError,
    );
    expect(() => validateAndParseAmount("nope")).toThrow(InputSanitizationError);
  });
});

// ---------------------------------------------------------------------------
// validateAddress
// ---------------------------------------------------------------------------

describe("validateAddress", () => {
  it("accepts a valid account address and trims it", () => {
    expect(validateAddress(`  ${VALID_ACCOUNT}  `)).toBe(VALID_ACCOUNT);
  });

  it("rejects a corrupted checksum", () => {
    expect(() => validateAddress(CORRUPT_ACCOUNT)).toThrow(InputSanitizationError);
  });

  it("rejects wrong-prefix addresses for the requested kind", () => {
    expect(() => validateAddress(VALID_CONTRACT)).toThrow(InputSanitizationError);
    expect(() => validateAddress(VALID_ACCOUNT, { kind: "contract" })).toThrow(
      InputSanitizationError,
    );
    expect(() => validateAddress(VALID_ACCOUNT, { kind: "muxed" })).toThrow(
      InputSanitizationError,
    );
  });

  it("accepts a valid contract address with kind: contract", () => {
    expect(validateAddress(VALID_CONTRACT, { kind: "contract" })).toBe(
      VALID_CONTRACT,
    );
  });

  it("rejects junk and control characters", () => {
    expect(() => validateAddress("GABC")).toThrow(InputSanitizationError);
    expect(() => validateAddress(`${VALID_ACCOUNT}\r\n`)).not.toThrow(); // CRLF stripped first
    expect(() => validateAddress("G\u0000ABC")).toThrow(InputSanitizationError);
  });
});

// ---------------------------------------------------------------------------
// sanitizeObject
// ---------------------------------------------------------------------------

describe("sanitizeObject", () => {
  it("sanitizes strings at any depth", () => {
    expect(sanitizeObject({ a: { b: ["x\u0000y", " ok "] } })).toEqual({
      a: { b: ["xy", "ok"] },
    });
  });

  it("preserves bigints, booleans, and null", () => {
    expect(sanitizeObject({ n: 1n, t: true, z: null })).toEqual({
      n: 1n,
      t: true,
      z: null,
    });
  });

  it("passes non-plain objects through untouched", () => {
    const date = new Date(0);
    const result = sanitizeObject({ when: date });
    expect(result.when).toBe(date);
  });

  it("blocks __proto__ prototype pollution", () => {
    const payload = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    expect(() => sanitizeObject(payload)).toThrow(InputSanitizationError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("blocks constructor and prototype keys", () => {
    expect(() => sanitizeObject(JSON.parse('{"constructor": 1}'))).toThrow(
      InputSanitizationError,
    );
    expect(() => sanitizeObject(JSON.parse('{"prototype": 1}'))).toThrow(
      InputSanitizationError,
    );
  });

  it("rejects non-finite numbers", () => {
    expect(() => sanitizeObject({ amount: Number.NaN })).toThrow(
      InputSanitizationError,
    );
    expect(() => sanitizeObject({ amount: Number.POSITIVE_INFINITY })).toThrow(
      InputSanitizationError,
    );
  });

  it("rejects functions, symbols, and undefined leaves", () => {
    expect(() => sanitizeObject({ fn: () => undefined })).toThrow(
      InputSanitizationError,
    );
    expect(() => sanitizeObject({ s: Symbol("x") })).toThrow(
      InputSanitizationError,
    );
  });

  it("rejects circular references", () => {
    const payload: Record<string, unknown> = { name: "root" };
    payload.self = payload;
    expect(() => sanitizeObject(payload)).toThrow(InputSanitizationError);
  });

  it("enforces maxDepth, maxKeys, and maxLength", () => {
    const deep = { l1: { l2: { l3: {} } } };
    expect(() => sanitizeObject(deep, { maxDepth: 2 })).toThrow(
      InputSanitizationError,
    );

    const wide: Record<string, number> = {};
    for (let i = 0; i < 10; i++) wide[`k${i}`] = i;
    expect(() => sanitizeObject(wide, { maxKeys: 5 })).toThrow(
      InputSanitizationError,
    );

    expect(() => sanitizeObject({ memo: "abcdef" }, { maxLength: 3 })).toThrow(
      InputSanitizationError,
    );
  });

  it("allows sibling references (only cycles are rejected)", () => {
    const shared = { v: 1 };
    expect(sanitizeObject({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe("sanitizeString performance", () => {
  it("sanitizes a 1 MB payload in well under a second", () => {
    const big = `${"a".repeat(500_000)}\u0000${"b".repeat(500_000)}`;
    const started = Date.now();
    const out = sanitizeString(big, { maxLength: 1_100_000 });
    expect(out.length).toBe(1_000_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

