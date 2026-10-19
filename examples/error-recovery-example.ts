/**
 * Example: Error recovery strategies, error codes, and pre-submit validation
 *
 * Demonstrates the pieces added by issues #1065–#1068:
 *
 * 1. Validating a Soroban contract address before it is used (#1065)
 * 2. Verifying transaction integrity/authenticity before submission (#1066)
 * 3. Inspecting comprehensive error codes and their descriptions (#1067)
 * 4. Mapping errors to recovery strategies and recovering automatically (#1068)
 *
 * Run with: npx tsx examples/error-recovery-example.ts
 */

import {
  // #1065 — contract address validation
  validateContractAddress,
  isValidContractAddress,
  assertValidContractAddress,
  // #1066 — transaction verification
  verifyTransaction,
  assertTransactionVerified,
  // #1067 — comprehensive error codes
  SdkError,
  SdkErrorCode,
  describeSdkErrorCode,
  isRetryableErrorCode,
  // #1068 — recovery strategies
  getRecoveryStrategy,
  getRecoveryPlan,
  executeWithRecovery,
} from "@stellar-split/sdk";

// ---------------------------------------------------------------------------
// 1. Contract address validation (#1065)
// ---------------------------------------------------------------------------

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

console.log("== Contract address validation (#1065) ==");

const validation = validateContractAddress(CONTRACT_ID);
console.log(`validateContractAddress(${CONTRACT_ID.slice(0, 12)}...)`);
console.log(`  valid:    ${validation.valid}`); // true
console.log(`  format:   ${validation.format}`); // true — length, prefix, base32
console.log(`  checksum: ${validation.checksum}`); // true — CRC16 verified

const typo = `${CONTRACT_ID.slice(0, 55)}${CONTRACT_ID[55] === "4" ? "5" : "4"}`;
console.log(`\nTypo'd checksum: ${isValidContractAddress(typo)}`); // false
console.log(`  errors: ${validateContractAddress(typo).errors.join("; ")}`);

try {
  assertValidContractAddress("not-a-contract");
} catch (err) {
  console.log(`\nassertValidContractAddress threw: ${(err as Error).message}`);
}

// ---------------------------------------------------------------------------
// 2. Transaction verification before submit (#1066)
// ---------------------------------------------------------------------------

console.log("\n== Transaction verification (#1066) ==");

// In real usage you would build and sign a transaction with your wallet.
// Here we only show the API surface:
//
//   const result = verifyTransaction(tx, {
//     signers: [walletPublicKey],      // every key must hold a valid signature
//     maxFee: 500_000,                 // refuse to overpay
//     expectedSequence: account.sequenceNumber(), // refuse stale sequences
//     expectedHash: previouslyComputedHash,       // refuse tampered payloads
//   });
//   if (!result.valid) {
//     console.warn("Refusing to submit, failed checks:", result.failedChecks);
//   }
//
//   // Or fail fast:
//   assertTransactionVerified(tx, { signers: [walletPublicKey] });

console.log("verifyTransaction(tx, { signers, maxFee, expectedSequence }) runs");
console.log("checks: structure, fee, sequence, timebounds, signatures, hash");
console.log("assertTransactionVerified throws TransactionVerificationError on failure");

// ---------------------------------------------------------------------------
// 3. Comprehensive error codes (#1067)
// ---------------------------------------------------------------------------

console.log("\n== Comprehensive error codes (#1067) ==");

const exampleError = new SdkError(
  "The transaction's sequence number is stale",
  SdkErrorCode.SEQUENCE_MISMATCH,
);

console.log(`code:        ${exampleError.code}`);
console.log(`description: ${describeSdkErrorCode(exampleError.code)}`);
console.log(`retryable:   ${isRetryableErrorCode(exampleError.code)}`);

// ---------------------------------------------------------------------------
// 4. Recovery strategies (#1068)
// ---------------------------------------------------------------------------

console.log("\n== Recovery strategies (#1068) ==");

const strategy = getRecoveryStrategy(exampleError);
console.log(`action:      ${strategy.action}`); // refresh_and_retry
console.log(`retryable:   ${strategy.retryable}`); // false — rebuild required
console.log(`description: ${strategy.description}`);

const plan = getRecoveryPlan(exampleError);
console.log(`\nFull recovery plan:`);
console.log(`  code:       ${plan.code}`);
console.log(`  action:     ${plan.strategy.action}`);
console.log(`  suggestion: ${plan.suggestion}`);

// Automatic recovery: retry transient failures with the mapped backoff.
console.log("\nAutomatic recovery with executeWithRecovery:");

let attempts = 0;
const flakyGetInvoice = async () => {
  attempts += 1;
  if (attempts < 3) {
    // Simulate a transient network failure the SDK classifies as retryable.
    throw new SdkError("Request timed out", SdkErrorCode.NETWORK_TIMEOUT);
  }
  return { id: "inv-1", status: "Pending" };
};

const invoice = await executeWithRecovery(flakyGetInvoice, {
  onRetry: (attempt, s) =>
    console.warn(`  retry ${attempt}: ${s.description}`),
});

console.log(`  result after ${attempts} attempts:`, invoice);

// Non-retryable failures are surfaced immediately, with a plan attached.
console.log("\nNon-retryable failures are NOT retried:");
try {
  await executeWithRecovery(async () => {
    throw new SdkError("stale sequence", SdkErrorCode.SEQUENCE_MISMATCH);
  });
} catch (err) {
  const e = err as SdkError;
  const plan = getRecoveryPlan(e);
  console.log(`  caught ${e.code} → action: ${plan.strategy.action}`);
}
