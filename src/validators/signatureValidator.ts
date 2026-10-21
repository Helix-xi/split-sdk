/**
 * Signature validator for StellarSplit transactions, multi-signature sets, and webhooks.
 *
 * Provides comprehensive integrity and authenticity verification across:
 * 1. Ed25519 signatures: Validates 64-byte cryptographic signatures over transaction
 *    hashes or arbitrary messages against Stellar ed25519 public keys ('G...').
 * 2. Multi-signature threshold verification: Verifies M-of-N signature sets,
 *    accumulating weights across authorized signers and comparing against an
 *    execution threshold.
 * 3. Webhook signatures: Verifies HMAC signatures over webhook payloads with
 *    timing-safe comparison and replay protection timestamps.
 *
 * @example
 * ```ts
 * import {
 *   validateEd25519Signature,
 *   validateEd25519SignatureOrThrow,
 *   validateMultiSig,
 * } from "@stellar-split/sdk";
 *
 * // Validate Ed25519 signature
 * const result = validateEd25519Signature({
 *   publicKey: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
 *   message: Buffer.from("hello world"),
 *   signature: "...", // 64-byte Buffer, Uint8Array, or 128-hex string
 * });
 *
 * if (result.valid) {
 *   console.log("Signature is authentic!");
 * }
 * ```
 */

import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { createHmac, timingSafeEqual } from "crypto";
import { SignatureValidationError } from "../errors.js";

/** Standard Ed25519 signature length in bytes. */
export const ED25519_SIGNATURE_BYTE_LENGTH = 64;

/** Standard Ed25519 public key raw byte length. */
export const ED25519_PUBLIC_KEY_BYTE_LENGTH = 32;

/** Hex character regex. */
const HEX_REGEX = /^[0-9a-fA-F]+$/;

/** Base64 character regex. */
const BASE64_REGEX = /^[A-Za-z0-9+/=]+$/;

/** Result of a single signature validation. */
export interface SignatureValidationResult {
  /** True when the signature is well-formed and cryptographically authentic. */
  valid: boolean;
  /** Primary error message if invalid. */
  error?: string;
  /** Complete list of validation error messages. */
  errors: string[];
}

/** Parameters for Ed25519 signature validation. */
export interface Ed25519ValidationParams {
  /**
   * The signer's public key.
   * Can be a 56-character Stellar 'G...' address or raw 32-byte Buffer/Uint8Array.
   */
  publicKey: string | Buffer | Uint8Array;
  /**
   * The signed message or transaction hash.
   * Can be a Buffer, Uint8Array, or string.
   */
  message: string | Buffer | Uint8Array;
  /**
   * The 64-byte Ed25519 signature.
   * Can be a Buffer, Uint8Array, or hex/base64 encoded string.
   */
  signature: string | Buffer | Uint8Array;
}

/** Single signature entry in a multi-signature verification request. */
export interface MultiSigEntry {
  /** Stellar 'G...' address or 32-byte public key of the signer. */
  signer: string | Buffer | Uint8Array;
  /** 64-byte signature produced by this signer. */
  signature: string | Buffer | Uint8Array;
}

/** Authorized signer configuration with voting weight. */
export interface SignerWeightConfig {
  /** Stellar 'G...' address of the authorized signer. */
  address: string;
  /** Voting weight of this signer (positive integer). */
  weight: number;
}

/** Parameters for multi-signature threshold validation. */
export interface MultiSigValidationParams {
  /** The signed message or transaction hash. */
  message: string | Buffer | Uint8Array;
  /** Array of signatures collected for this operation. */
  signatures: MultiSigEntry[];
  /** List of authorized signers and their assigned weights. */
  signers: SignerWeightConfig[];
  /** Required weight threshold for the operation to be approved. */
  threshold: number;
}

/** Result of multi-signature threshold validation. */
export interface MultiSigValidationResult {
  /** True when the accumulated weight of valid signatures meets or exceeds threshold. */
  valid: boolean;
  /** Total weight accumulated from verified unique signers. */
  totalWeight: number;
  /** Required threshold weight. */
  threshold: number;
  /** Addresses of signers whose signatures were verified. */
  verifiedSigners: string[];
  /** Complete list of errors encountered. */
  errors: string[];
}

/** Parameters for webhook signature verification. */
export interface WebhookValidationParams {
  /** Hex-encoded HMAC signature from the webhook header. */
  signature: string;
  /** Raw webhook request body (string or Buffer). */
  payload: string | Buffer;
  /** Shared secret key. */
  secret: string;
  /** HMAC hash algorithm. Defaults to 'sha256'. */
  algorithm?: "sha256" | "sha1" | "sha512";
  /** Optional timestamp from the webhook header for replay protection. */
  timestamp?: number | string;
  /** Maximum allowable clock skew in seconds. Defaults to 300 (5 minutes). */
  toleranceSeconds?: number;
  /** Optional signature prefix to strip before comparison (e.g., 'sha256='). */
  signaturePrefix?: string;
}

// ---------------------------------------------------------------------------
// Normalization and Format Utilities
// ---------------------------------------------------------------------------

/**
 * Check whether a signature input has a valid length and format.
 *
 * @param signature - Signature as Buffer, Uint8Array, or hex/base64 string.
 * @param expectedLength - Expected byte length (defaults to 64 for Ed25519).
 * @returns `true` if valid, `false` otherwise.
 */
export function isValidSignatureFormat(
  signature: unknown,
  expectedLength: number = ED25519_SIGNATURE_BYTE_LENGTH
): boolean {
  return normalizeSignature(signature, expectedLength) !== null;
}

/**
 * Normalize a signature input into a raw Buffer of exact expected length.
 *
 * @param signature - Signature input.
 * @param expectedLength - Expected byte length (defaults to 64).
 * @returns The normalized Buffer, or `null` if invalid.
 */
export function normalizeSignature(
  signature: unknown,
  expectedLength: number = ED25519_SIGNATURE_BYTE_LENGTH
): Buffer | null {
  if (!signature) return null;

  if (Buffer.isBuffer(signature)) {
    return signature.length === expectedLength ? signature : null;
  }

  if (signature instanceof Uint8Array) {
    return signature.length === expectedLength ? Buffer.from(signature) : null;
  }

  if (typeof signature === "string") {
    const trimmed = signature.trim();

    // Hex string (e.g. 128 hex chars for 64 bytes)
    if (trimmed.length === expectedLength * 2 && HEX_REGEX.test(trimmed)) {
      return Buffer.from(trimmed, "hex");
    }

    // Base64 string
    try {
      if (BASE64_REGEX.test(trimmed)) {
        const buf = Buffer.from(trimmed, "base64");
        if (buf.length === expectedLength) {
          return buf;
        }
      }
    } catch {
      // not valid base64
    }
  }

  return null;
}

/**
 * Normalize a public key into a Stellar 'G...' address string.
 *
 * @param publicKey - Public key as 'G...' string or raw 32-byte Buffer/Uint8Array.
 * @returns The normalized 'G...' address string, or `null` if invalid.
 */
export function normalizePublicKey(publicKey: unknown): string | null {
  if (!publicKey) return null;

  if (typeof publicKey === "string") {
    const trimmed = publicKey.trim();
    if (StrKey.isValidEd25519PublicKey(trimmed)) {
      return trimmed;
    }
    return null;
  }

  if (Buffer.isBuffer(publicKey) || publicKey instanceof Uint8Array) {
    if (publicKey.length === ED25519_PUBLIC_KEY_BYTE_LENGTH) {
      try {
        return StrKey.encodeEd25519PublicKey(Buffer.from(publicKey));
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Normalize a message input into a Buffer.
 *
 * @param message - String or Buffer.
 * @returns Buffer representation of the message.
 */
export function normalizeMessage(message: unknown): Buffer | null {
  if (message === null || message === undefined) return null;

  if (Buffer.isBuffer(message)) {
    return message;
  }

  if (message instanceof Uint8Array) {
    return Buffer.from(message);
  }

  if (typeof message === "string") {
    return Buffer.from(message, "utf8");
  }

  return null;
}

// ---------------------------------------------------------------------------
// Validation Implementations
// ---------------------------------------------------------------------------

/**
 * Validate an Ed25519 cryptographic signature.
 *
 * Verification checks:
 * 1. Signature format: Exactly 64 bytes in length (Buffer, Uint8Array, hex, or base64).
 * 2. Public key format: Valid Stellar 'G...' address or 32-byte ed25519 public key.
 * 3. Message format: Non-empty Buffer, Uint8Array, or string.
 * 4. Authenticity: Cryptographic verification using ed25519 verification.
 *
 * @param params - Signature, message, and public key parameters.
 * @returns A {@link SignatureValidationResult} with validity and diagnostic errors.
 */
export function validateEd25519Signature(
  params: Ed25519ValidationParams
): SignatureValidationResult {
  const errors: string[] = [];

  if (!params) {
    return {
      valid: false,
      error: "Validation parameters are required.",
      errors: ["Validation parameters are required."],
    };
  }

  // 1. Signature format check
  const sigBuf = normalizeSignature(params.signature, ED25519_SIGNATURE_BYTE_LENGTH);
  if (!sigBuf) {
    errors.push(
      `Invalid signature format: expected ${ED25519_SIGNATURE_BYTE_LENGTH} bytes (or ${ED25519_SIGNATURE_BYTE_LENGTH * 2} hex characters).`
    );
  }

  // 2. Public key format check
  const pubKeyStr = normalizePublicKey(params.publicKey);
  if (!pubKeyStr) {
    errors.push(
      "Invalid public key: expected a valid Stellar ed25519 public key ('G...') or 32-byte buffer."
    );
  }

  // 3. Message check
  const msgBuf = normalizeMessage(params.message);
  if (!msgBuf) {
    errors.push("Invalid message: message cannot be null or undefined.");
  }

  if (errors.length > 0 || !sigBuf || !pubKeyStr || !msgBuf) {
    return { valid: false, error: errors[0], errors };
  }

  // 4. Authenticity verification
  try {
    const keypair = Keypair.fromPublicKey(pubKeyStr);
    const verified = keypair.verify(msgBuf, sigBuf);

    if (!verified) {
      errors.push(
        `Cryptographic signature verification failed: signature does not match public key ${pubKeyStr}.`
      );
      return { valid: false, error: errors[0], errors };
    }

    return { valid: true, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`Signature verification error: ${message}`);
    return { valid: false, error: errors[0], errors };
  }
}

/**
 * Validate an Ed25519 signature and throw {@link SignatureValidationError} if invalid.
 *
 * @param params - Signature, message, and public key parameters.
 * @throws {SignatureValidationError} If validation fails.
 */
export function validateEd25519SignatureOrThrow(params: Ed25519ValidationParams): void {
  const result = validateEd25519Signature(params);
  if (!result.valid) {
    throw new SignatureValidationError(result.errors.join("; "), {
      errors: result.errors,
      publicKey: typeof params.publicKey === "string" ? params.publicKey : undefined,
    });
  }
}

/**
 * Validate a multi-signature threshold against authorized signers.
 *
 * Verification checks:
 * 1. Parameter integrity: Validates threshold, message, and signer arrays.
 * 2. Authenticity: Verifies each signature cryptographically.
 * 3. Authorization: Ensures each signer is part of the authorized `signers` config.
 * 4. Deduplication: Ensures each unique signer contributes weight only once.
 * 5. Threshold: Validates that accumulated weight >= required threshold.
 *
 * @param params - Multi-signature parameters.
 * @returns A {@link MultiSigValidationResult} with accumulated weight and verified signers.
 */
export function validateMultiSig(params: MultiSigValidationParams): MultiSigValidationResult {
  const errors: string[] = [];

  if (!params) {
    return {
      valid: false,
      totalWeight: 0,
      threshold: 0,
      verifiedSigners: [],
      errors: ["Multi-signature parameters are required."],
    };
  }

  const { message, signatures, signers, threshold } = params;

  if (threshold <= 0) {
    errors.push(`Threshold must be greater than zero (received ${threshold}).`);
  }

  if (!signers || signers.length === 0) {
    errors.push("Authorized signers list cannot be empty.");
  }

  if (!signatures || signatures.length === 0) {
    errors.push("Signatures list cannot be empty.");
  }

  if (errors.length > 0) {
    return {
      valid: false,
      totalWeight: 0,
      threshold,
      verifiedSigners: [],
      errors,
    };
  }

  // Build a lookup map of authorized signers: address -> weight
  const signerWeightMap = new Map<string, number>();
  for (const s of signers) {
    const norm = normalizePublicKey(s.address);
    if (norm) {
      signerWeightMap.set(norm, s.weight);
    }
  }

  const verifiedSigners: string[] = [];
  const seenSigners = new Set<string>();
  let totalWeight = 0;

  for (let i = 0; i < signatures.length; i++) {
    const entry = signatures[i];
    if (!entry) continue;
    const normSigner = normalizePublicKey(entry.signer);

    if (!normSigner) {
      errors.push(`Signature at index ${i} has an invalid signer address.`);
      continue;
    }

    if (seenSigners.has(normSigner)) {
      // Duplicate signer in signature list - do not count twice
      continue;
    }

    // Verify cryptographic signature
    const sigResult = validateEd25519Signature({
      publicKey: normSigner,
      message,
      signature: entry.signature,
    });

    if (!sigResult.valid) {
      errors.push(`Signature from ${normSigner} failed verification: ${sigResult.error}`);
      continue;
    }

    // Check if signer is authorized
    const weight = signerWeightMap.get(normSigner);
    if (weight === undefined || weight <= 0) {
      errors.push(`Signer ${normSigner} is not in the authorized signers list.`);
      continue;
    }

    seenSigners.add(normSigner);
    verifiedSigners.push(normSigner);
    totalWeight += weight;
  }

  const meetsThreshold = totalWeight >= threshold;
  if (!meetsThreshold) {
    errors.push(
      `Insufficient signature weight: accumulated weight ${totalWeight} is below required threshold ${threshold}.`
    );
  }

  return {
    valid: meetsThreshold,
    totalWeight,
    threshold,
    verifiedSigners,
    errors,
  };
}

/**
 * Validate a multi-signature threshold and throw {@link SignatureValidationError} if insufficient.
 *
 * @param params - Multi-signature parameters.
 * @throws {SignatureValidationError} If threshold is not met.
 */
export function validateMultiSigOrThrow(params: MultiSigValidationParams): void {
  const result = validateMultiSig(params);
  if (!result.valid) {
    throw new SignatureValidationError(result.errors.join("; "), {
      errors: result.errors,
      totalWeight: result.totalWeight,
      threshold: result.threshold,
    });
  }
}

/**
 * Validate an HMAC webhook signature with timing-safe comparison and replay protection.
 *
 * @param params - Webhook signature parameters.
 * @returns A {@link SignatureValidationResult}.
 */
export function validateWebhookSignature(
  params: WebhookValidationParams
): SignatureValidationResult {
  const errors: string[] = [];

  if (!params || !params.secret) {
    return {
      valid: false,
      error: "Webhook secret is required.",
      errors: ["Webhook secret is required."],
    };
  }

  if (!params.signature) {
    return {
      valid: false,
      error: "Webhook signature is required.",
      errors: ["Webhook signature is required."],
    };
  }

  let sig = params.signature.trim();
  if (params.signaturePrefix && sig.startsWith(params.signaturePrefix)) {
    sig = sig.slice(params.signaturePrefix.length);
  }

  // Validate hex format
  if (!HEX_REGEX.test(sig) || sig.length % 2 !== 0) {
    errors.push("Invalid webhook signature format: expected even-length hex string.");
    return { valid: false, error: errors[0], errors };
  }

  // Timestamp replay check if provided
  if (params.timestamp !== undefined) {
    const tolerance = params.toleranceSeconds ?? 300;
    const now = Math.floor(Date.now() / 1000);
    let ts =
      typeof params.timestamp === "number"
        ? Math.floor(params.timestamp)
        : parseInt(params.timestamp, 10);

    // If timestamp in ms, convert to seconds
    if (ts > 100_000_000_000) {
      ts = Math.floor(ts / 1000);
    }

    if (isNaN(ts)) {
      errors.push("Invalid timestamp format in webhook payload.");
      return { valid: false, error: errors[0], errors };
    }

    if (Math.abs(now - ts) > tolerance) {
      errors.push(
        `Webhook signature expired: timestamp ${ts} differs from current time ${now} by more than ${tolerance} seconds.`
      );
      return { valid: false, error: errors[0], errors };
    }
  }

  // Compute expected HMAC
  const algorithm = params.algorithm ?? "sha256";
  const body =
    params.timestamp !== undefined
      ? `${params.timestamp}.${typeof params.payload === "string" ? params.payload : params.payload.toString("utf8")}`
      : params.payload;

  let expectedBuf: Buffer;
  try {
    expectedBuf = createHmac(algorithm, params.secret).update(body).digest();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Failed to compute HMAC: ${msg}`);
    return { valid: false, error: errors[0], errors };
  }

  const providedBuf = Buffer.from(sig, "hex");

  if (expectedBuf.length !== providedBuf.length) {
    errors.push("Webhook signature length does not match expected algorithm digest length.");
    return { valid: false, error: errors[0], errors };
  }

  const matches = timingSafeEqual(expectedBuf, providedBuf);
  if (!matches) {
    errors.push("Webhook signature verification failed: signature does not match payload digest.");
    return { valid: false, error: errors[0], errors };
  }

  return { valid: true, errors: [] };
}

/**
 * Reusable validator class for cryptographic and webhook signatures.
 */
export class SignatureValidator {
  /**
   * Validate an Ed25519 signature.
   */
  validateEd25519(params: Ed25519ValidationParams): SignatureValidationResult {
    return validateEd25519Signature(params);
  }

  /**
   * Validate an Ed25519 signature or throw {@link SignatureValidationError}.
   */
  validateEd25519OrThrow(params: Ed25519ValidationParams): void {
    return validateEd25519SignatureOrThrow(params);
  }

  /**
   * Validate multi-signature threshold.
   */
  validateMultiSig(params: MultiSigValidationParams): MultiSigValidationResult {
    return validateMultiSig(params);
  }

  /**
   * Validate multi-signature threshold or throw {@link SignatureValidationError}.
   */
  validateMultiSigOrThrow(params: MultiSigValidationParams): void {
    return validateMultiSigOrThrow(params);
  }

  /**
   * Validate a webhook signature.
   */
  validateWebhook(params: WebhookValidationParams): SignatureValidationResult {
    return validateWebhookSignature(params);
  }
}
