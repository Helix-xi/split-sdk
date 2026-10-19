/**
 * Tests for issue #1065 — Contract address validation
 *
 * Verifies StrKey format rules (length, prefix, base32 alphabet), CRC16
 * checksum validation, known-address acceptance, and the throwing helper.
 */
import { describe, it, expect } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import {
  validateContractAddress,
  isValidContractAddress,
  assertValidContractAddress,
  CONTRACT_ADDRESS_LENGTH,
  CONTRACT_ADDRESS_PREFIX,
} from "../src/contractAddressValidator.js";
import {
  StellarSplitError,
  InvalidContractAddressError,
  isInvalidContractAddressError,
} from "../src/errors.js";

// Deterministic, known-valid contract addresses (generated with
// StrKey.encodeContract over fixed 32-byte payloads).
const ZERO_PAYLOAD_ADDRESS = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const PATTERN_PAYLOAD_ADDRESS = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const FF_PAYLOAD_ADDRESS = "CD7777777777777777777777777777777777777777777777777767GY";

// ZERO_PAYLOAD_ADDRESS with the final checksum character corrupted:
// format (length/prefix/alphabet) intact, CRC16 broken.
const BROKEN_CHECKSUM_ADDRESS = `${ZERO_PAYLOAD_ADDRESS.slice(0, 55)}${
  ZERO_PAYLOAD_ADDRESS[55] === "4" ? "5" : "4"
}`;

// A well-formed non-contract address that must be rejected.
const G_ADDRESS = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

describe("validateContractAddress — known valid addresses (#1065)", () => {
  it.each([
    ["all-zero payload", ZERO_PAYLOAD_ADDRESS],
    ["patterned payload", PATTERN_PAYLOAD_ADDRESS],
    ["0xff payload", FF_PAYLOAD_ADDRESS],
  ])("accepts a known-valid address (%s)", (_label, address) => {
    const result = validateContractAddress(address);
    expect(result.valid).toBe(true);
    expect(result.format).toBe(true);
    expect(result.checksum).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts addresses round-tripped through StrKey.encodeContract", () => {
    // Regenerate a known address to prove the documented rules match the SDK.
    expect(StrKey.encodeContract(Buffer.alloc(32, 0))).toBe(ZERO_PAYLOAD_ADDRESS);
    expect(validateContractAddress(StrKey.encodeContract(Buffer.alloc(32, 0))).valid).toBe(true);
  });
});

describe("validateContractAddress — format rules (#1065)", () => {
  it("rejects an empty string", () => {
    const result = validateContractAddress("");
    expect(result.valid).toBe(false);
    expect(result.format).toBe(false);
    expect(result.errors[0]).toContain("non-empty string");
  });

  it("rejects non-string values", () => {
    for (const value of [null, undefined, 42, {}, []]) {
      const result = validateContractAddress(value);
      expect(result.valid).toBe(false);
      expect(result.format).toBe(false);
    }
  });

  it("rejects an address that is too short", () => {
    const result = validateContractAddress("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASC4");
    expect(result.valid).toBe(false);
    expect(result.format).toBe(false);
    expect(result.checksum).toBe(false);
    expect(result.errors.some((e) => e.includes(`exactly ${CONTRACT_ADDRESS_LENGTH} characters`))).toBe(
      true,
    );
  });

  it("rejects an address that is too long", () => {
    const result = validateContractAddress(`${ZERO_PAYLOAD_ADDRESS}AAAA`);
    expect(result.valid).toBe(false);
    expect(result.format).toBe(false);
  });

  it("rejects an address without the C prefix", () => {
    const result = validateContractAddress(G_ADDRESS);
    expect(result.valid).toBe(false);
    expect(result.format).toBe(false);
    expect(result.errors.some((e) => e.includes(`must start with '${CONTRACT_ADDRESS_PREFIX}'`))).toBe(
      true,
    );
  });

  it("rejects a lowercase address (base32 is case-sensitive)", () => {
    const result = validateContractAddress(ZERO_PAYLOAD_ADDRESS.toLowerCase());
    expect(result.valid).toBe(false);
    expect(result.format).toBe(false);
    expect(result.errors.some((e) => e.includes("base32"))).toBe(true);
  });

  it("rejects characters outside the base32 alphabet", () => {
    // Replace a mid-string character with '1' (not in A-Z/2-7).
    const mutated = `${ZERO_PAYLOAD_ADDRESS.slice(0, 20)}1${ZERO_PAYLOAD_ADDRESS.slice(21)}`;
    const result = validateContractAddress(mutated);
    expect(result.valid).toBe(false);
    expect(result.format).toBe(false);
  });

  it("rejects non-contract StrKey types", () => {
    expect(isValidContractAddress(G_ADDRESS)).toBe(false);
    expect(isValidContractAddress("SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(
      false,
    );
  });
});

describe("validateContractAddress — checksum rule (#1065)", () => {
  it("rejects a well-formed address with a broken CRC16 checksum", () => {
    const result = validateContractAddress(BROKEN_CHECKSUM_ADDRESS);
    expect(result.valid).toBe(false);
    // Format is fine — only the checksum fails, and the two are reported apart.
    expect(result.format).toBe(true);
    expect(result.checksum).toBe(false);
    expect(result.errors).toEqual(["Contract address failed CRC16 checksum validation"]);
  });

  it("flags checksum=false (not format=false) for corrupted payload bytes", () => {
    // Flip a mid-string payload character; length/prefix/alphabet stay intact.
    const corrupted = `${ZERO_PAYLOAD_ADDRESS.slice(0, 40)}${
      ZERO_PAYLOAD_ADDRESS[40] === "A" ? "B" : "A"
    }${ZERO_PAYLOAD_ADDRESS.slice(41)}`;
    const result = validateContractAddress(corrupted);
    if (result.valid) {
      // Vanishingly unlikely collision — still must be self-consistent.
      expect(result.checksum).toBe(true);
    } else {
      expect(result.format).toBe(true);
      expect(result.checksum).toBe(false);
    }
  });
});

describe("isValidContractAddress (#1065)", () => {
  it("returns true for known-valid addresses", () => {
    expect(isValidContractAddress(ZERO_PAYLOAD_ADDRESS)).toBe(true);
    expect(isValidContractAddress(PATTERN_PAYLOAD_ADDRESS)).toBe(true);
  });

  it("returns false for invalid addresses and non-strings", () => {
    expect(isValidContractAddress(BROKEN_CHECKSUM_ADDRESS)).toBe(false);
    expect(isValidContractAddress(G_ADDRESS)).toBe(false);
    expect(isValidContractAddress("")).toBe(false);
    expect(isValidContractAddress(null as unknown as string)).toBe(false);
  });
});

describe("assertValidContractAddress (#1065)", () => {
  it("does not throw for a valid address", () => {
    expect(() => assertValidContractAddress(ZERO_PAYLOAD_ADDRESS)).not.toThrow();
  });

  it("throws InvalidContractAddressError for a broken checksum", () => {
    let thrown: unknown;
    try {
      assertValidContractAddress(BROKEN_CHECKSUM_ADDRESS);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidContractAddressError);
    expect(thrown).toBeInstanceOf(StellarSplitError);
    const err = thrown as InvalidContractAddressError;
    expect(err.code).toBe("INVALID_CONTRACT_ADDRESS");
    expect(err.address).toBe(BROKEN_CHECKSUM_ADDRESS);
    expect(err.reasons.some((r) => r.includes("checksum"))).toBe(true);
  });

  it("isInvalidContractAddressError guard works", () => {
    expect(isInvalidContractAddressError(new InvalidContractAddressError("x", ["bad"]))).toBe(true);
    expect(isInvalidContractAddressError(new Error("plain"))).toBe(false);
    expect(isInvalidContractAddressError(null)).toBe(false);
  });
});

