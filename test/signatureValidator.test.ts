import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createHmac } from "crypto";
import {
  validateEd25519Signature,
  validateEd25519SignatureOrThrow,
  validateMultiSig,
  validateMultiSigOrThrow,
  validateWebhookSignature,
  isValidSignatureFormat,
  normalizeSignature,
  normalizePublicKey,
  SignatureValidator,
  ED25519_SIGNATURE_BYTE_LENGTH,
} from "../src/validators/signatureValidator.js";
import {
  SignatureValidationError,
  ValidationError,
  isSignatureValidationError,
} from "../src/errors.js";

describe("SignatureValidator (Issue #1061)", () => {
  const kp1 = Keypair.random();
  const kp2 = Keypair.random();
  const kp3 = Keypair.random();

  const message = Buffer.from("test transaction payload");
  const validSig1 = kp1.sign(message);
  const validSig2 = kp2.sign(message);

  describe("Ed25519 signature validation", () => {
    it("validates authentic signature produced by Keypair", () => {
      const result = validateEd25519Signature({
        publicKey: kp1.publicKey(),
        message,
        signature: validSig1,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("accepts signature as hex string", () => {
      const hexSig = Buffer.from(validSig1).toString("hex");
      const result = validateEd25519Signature({
        publicKey: kp1.publicKey(),
        message,
        signature: hexSig,
      });

      expect(result.valid).toBe(true);
    });

    it("accepts signature as base64 string", () => {
      const b64Sig = Buffer.from(validSig1).toString("base64");
      const result = validateEd25519Signature({
        publicKey: kp1.publicKey(),
        message,
        signature: b64Sig,
      });

      expect(result.valid).toBe(true);
    });

    it("accepts publicKey as raw 32-byte Buffer", () => {
      const rawPubKey = kp1.rawPublicKey();
      const result = validateEd25519Signature({
        publicKey: rawPubKey,
        message,
        signature: validSig1,
      });

      expect(result.valid).toBe(true);
    });

    it("fails when signature is cryptographically invalid (corrupted byte)", () => {
      const badSig = Buffer.from(validSig1);
      badSig[0] ^= 0xff; // corrupt first byte

      const result = validateEd25519Signature({
        publicKey: kp1.publicKey(),
        message,
        signature: badSig,
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Cryptographic signature verification failed");
    });

    it("fails when signature does not match message", () => {
      const tamperedMessage = Buffer.from("different payload");
      const result = validateEd25519Signature({
        publicKey: kp1.publicKey(),
        message: tamperedMessage,
        signature: validSig1,
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Cryptographic signature verification failed");
    });

    it("fails when signature is from wrong keypair", () => {
      const result = validateEd25519Signature({
        publicKey: kp2.publicKey(), // expected kp2, but signature is from kp1
        message,
        signature: validSig1,
      });

      expect(result.valid).toBe(false);
    });

    it("rejects invalid signature length", () => {
      const shortSig = Buffer.alloc(63);
      const result = validateEd25519Signature({
        publicKey: kp1.publicKey(),
        message,
        signature: shortSig,
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Invalid signature format: expected 64 bytes");
    });

    it("rejects invalid public key", () => {
      const result = validateEd25519Signature({
        publicKey: "invalid-public-key",
        message,
        signature: validSig1,
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Invalid public key");
    });

    it("validateEd25519SignatureOrThrow throws SignatureValidationError", () => {
      const badSig = Buffer.alloc(64);
      expect(() =>
        validateEd25519SignatureOrThrow({
          publicKey: kp1.publicKey(),
          message,
          signature: badSig,
        })
      ).toThrow(SignatureValidationError);

      try {
        validateEd25519SignatureOrThrow({
          publicKey: kp1.publicKey(),
          message,
          signature: badSig,
        });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(SignatureValidationError);
        expect(err).toBeInstanceOf(ValidationError);
        expect(isSignatureValidationError(err)).toBe(true);
        expect((err as SignatureValidationError).code).toBe("SIGNATURE_VALIDATION_ERROR");
      }
    });
  });

  describe("Multi-signature threshold validation", () => {
    it("passes when accumulated weight meets or exceeds threshold", () => {
      const result = validateMultiSig({
        message,
        signatures: [
          { signer: kp1.publicKey(), signature: validSig1 },
          { signer: kp2.publicKey(), signature: validSig2 },
        ],
        signers: [
          { address: kp1.publicKey(), weight: 2 },
          { address: kp2.publicKey(), weight: 1 },
          { address: kp3.publicKey(), weight: 1 },
        ],
        threshold: 3,
      });

      expect(result.valid).toBe(true);
      expect(result.totalWeight).toBe(3);
      expect(result.verifiedSigners).toHaveLength(2);
      expect(result.verifiedSigners).toContain(kp1.publicKey());
      expect(result.verifiedSigners).toContain(kp2.publicKey());
    });

    it("fails when accumulated weight is below threshold", () => {
      const result = validateMultiSig({
        message,
        signatures: [{ signer: kp2.publicKey(), signature: validSig2 }], // weight = 1
        signers: [
          { address: kp1.publicKey(), weight: 2 },
          { address: kp2.publicKey(), weight: 1 },
        ],
        threshold: 3, // requires 3
      });

      expect(result.valid).toBe(false);
      expect(result.totalWeight).toBe(1);
      expect(result.errors[0]).toContain("Insufficient signature weight");
    });

    it("does not double-count weight from duplicate signatures of the same signer", () => {
      const result = validateMultiSig({
        message,
        signatures: [
          { signer: kp1.publicKey(), signature: validSig1 },
          { signer: kp1.publicKey(), signature: validSig1 }, // duplicate
        ],
        signers: [{ address: kp1.publicKey(), weight: 2 }],
        threshold: 4, // 2 + 2 would pass if double counted, but should fail!
      });

      expect(result.valid).toBe(false);
      expect(result.totalWeight).toBe(2);
    });

    it("ignores signatures from unauthorized signers", () => {
      const unauthorizedKp = Keypair.random();
      const unauthorizedSig = unauthorizedKp.sign(message);

      const result = validateMultiSig({
        message,
        signatures: [
          { signer: unauthorizedKp.publicKey(), signature: unauthorizedSig },
          { signer: kp1.publicKey(), signature: validSig1 },
        ],
        signers: [{ address: kp1.publicKey(), weight: 2 }],
        threshold: 2,
      });

      expect(result.valid).toBe(true);
      expect(result.totalWeight).toBe(2);
      expect(result.errors[0]).toContain("is not in the authorized signers list");
    });

    it("validateMultiSigOrThrow throws on insufficient weight", () => {
      expect(() =>
        validateMultiSigOrThrow({
          message,
          signatures: [{ signer: kp2.publicKey(), signature: validSig2 }],
          signers: [{ address: kp2.publicKey(), weight: 1 }],
          threshold: 2,
        })
      ).toThrow(SignatureValidationError);
    });
  });

  describe("Webhook signature validation", () => {
    const secret = "webhook-test-secret-key-12345";
    const payload = JSON.stringify({ event: "invoice.funded", id: "inv_123" });
    const computedHmac = createHmac("sha256", secret).update(payload).digest("hex");

    it("validates authentic webhook signature", () => {
      const result = validateWebhookSignature({
        signature: computedHmac,
        payload,
        secret,
      });

      expect(result.valid).toBe(true);
    });

    it("handles signaturePrefix (e.g. 'sha256=')", () => {
      const prefixed = `sha256=${computedHmac}`;
      const result = validateWebhookSignature({
        signature: prefixed,
        payload,
        secret,
        signaturePrefix: "sha256=",
      });

      expect(result.valid).toBe(true);
    });

    it("fails when payload is modified", () => {
      const result = validateWebhookSignature({
        signature: computedHmac,
        payload: payload + " modified",
        secret,
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Webhook signature verification failed");
    });

    it("fails when secret is wrong", () => {
      const result = validateWebhookSignature({
        signature: computedHmac,
        payload,
        secret: "wrong-secret",
      });

      expect(result.valid).toBe(false);
    });

    it("validates timestamp freshness within tolerance", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const timestampedPayload = `${nowSec}.${payload}`;
      const sig = createHmac("sha256", secret).update(timestampedPayload).digest("hex");

      const result = validateWebhookSignature({
        signature: sig,
        payload,
        secret,
        timestamp: nowSec,
        toleranceSeconds: 60,
      });

      expect(result.valid).toBe(true);
    });

    it("fails when timestamp exceeds tolerance window", () => {
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 500; // 500s ago
      const timestampedPayload = `${expiredTimestamp}.${payload}`;
      const sig = createHmac("sha256", secret).update(timestampedPayload).digest("hex");

      const result = validateWebhookSignature({
        signature: sig,
        payload,
        secret,
        timestamp: expiredTimestamp,
        toleranceSeconds: 60, // only 60s tolerance
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Webhook signature expired");
    });
  });

  describe("Utility helpers", () => {
    it("isValidSignatureFormat verifies format correctly", () => {
      expect(isValidSignatureFormat(validSig1)).toBe(true);
      expect(isValidSignatureFormat(Buffer.alloc(64))).toBe(true);
      expect(isValidSignatureFormat(Buffer.alloc(63))).toBe(false);
      expect(isValidSignatureFormat("not-hex")).toBe(false);
      expect(isValidSignatureFormat(null)).toBe(false);
    });

    it("normalizeSignature returns Buffer or null", () => {
      expect(normalizeSignature(validSig1)).toBeInstanceOf(Buffer);
      expect(normalizeSignature(Buffer.from(validSig1).toString("hex"))).toBeInstanceOf(Buffer);
      expect(normalizeSignature("bad")).toBeNull();
    });

    it("normalizePublicKey handles addresses and buffers", () => {
      expect(normalizePublicKey(kp1.publicKey())).toBe(kp1.publicKey());
      expect(normalizePublicKey(kp1.rawPublicKey())).toBe(kp1.publicKey());
      expect(normalizePublicKey("invalid")).toBeNull();
    });
  });

  describe("SignatureValidator class", () => {
    it("provides instance methods for validation", () => {
      const validator = new SignatureValidator();

      const result = validator.validateEd25519({
        publicKey: kp1.publicKey(),
        message,
        signature: validSig1,
      });
      expect(result.valid).toBe(true);

      expect(() =>
        validator.validateEd25519OrThrow({
          publicKey: kp1.publicKey(),
          message,
          signature: Buffer.alloc(64),
        })
      ).toThrow(SignatureValidationError);
    });
  });
});
