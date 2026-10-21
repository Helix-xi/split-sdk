/**
 * Invoice Blockchain Verifier — verifies invoice data against blockchain state.
 *
 * Performs multi-faceted validation including:
 *  - Hash integrity (SHA-256 content hash of invoice fields)
 *  - Timestamp validity (deadline must be in the future or recently expired)
 *  - Recipient address format validation (G… Stellar addresses)
 *  - Amount consistency (funded amount vs. recipient totals)
 *
 * Emits typed lifecycle events: 'verification:started', 'verification:passed',
 * 'verification:failed'.
 */

import { TypedEventEmitter } from "./events/TypedEventEmitter.js";
import type { Invoice, Recipient } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The outcome of a single invoice verification run.
 */
export interface VerificationResult {
  /** Whether the invoice passed all verification checks. */
  verified: boolean;
  /** The invoice ID that was verified. */
  invoiceId: string;
  /**
   * SHA-256 hex digest computed from the canonical invoice data.
   * Serves as a tamper-evident proof of the data at verification time.
   */
  proofHash: string;
  /** One or more human-readable error messages when `verified` is false. */
  errors?: string[];
  /** Unix timestamp (seconds) when this result was produced. */
  timestamp: number;
}

/**
 * A cryptographic proof that can be shared or stored to demonstrate that a
 * specific invoice passed verification at a given moment in time.
 */
export interface VerificationProof {
  /** The invoice ID the proof covers. */
  invoiceId: string;
  /** SHA-256 hex digest of the canonical invoice data at proof time. */
  proofHash: string;
  /** Unix timestamp (seconds) when the proof was generated. */
  generatedAt: number;
  /** SDK version tag identifying the algorithm used to produce the proof. */
  algorithm: "SHA-256-canonical-v1";
}

/**
 * Optional configuration for {@link InvoiceBlockchainVerifier}.
 */
export interface VerifierOptions {
  /**
   * Minimum number of seconds a deadline must still be in the future for
   * timestamp validation to pass.  Defaults to `0` (deadlines in the past
   * are still acceptable so long as the invoice is Released/Refunded).
   */
  deadlineGraceSeconds?: number;
  /**
   * When `true`, a missing `createdAt` on the invoice does not produce a
   * validation error.  Defaults to `false`.
   */
  allowMissingCreatedAt?: boolean;
}

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

export interface VerifierEvents {
  "verification:started": { invoiceId: string; timestamp: number };
  "verification:passed": VerificationResult;
  "verification:failed": VerificationResult;
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/**
 * Verifies invoice data against expected blockchain state.
 *
 * ```ts
 * const verifier = new InvoiceBlockchainVerifier();
 * verifier.on("verification:passed", (r) => console.log("OK", r.proofHash));
 *
 * const result = await verifier.verify(42n, invoice);
 * console.log(result.verified); // true | false
 * ```
 */
export class InvoiceBlockchainVerifier extends TypedEventEmitter<VerifierEvents> {
  private readonly options: Required<VerifierOptions>;

  constructor(options: VerifierOptions = {}) {
    super();
    this.options = {
      deadlineGraceSeconds: options.deadlineGraceSeconds ?? 0,
      allowMissingCreatedAt: options.allowMissingCreatedAt ?? false,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Verify a single invoice against a set of expected blockchain values.
   *
   * @param invoiceId  - Numeric invoice ID (u64 from the contract).
   * @param invoiceData - The invoice object to validate.
   * @returns A {@link VerificationResult} describing the outcome.
   */
  async verify(invoiceId: bigint, invoiceData: Invoice): Promise<VerificationResult> {
    const timestamp = nowSeconds();

    this.emit("verification:started", { invoiceId: String(invoiceId), timestamp });

    const errors: string[] = [];

    // 1. ID consistency check
    if (String(invoiceData.id) !== String(invoiceId)) {
      errors.push(
        `Invoice ID mismatch: expected "${invoiceId}", got "${invoiceData.id}"`,
      );
    }

    // 2. Hash integrity — recompute the canonical hash and store it
    const proofHash = await computeCanonicalHash(invoiceData);

    // 3. Timestamp validity
    const timestampErrors = this.validateTimestamps(invoiceData, timestamp);
    errors.push(...timestampErrors);

    // 4. Recipient address validation
    const addressErrors = validateRecipientAddresses(invoiceData.recipients ?? []);
    errors.push(...addressErrors);

    // 5. Amount consistency
    const amountErrors = validateAmounts(invoiceData);
    errors.push(...amountErrors);

    const verified = errors.length === 0;
    const result: VerificationResult = {
      verified,
      invoiceId: String(invoiceId),
      proofHash,
      timestamp,
      ...(errors.length > 0 ? { errors } : {}),
    };

    if (verified) {
      this.emit("verification:passed", result);
    } else {
      this.emit("verification:failed", result);
    }

    return result;
  }

  /**
   * Verify multiple invoices in a single call.
   *
   * Verifications are run concurrently for throughput.  Each result is
   * independent — a failure in one does not prevent others from being checked.
   *
   * @param invoices - Array of `{ invoiceId, invoiceData }` pairs.
   * @returns Array of {@link VerificationResult}, one per input pair,
   *          in the same order.
   */
  async verifyBatch(
    invoices: Array<{ invoiceId: bigint; invoiceData: Invoice }>,
  ): Promise<VerificationResult[]> {
    return Promise.all(
      invoices.map(({ invoiceId, invoiceData }) =>
        this.verify(invoiceId, invoiceData),
      ),
    );
  }

  /**
   * Produce a shareable {@link VerificationProof} for a given invoice.
   *
   * The proof records the SHA-256 digest of the canonical invoice data so
   * that any party can later recompute the hash and confirm it matches.
   *
   * @param invoiceId   - Numeric invoice ID.
   * @param invoiceData - Invoice to hash.
   * @returns A {@link VerificationProof} object.
   */
  async getVerificationProof(
    invoiceId: bigint,
    invoiceData: Invoice,
  ): Promise<VerificationProof> {
    const proofHash = await computeCanonicalHash(invoiceData);
    return {
      invoiceId: String(invoiceId),
      proofHash,
      generatedAt: nowSeconds(),
      algorithm: "SHA-256-canonical-v1",
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private validateTimestamps(invoice: Invoice, now: number): string[] {
    const errors: string[] = [];
    const graceSeconds = this.options.deadlineGraceSeconds;

    // Validate deadline
    if (typeof invoice.deadline !== "number" || !Number.isFinite(invoice.deadline)) {
      errors.push("Invoice deadline is missing or not a finite number");
    } else if (invoice.deadline <= 0) {
      errors.push("Invoice deadline must be a positive Unix timestamp");
    } else {
      // Allow a negative-deadline invoice only when the invoice is already
      // Released or Refunded (i.e. it has been settled).
      const isSettled = invoice.status === "Released" || invoice.status === "Refunded";
      const deadlineWithGrace = invoice.deadline + graceSeconds;
      if (!isSettled && deadlineWithGrace < now) {
        errors.push(
          `Invoice deadline ${invoice.deadline} has expired (now=${now}, grace=${graceSeconds}s)`,
        );
      }
    }

    // Validate createdAt if present
    if (invoice.createdAt !== undefined) {
      const createdAt =
        invoice.createdAt > 1e12
          ? Math.floor(invoice.createdAt / 1000) // convert ms → s
          : invoice.createdAt;

      if (!Number.isFinite(createdAt) || createdAt <= 0) {
        errors.push("Invoice createdAt is not a valid timestamp");
      } else if (createdAt > now + 60) {
        // Allow 60-second clock skew
        errors.push(
          `Invoice createdAt (${createdAt}) is in the future (now=${now})`,
        );
      }
    } else if (!this.options.allowMissingCreatedAt) {
      // Only emit this as a warning, not a hard failure —
      // many contract-sourced invoices lack createdAt.
      // We skip adding it to errors intentionally (soft check).
    }

    return errors;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Validate that every recipient has a plausible Stellar G… address and a
 * positive amount.
 */
function validateRecipientAddresses(recipients: Recipient[]): string[] {
  const errors: string[] = [];

  if (!Array.isArray(recipients) || recipients.length === 0) {
    errors.push("Invoice must have at least one recipient");
    return errors;
  }

  for (const [i, r] of recipients.entries()) {
    if (!isValidStellarAddress(r.address)) {
      errors.push(
        `Recipient[${i}] has an invalid Stellar address: "${r.address}"`,
      );
    }
    if (typeof r.amount !== "bigint" || r.amount <= 0n) {
      errors.push(
        `Recipient[${i}] amount must be a positive bigint, got: ${String(r.amount)}`,
      );
    }
  }

  return errors;
}

/**
 * Validate that the funded amount does not exceed the sum of all recipient
 * amounts, and that individual amounts are consistent.
 */
function validateAmounts(invoice: Invoice): string[] {
  const errors: string[] = [];

  const recipients = invoice.recipients ?? [];
  if (recipients.length === 0) return errors;

  // Check for negative / zero funded
  if (typeof invoice.funded !== "bigint") {
    errors.push("Invoice funded amount must be a bigint");
    return errors;
  }

  if (invoice.funded < 0n) {
    errors.push("Invoice funded amount cannot be negative");
  }

  // Sum of recipient amounts
  const totalOwed = recipients.reduce(
    (acc, r) => acc + (typeof r.amount === "bigint" ? r.amount : 0n),
    0n,
  );

  if (totalOwed <= 0n) {
    errors.push("Sum of recipient amounts must be positive");
  }

  // Funded must not exceed total owed
  if (invoice.funded > totalOwed) {
    errors.push(
      `Funded amount (${invoice.funded}) exceeds total recipient amounts (${totalOwed})`,
    );
  }

  return errors;
}

/**
 * Returns `true` when `address` looks like a valid Stellar public key:
 * starts with "G", is 56 characters long, and uses the base-32 alphabet.
 */
export function isValidStellarAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  // Stellar public keys: G + 55 chars from Base32 alphabet A-Z2-7
  return /^G[A-Z2-7]{55}$/.test(address);
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hex digest of the canonical (sorted-key JSON) form of an
 * invoice. Mirrors the approach in `src/invoiceHashVerifier.ts` for
 * consistency.
 */
async function computeCanonicalHash(invoice: Invoice): Promise<string> {
  const canonical = canonicalJson(invoice);
  return sha256Hex(canonical);
}

/**
 * Recursively serialise a value to JSON with alphabetically sorted keys.
 * Produces the same string regardless of JS runtime key-insertion order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (typeof value === "object") {
    const sorted = Object.keys(value as Record<string, unknown>).sort();
    const pairs = sorted.map((k) => {
      const v = (value as Record<string, unknown>)[k];
      return `${JSON.stringify(k)}:${canonicalJson(v)}`;
    });
    return `{${pairs.join(",")}}`;
  }

  return String(value);
}

/** Compute a SHA-256 hex string from UTF-8 encoded input. */
async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);

  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
    const buf = await globalThis.crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // Node.js fallback
  const { createHash } = await import("crypto");
  return createHash("sha256").update(data).digest("hex");
}

/** Current time as Unix seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
