/**
 * Pre-submit transaction verification for StellarSplit (issue #1066).
 *
 * Verifies the integrity and authenticity of a Stellar transaction before it
 * is submitted to the network. Each concern is an isolated, independently
 * testable check, and the composed {@link verifyTransaction} runs every check
 * and returns a structured result. Use {@link assertTransactionVerified} to
 * fail fast with a {@link TransactionVerificationError}.
 *
 * ## Checks
 *
 * - `structure` — at least one operation and a parseable positive integer fee.
 * - `fee`       — the fee is positive and (optionally) at or below `maxFee`.
 * - `sequence`  — the sequence number equals `expectedSequence`, when provided.
 * - `timebounds`— "now" lies within the transaction's time bounds.
 * - `signatures`— every required signer holds a valid signature over the hash.
 * - `hash`      — the recomputed hash equals `expectedHash`, when provided.
 *
 * @example
 * ```ts
 * import { verifyTransaction, assertTransactionVerified } from "@stellar-split/sdk";
 *
 * const result = verifyTransaction(tx, {
 *   signers: [walletPublicKey],
 *   maxFee: 500_000,
 *   expectedSequence: account.sequenceNumber(),
 * });
 * if (!result.valid) {
 *   console.warn("Refusing to submit:", result.failedChecks);
 * }
 *
 * // Or fail fast on the first run with any failed check:
 * assertTransactionVerified(tx, { signers: [walletPublicKey] });
 * ```
 */

import { Keypair, Transaction } from "@stellar/stellar-sdk";
import { TransactionVerificationError } from "./errors.js";

/** Names of the individual checks performed by {@link verifyTransaction}. */
export type TransactionCheckName =
  | "structure"
  | "fee"
  | "sequence"
  | "timebounds"
  | "signatures"
  | "hash";

/** Outcome of a single verification check. */
export interface TransactionCheckResult {
  /** The check this result describes. */
  name: TransactionCheckName;
  /** `true` if the check passed. */
  passed: boolean;
  /** Human-readable detail explaining the outcome. */
  detail: string;
}

/** Aggregated result of running every verification check. */
export interface TransactionVerificationResult {
  /** `true` when every check passed. */
  valid: boolean;
  /** Per-check results, in execution order. */
  checks: TransactionCheckResult[];
  /** Names of the checks that failed (empty when `valid`). */
  failedChecks: TransactionCheckName[];
}

/** Options controlling which checks {@link verifyTransaction} performs. */
export interface TransactionVerificationOptions {
  /** Maximum acceptable total fee, in stroops. Fee check is skipped when omitted. */
  maxFee?: number | bigint | string;
  /** The exact sequence number the transaction must carry. Skipped when omitted. */
  expectedSequence?: string;
  /** The hex- or base64-encoded hash the transaction must match. Skipped when omitted. */
  expectedHash?: string;
  /** `G...` public keys that must each hold a valid signature over the tx hash. */
  signers?: string[];
  /** Minimum number of signature entries the transaction must carry (default: 1). */
  minSignatures?: number;
  /** Unix time (seconds) used for the time-bounds check (default: now). */
  now?: number;
}

/** Outcome of verifying the signatures of a transaction for a set of keys. */
export interface SignatureVerificationResult {
  /** Signers that produced a valid signature over the transaction hash. */
  valid: string[];
  /** Signers with no signature present on the transaction. */
  missing: string[];
  /** Signers with a signature present that failed cryptographic verification. */
  invalid: string[];
}

function toBigIntSafe(value: string | number | bigint): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Verify that each of `publicKeys` holds a valid signature over `tx`'s hash.
 *
 * Decorated signatures carry a 4-byte hint derived from the signer's public
 * key; candidates are filtered by hint and then verified cryptographically
 * with ed25519 over the 32-byte transaction hash. Hints are advisory only —
 * a signature counts as valid solely when ed25519 verification succeeds.
 *
 * @param tx - The (partially or fully) signed transaction.
 * @param publicKeys - `G...` keys expected to have signed the transaction.
 */
export function verifyTransactionSignatures(
  tx: Transaction,
  publicKeys: string[],
): SignatureVerificationResult {
  const result: SignatureVerificationResult = { valid: [], missing: [], invalid: [] };
  if (publicKeys.length === 0) {
    return result;
  }

  const hash = tx.hash();

  for (const publicKey of publicKeys) {
    let keypair: Keypair;
    try {
      keypair = Keypair.fromPublicKey(publicKey);
    } catch {
      // Not a parseable G-address — it can never hold a valid signature.
      result.invalid.push(publicKey);
      continue;
    }

    const keyHint = keypair.signatureHint().toString("hex");
    const candidates = tx.signatures.filter(
      (sig) => Buffer.from(sig.hint()).toString("hex") === keyHint,
    );

    if (candidates.length === 0) {
      result.missing.push(publicKey);
      continue;
    }

    let verified = false;
    for (const decorated of candidates) {
      try {
        if (keypair.verify(hash, Buffer.from(decorated.signature()))) {
          verified = true;
          break;
        }
      } catch {
        // Malformed signature payload — treated as a failed verification.
      }
    }

    if (verified) {
      result.valid.push(publicKey);
    } else {
      result.invalid.push(publicKey);
    }
  }

  return result;
}

/**
 * Run every verification check against `tx` and return the structured result.
 *
 * Checks whose options are omitted (e.g. `maxFee`, `expectedSequence`,
 * `expectedHash`) are skipped rather than passed vacuously, so callers only
 * assert the properties they can vouch for.
 *
 * @param tx - The transaction to verify.
 * @param options - Which additional properties the transaction must satisfy.
 */
export function verifyTransaction(
  tx: Transaction,
  options: TransactionVerificationOptions = {},
): TransactionVerificationResult {
  const checks: TransactionCheckResult[] = [];

  // --- structure ---------------------------------------------------------
  const operationCount = tx.operations.length;
  const rawFee = toBigIntSafe(tx.fee);
  const structureOk = operationCount > 0 && rawFee !== null && rawFee > 0n;
  checks.push({
    name: "structure",
    passed: structureOk,
    detail: structureOk
      ? `Transaction has ${operationCount} operation(s) and fee ${tx.fee}`
      : `Malformed transaction: ${operationCount} operation(s), fee "${tx.fee}"`,
  });

  // --- fee ---------------------------------------------------------------
  if (options.maxFee !== undefined) {
    const maxFee = toBigIntSafe(options.maxFee);
    const feeOk = rawFee !== null && maxFee !== null && rawFee > 0n && rawFee <= maxFee;
    checks.push({
      name: "fee",
      passed: feeOk,
      detail: feeOk
        ? `Fee ${tx.fee} is within max ${String(options.maxFee)}`
        : `Fee ${tx.fee} exceeds maximum ${String(options.maxFee)} (or is not a positive integer)`,
    });
  }

  // --- sequence ----------------------------------------------------------
  if (options.expectedSequence !== undefined) {
    const seqOk = tx.sequence === options.expectedSequence;
    checks.push({
      name: "sequence",
      passed: seqOk,
      detail: seqOk
        ? `Sequence ${tx.sequence} matches expected`
        : `Sequence ${tx.sequence} does not match expected ${options.expectedSequence}`,
    });
  }

  // --- time bounds -------------------------------------------------------
  const timeBounds = tx.timeBounds;
  if (timeBounds !== undefined && timeBounds !== null) {
    const now = BigInt(options.now ?? Math.floor(Date.now() / 1000));
    const minTime = BigInt(timeBounds.minTime);
    const maxTime = BigInt(timeBounds.maxTime);
    const afterMin = now >= minTime;
    // maxTime is exclusive; 0 means "no upper bound".
    const beforeMax = maxTime === 0n || now < maxTime;
    const boundsOk = afterMin && beforeMax;
    checks.push({
      name: "timebounds",
      passed: boundsOk,
      detail: boundsOk
        ? `Now (${now}) is within [${timeBounds.minTime}, ${timeBounds.maxTime})`
        : `Now (${now}) is outside time bounds [${timeBounds.minTime}, ${timeBounds.maxTime})`,
    });
  }

  // --- signatures --------------------------------------------------------
  // Without an explicit signer list, at least one signature entry must be
  // present; with signers, minSignatures defaults to 0 and each listed key
  // must hold a cryptographically valid signature.
  const minSignatures = options.minSignatures ?? (options.signers ? 0 : 1);
  const signatureDetailParts: string[] = [];
  let signaturesOk = tx.signatures.length >= Math.max(minSignatures, 0);

  if (!signaturesOk) {
    signatureDetailParts.push(
      `Transaction carries ${tx.signatures.length} signature(s); ${minSignatures} required`,
    );
  }

  if (options.signers && options.signers.length > 0) {
    const sigResult = verifyTransactionSignatures(tx, options.signers);
    if (sigResult.valid.length > 0) {
      signatureDetailParts.push(`valid: [${sigResult.valid.join(", ")}]`);
    }
    if (sigResult.missing.length > 0) {
      signaturesOk = false;
      signatureDetailParts.push(`missing: [${sigResult.missing.join(", ")}]`);
    }
    if (sigResult.invalid.length > 0) {
      signaturesOk = false;
      signatureDetailParts.push(`invalid: [${sigResult.invalid.join(", ")}]`);
    }
  } else if (signaturesOk) {
    signatureDetailParts.push(`${tx.signatures.length} signature(s) present`);
  }

  checks.push({
    name: "signatures",
    passed: signaturesOk,
    detail: signatureDetailParts.join("; "),
  });

  // --- hash integrity ----------------------------------------------------
  if (options.expectedHash !== undefined) {
    const hash = tx.hash();
    const expected = options.expectedHash.toLowerCase();
    const hashOk =
      hash.toString("hex").toLowerCase() === expected ||
      hash.toString("base64") === options.expectedHash;
    checks.push({
      name: "hash",
      passed: hashOk,
      detail: hashOk
        ? "Transaction hash matches expected"
        : `Transaction hash ${hash.toString("hex")} does not match expected ${options.expectedHash}`,
    });
  }

  const failedChecks = checks.filter((c) => !c.passed).map((c) => c.name);
  return { valid: failedChecks.length === 0, checks, failedChecks };
}

/**
 * Verify `tx` and throw {@link TransactionVerificationError} if any check
 * fails; otherwise return the successful result.
 *
 * @param tx - The transaction to verify.
 * @param options - Which additional properties the transaction must satisfy.
 * @throws {TransactionVerificationError} Carries the names of the failed checks.
 */
export function assertTransactionVerified(
  tx: Transaction,
  options: TransactionVerificationOptions = {},
): TransactionVerificationResult {
  const result = verifyTransaction(tx, options);
  if (!result.valid) {
    throw new TransactionVerificationError(result.failedChecks, {
      checks: result.checks,
    });
  }
  return result;
}

