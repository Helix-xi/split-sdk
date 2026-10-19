import { describe, it, expect } from "vitest";
import {
  validateAddress,
  validateAddressOrThrow,
  isStellarAddress,
  detectAddressType,
  verifyAddressChecksum,
  AddressValidator,
  STELLAR_ADDRESS_LENGTHS,
} from "../src/validators/addressValidator.js";
import {
  AddressValidationError,
  ValidationError,
  isAddressValidationError,
} from "../src/errors.js";

const VALID_ACCOUNT = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const VALID_MUXED = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAGZFQ";
const VALID_SECRET = "SCQA5IYGYKD4HVEFXJCU3ROL6XS5NHSEHQEJ3GWINDUBC7KD6E5KL5UU";

describe("AddressValidator (Issue #1062)", () => {
  describe("Format validation", () => {
    it("accepts a valid G... Stellar account address", () => {
      const result = validateAddress(VALID_ACCOUNT);
      expect(result.valid).toBe(true);
      expect(result.type).toBe("account");
      expect(result.normalizedAddress).toBe(VALID_ACCOUNT);
      expect(result.errors).toHaveLength(0);
    });

    it("accepts a valid C... Stellar contract address", () => {
      const result = validateAddress(VALID_CONTRACT);
      expect(result.valid).toBe(true);
      expect(result.type).toBe("contract");
      expect(result.normalizedAddress).toBe(VALID_CONTRACT);
    });

    it("accepts a valid M... muxed address when allowed", () => {
      const result = validateAddress(VALID_MUXED, { allowMuxed: true });
      expect(result.valid).toBe(true);
      expect(result.type).toBe("muxed");
      expect(result.normalizedAddress).toBe(VALID_MUXED);
    });

    it("rejects M... muxed addresses by default", () => {
      const result = validateAddress(VALID_MUXED);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Address type "muxed" is not allowed');
    });

    it("rejects invalid prefixes", () => {
      const badPrefix = "BA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
      const result = validateAddress(badPrefix);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid address prefix: "B"');
    });

    it("rejects invalid lengths for account address", () => {
      // 55 characters
      const tooShort = VALID_ACCOUNT.slice(0, 55);
      const shortResult = validateAddress(tooShort);
      expect(shortResult.valid).toBe(false);
      expect(shortResult.errors[0]).toContain("Invalid address length");

      // 57 characters
      const tooLong = VALID_ACCOUNT + "A";
      const longResult = validateAddress(tooLong);
      expect(longResult.valid).toBe(false);
      expect(longResult.errors[0]).toContain("Invalid address length");
    });

    it("rejects invalid Base32 characters (0, 1, 8, 9, lowercase, symbols)", () => {
      // Replacing char with '8'
      const withEight = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSG8";
      const resultEight = validateAddress(withEight);
      expect(resultEight.valid).toBe(false);
      expect(resultEight.errors[0]).toContain("Address contains invalid Base32 characters");

      // Lowercase in body
      const withLowerBody = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGz";
      const resultLower = validateAddress(withLowerBody);
      expect(resultLower.valid).toBe(false);
      expect(resultLower.errors[0]).toContain("Address contains invalid Base32 characters");

      // Lowercase prefix
      const resultLowerPrefix = validateAddress(VALID_ACCOUNT.toLowerCase());
      expect(resultLowerPrefix.valid).toBe(false);
      expect(resultLowerPrefix.errors[0]).toContain('Invalid address prefix: "g"');
    });

    it("rejects null, undefined, empty, and non-string inputs", () => {
      expect(validateAddress(null).valid).toBe(false);
      expect(validateAddress(undefined).valid).toBe(false);
      expect(validateAddress("").valid).toBe(false);
      expect(validateAddress("   ").valid).toBe(false);
      expect(validateAddress(12345).valid).toBe(false);
      expect(validateAddress({}).valid).toBe(false);
    });
  });

  describe("Checksum validation", () => {
    it("passes for authentic checksums", () => {
      expect(verifyAddressChecksum(VALID_ACCOUNT)).toBe(true);
      expect(verifyAddressChecksum(VALID_CONTRACT)).toBe(true);
      expect(verifyAddressChecksum(VALID_MUXED)).toBe(true);
    });

    it("fails when checksum is corrupted (single character typo)", () => {
      // Flip the last character (which is part of the CRC16 checksum)
      const lastChar = VALID_ACCOUNT[VALID_ACCOUNT.length - 1];
      const replacementChar = lastChar === "A" ? "B" : "A";
      const corruptedAddress = VALID_ACCOUNT.slice(0, -1) + replacementChar;

      expect(corruptedAddress.length).toBe(56);
      const result = validateAddress(corruptedAddress);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Address checksum validation failed");
      expect(result.errors[0]).toContain("CRC16 checksum does not match");
    });
  });

  describe("Security and secret key protection", () => {
    it("explicitly rejects secret keys (S...) with security error", () => {
      const result = validateAddress(VALID_SECRET);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Security error: Secret key ('S...') detected");
    });

    it("throws AddressValidationError if secret key is passed to validateAddressOrThrow", () => {
      expect(() => validateAddressOrThrow(VALID_SECRET)).toThrow(AddressValidationError);
    });
  });

  describe("Allowed types restrictions", () => {
    it("restricts to account addresses only when specified", () => {
      const options = { allowedTypes: ["account" as const] };

      expect(validateAddress(VALID_ACCOUNT, options).valid).toBe(true);

      const contractResult = validateAddress(VALID_CONTRACT, options);
      expect(contractResult.valid).toBe(false);
      expect(contractResult.errors[0]).toContain('Address type "contract" is not allowed');
    });

    it("restricts to contract addresses only when specified", () => {
      const options = { allowedTypes: ["contract" as const] };

      expect(validateAddress(VALID_CONTRACT, options).valid).toBe(true);

      const accountResult = validateAddress(VALID_ACCOUNT, options);
      expect(accountResult.valid).toBe(false);
      expect(accountResult.errors[0]).toContain('Address type "account" is not allowed');
    });
  });

  describe("validateAddressOrThrow", () => {
    it("returns normalized address on valid input", () => {
      const addr = validateAddressOrThrow(`  ${VALID_ACCOUNT}  `);
      expect(addr).toBe(VALID_ACCOUNT);
    });

    it("throws AddressValidationError on invalid input", () => {
      expect(() => validateAddressOrThrow("invalid")).toThrow(AddressValidationError);

      try {
        validateAddressOrThrow("GABC");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AddressValidationError);
        expect(err).toBeInstanceOf(ValidationError);
        expect(isAddressValidationError(err)).toBe(true);
        expect((err as AddressValidationError).code).toBe("ADDRESS_VALIDATION_ERROR");
      }
    });
  });

  describe("Utility helpers", () => {
    it("isStellarAddress checks validity", () => {
      expect(isStellarAddress(VALID_ACCOUNT)).toBe(true);
      expect(isStellarAddress(VALID_CONTRACT)).toBe(true);
      expect(isStellarAddress("invalid")).toBe(false);
    });

    it("detectAddressType detects types accurately", () => {
      expect(detectAddressType(VALID_ACCOUNT)).toBe("account");
      expect(detectAddressType(VALID_CONTRACT)).toBe("contract");
      expect(detectAddressType(VALID_MUXED)).toBe("muxed");
      expect(detectAddressType("not-an-address")).toBeNull();
    });
  });

  describe("AddressValidator class", () => {
    it("reuses default options across validation calls", () => {
      const validator = new AddressValidator({
        allowMuxed: true,
      });

      expect(validator.validate(VALID_MUXED).valid).toBe(true);
      expect(validator.validate(VALID_ACCOUNT).valid).toBe(true);

      const strictValidator = new AddressValidator({
        allowedTypes: ["contract"],
      });
      expect(strictValidator.validate(VALID_ACCOUNT).valid).toBe(false);
      expect(strictValidator.validate(VALID_CONTRACT).valid).toBe(true);
    });
  });
});
