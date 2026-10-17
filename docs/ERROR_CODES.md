# Error Code Reference Guide

This document is the comprehensive reference guide for all error codes, causes, recovery actions, and error-handling patterns in the StellarSplit SDK.

---

## Table of Contents

1. [Error Handling Architecture](#1-error-handling-architecture)
2. [Master Error Code Index](#2-master-error-code-index)
3. [Invoice Lifecycle Errors](#3-invoice-lifecycle-errors)
4. [Payment & Settlement Errors](#4-payment--settlement-errors)
5. [Network, RPC & Submission Errors](#5-network-rpc--submission-errors)
6. [Authorization & Access Control Errors](#6-authorization--access-control-errors)
7. [Dispute & Governance Errors](#7-dispute--governance-errors)
8. [Milestones, Rounds & Referrals Errors](#8-milestones-rounds--referrals-errors)
9. [Validation & Batch Errors](#9-validation--batch-errors)
10. [Recommended Error Handling Patterns](#10-recommended-error-handling-patterns)

---

## 1. Error Handling Architecture

All typed errors thrown by the SDK extend `StellarSplitError` (which extends the JavaScript `Error` class).

```typescript
export class StellarSplitError extends Error {
  readonly code: string;                     // Unique programmatic error code
  readonly context?: Record<string, unknown>; // Diagnostic metadata (IDs, amounts, etc.)
  readonly raw?: string;                     // Raw panic message from Soroban RPC
}
```

### Key Error Handling Capabilities
- **`instanceof` discrimination**: Catch specific error classes cleanly without string parsing.
- **`isRetryable(error)`**: Synchronous helper returning `true` for transient network/RPC glitches or cooldown windows, and `false` for terminal business logic errors.
- **Type Guard functions**: Every error class provides a companion type guard function (e.g. `isInvoiceNotFoundError(err)`).

---

## 2. Master Error Code Index

| Error Code | Error Class | Retryable? | Domain |
| :--- | :--- | :--- | :--- |
| `INVOICE_NOT_FOUND` | `InvoiceNotFoundError` | No | Invoice |
| `INVOICE_NOT_PENDING` | `InvoiceNotPendingError` | No | Invoice |
| `DEADLINE_PASSED` | `DeadlinePassedError` | No | Invoice |
| `INVOICE_EXPIRED` | `InvoiceExpiredError` | No | Invoice |
| `INVOICE_FROZEN` | `InvoiceFrozenError` | No | Invoice / Admin |
| `INVOICE_FULLY_FUNDED` | `InvoiceFullyFundedError` | No | Invoice / Payment |
| `INVOICE_NOT_RELEASED` | `InvoiceNotReleasedError` | No | Invoice |
| `INVOICE_NOT_CLONEABLE` | `InvoiceNotCloneableError` | No | Invoice |
| `CLONE_CHAIN_TOO_DEEP` | `CloneChainTooDeepError` | No | Invoice |
| `DELEGATE_LIMIT_REACHED` | `DelegateLimitReachedError` | No | Invoice |
| `INVALID_TRANSITION` | `InvalidTransitionError` | No | State Machine |
| `INSUFFICIENT_BALANCE` | `InsufficientBalanceError` | No | Payment |
| `PAYMENT_EXCEEDS_REMAINING` | `PaymentExceedsRemainingError` | No | Payment |
| `DUPLICATE_PAYMENT` | `DuplicatePaymentError` | No | Payment |
| `PAYMENT_EXPIRED` | `PaymentExpiredError` | No | Payment |
| `PAYMENT_COOLDOWN_ACTIVE` | `PaymentCooldownActiveError` | **Yes** | Payment |
| `CONTRIBUTION_CAP_EXCEEDED` | `ContributionCapExceededError` | No | Payment |
| `NO_PENDING_PAYOUT` | `NoPendingPayoutError` | No | Payment |
| `INSUFFICIENT_LIQUIDITY` | `InsufficientLiquidityError` | No | Liquidity Pool |
| `WATERFALL_INSUFFICIENT_FUNDS` | `WaterfallInsufficientFundsError` | No | Payment |
| `RPC_ERROR` | `RpcError` | **Yes** (429/503) | Network & RPC |
| `RPC_UNAVAILABLE` | `RpcUnavailableError` | **Yes** | Network & RPC |
| `RPC_CONNECTION_ERROR` | `RpcConnectionError` | **Yes** | Network & RPC |
| `REQUEST_TIMEOUT` | `RequestTimeoutError` | **Yes** | Network & RPC |
| `CIRCUIT_OPEN` | `CircuitOpenError` | **Yes** | Network & RPC |
| `TRANSACTION_FAILED` | `TransactionFailedError` | No | Submission |
| `TRANSACTION_NOT_CONFIRMED` | `TransactionNotConfirmedError` | **Yes** | Submission |
| `SIMULATION_FAILED` | `SimulationFailedError` | No | Simulation |
| `PASSPHRASE_MISMATCH` | `PassphraseMismatchError` | No | Network Config |
| `NETWORK_MISMATCH` | `NetworkMismatchError` | No | Network Config |
| `UNAUTHORIZED` | `UnauthorizedError` | No | Auth & Access |
| `WALLET_NOT_CONNECTED` | `WalletNotConnectedError` | No | Wallet |
| `INSUFFICIENT_SIGNATURES` | `InsufficientSignaturesError` | No | Multi-sig |
| `INSUFFICIENT_SIGNER_WEIGHT` | `InsufficientSignerWeightError` | No | Multi-sig |
| `NFT_GATE_REQUIRED` | `NftGateRequiredError` | No | Access Control |
| `TOKEN_GATE_ACCESS_DENIED` | `TokenGateAccessDeniedError` | No | Access Control |
| `PAYER_NOT_WHITELISTED` | `PayerNotWhitelistedError` | No | Access Control |
| `CONTRACT_FROZEN` | `ContractFrozenError` | No | Contract |
| `ADMIN_OPERATION_ERROR` | `AdminOperationError` | No | Admin |
| `DISPUTE_EVIDENCE_ERROR` | `DisputeEvidenceError` | No | Dispute |
| `CO_CREATOR_APPROVAL_NOT_REQUIRED` | `CoCreatorApprovalNotRequiredError` | No | Multi-party |
| `ROUND_NOT_ENDED` | `RoundNotEndedError` | No | Rounds |
| `WRONG_MILESTONE` | `WrongMilestoneError` | No | Milestones |
| `NOTHING_TO_CLAIM` | `NothingToClaimError` | No | Referrals |
| `VALIDATION_ERROR` | `ValidationError` | No | Validation |
| `BATCH_TOO_LARGE` | `BatchTooLargeError` | No | Batch Operations |

---

## 3. Invoice Lifecycle Errors

### `INVOICE_NOT_FOUND`
- **Class**: `InvoiceNotFoundError`
- **Cause**: The requested invoice ID does not exist in contract instance storage or has been purged.
- **Recovery Action**: Check that the invoice ID is formatted correctly; verify that the invoice creation transaction succeeded on the target network.
- **Example**:
```typescript
try {
  const invoice = await client.invoices.get("inv-999");
} catch (err) {
  if (err instanceof InvoiceNotFoundError) {
    console.warn(`Invoice ${err.invoiceId} does not exist.`);
    // Prompt user to verify ID or recreate invoice
  }
}
```

### `INVOICE_NOT_PENDING`
- **Class**: `InvoiceNotPendingError`
- **Cause**: An operation requiring an unfunded active invoice was called on an invoice in `Released`, `Refunded`, or `Cancelled` status.
- **Recovery Action**: Fetch the latest invoice status via `client.invoices.get(id)` and update UI controls to disable payment or cancellation buttons.

### `DEADLINE_PASSED` / `INVOICE_EXPIRED`
- **Classes**: `DeadlinePassedError`, `InvoiceExpiredError`
- **Cause**: The Unix timestamp deadline for the invoice has passed. Further payments or modifications are rejected by the contract.
- **Recovery Action**: Request the invoice creator or co-creators to vote on extending the deadline (`client.voteExtendDeadline()`), or issue a fresh replacement invoice.
- **Example**:
```typescript
try {
  await client.payments.pay({ invoiceId, amount, payer });
} catch (err) {
  if (err instanceof DeadlinePassedError) {
    console.error(`Invoice ${err.invoiceId} expired.`);
    // Offer to clone or recreate invoice
  }
}
```

### `INVOICE_FULLY_FUNDED`
- **Class**: `InvoiceFullyFundedError`
- **Cause**: Attempted to submit a payment or match pledge toward an invoice that has already met 100% of its target funding amount.
- **Recovery Action**: Read `invoice.funded` and `totalOwed` before payment; clamp proposed payments to `totalOwed - funded`.

### `DELEGATE_LIMIT_REACHED`
- **Class**: `DelegateLimitReachedError`
- **Cause**: The maximum number of delegates (default: 3) for the invoice has already been reached.
- **Recovery Action**: Remove an existing delegate with `client.removeDelegate()` before adding another.

---

## 4. Payment & Settlement Errors

### `INSUFFICIENT_BALANCE` / `PAYMENT_EXCEEDS_REMAINING`
- **Classes**: `InsufficientBalanceError`, `PaymentExceedsRemainingError`
- **Cause**: Proposed payment amount is greater than the remaining unfunded balance (`totalOwed - funded`).
- **Recovery Action**: Compute the remaining balance and adjust the payment amount input.
- **Example**:
```typescript
const total = invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);
const remaining = total - invoice.funded;

if (proposedAmount > remaining) {
  console.log(`Clamping payment from ${proposedAmount} to ${remaining}`);
  proposedAmount = remaining;
}
```

### `PAYMENT_COOLDOWN_ACTIVE`
- **Class**: `PaymentCooldownActiveError`
- **Retryable**: Yes
- **Cause**: Payer has made a payment recently and is subject to a rate-limiting cooldown window configured by the creator.
- **Recovery Action**: Inspect `err.retryAfter` (a `Date` instance) and schedule automatic retry after the cooldown expires.
- **Example**:
```typescript
try {
  await client.payments.pay({ invoiceId, amount, payer });
} catch (err) {
  if (err instanceof PaymentCooldownActiveError) {
    const delayMs = err.retryAfter.getTime() - Date.now();
    console.log(`Cooldown active. Retrying in ${delayMs}ms at ${err.retryAfter}`);
    setTimeout(() => client.payments.pay({ invoiceId, amount, payer }), Math.max(0, delayMs));
  }
}
```

### `CONTRIBUTION_CAP_EXCEEDED`
- **Class**: `ContributionCapExceededError`
- **Cause**: Payer's cumulative contribution exceeds the configured per-payer maximum cap.
- **Recovery Action**: Inform the user of their cap limit (`err.cap`) and reduce the payment amount to fit within remaining allowance.

### `DUPLICATE_PAYMENT`
- **Class**: `DuplicatePaymentError`
- **Cause**: Idempotency token or identical payment signature was detected in-flight or already settled.
- **Recovery Action**: Retrieve the existing payment receipt using `client.payments.getReceipt(invoiceId, payer)` instead of resubmitting.

---

## 5. Network, RPC & Submission Errors

### `RPC_ERROR` / `RPC_UNAVAILABLE`
- **Classes**: `RpcError`, `RpcUnavailableError`, `RpcConnectionError`
- **Retryable**: Yes (for HTTP 429 and 503 status codes)
- **Cause**: Soroban RPC node is overloaded, unreachable, or returned a transient error.
- **Recovery Action**: The SDK's resilient RPC engine retries automatically using exponential backoff with jitter. Configure backup RPC endpoints via `rpcEndpoints` to enable transparent failover.

### `CIRCUIT_OPEN`
- **Class**: `CircuitOpenError`
- **Retryable**: Yes
- **Cause**: The circuit breaker tripped open after exceeding the failure threshold (e.g., 5 consecutive RPC failures).
- **Recovery Action**: Pause automated requests until the reset timeout elapses (probing / half-open state), or call `client.resetCircuitBreaker()` if the underlying network issue has been resolved.

### `SIMULATION_FAILED`
- **Class**: `SimulationFailedError`
- **Cause**: Soroban simulated transaction execution reverted (contract panic).
- **Recovery Action**: Inspect the simulation logs and error string in `err.message` or `err.raw`; verify authorizations, signatures, and contract parameters before attempting on-chain submission.

---

## 6. Authorization & Access Control Errors

### `UNAUTHORIZED`
- **Class**: `UnauthorizedError`
- **Cause**: Caller address is not the creator, admin, or authorized party for this operation.
- **Recovery Action**: Ensure the connected signer or wallet keypair matches the expected role on-chain.

### `WALLET_NOT_CONNECTED`
- **Class**: `WalletNotConnectedError`
- **Cause**: An operation requiring transaction signing was invoked without an active wallet connection.
- **Recovery Action**: Call `await client.connectWallet(adapter)` before triggering payment or administrative flows.

### `NFT_GATE_REQUIRED` / `TOKEN_GATE_ACCESS_DENIED`
- **Classes**: `NftGateRequiredError`, `TokenGateAccessDeniedError`
- **Cause**: The creator or invoice requires callers to hold a qualifying NFT or asset balance.
- **Recovery Action**: Query gating status via `client.checkNftGate(address)`; verify user's wallet holds the required token balance.

### `CONTRACT_FROZEN`
- **Class**: `ContractFrozenError`
- **Cause**: The entire StellarSplit smart contract has been administratively paused or frozen.
- **Recovery Action**: Await administrative unfreeze notice before issuing new operations.

---

## 7. Dispute & Governance Errors

### `DISPUTE_EVIDENCE_ERROR`
- **Class**: `DisputeEvidenceError`
- **Cause**: The evidence hash or URI provided is invalid, empty, or submitted outside the active dispute window.
- **Recovery Action**: Ensure evidence URI points to a valid decentralized resource (e.g. IPFS CID) and invoice status is currently disputed.

### `CO_CREATOR_APPROVAL_NOT_REQUIRED`
- **Class**: `CoCreatorApprovalNotRequiredError`
- **Cause**: Attempted to submit co-creator approval on an invoice that was created without co-creators.
- **Recovery Action**: Check `invoice.coCreators` before displaying approval options in the interface.

---

## 8. Milestones, Rounds & Referrals Errors

### `ROUND_NOT_ENDED`
- **Class**: `RoundNotEndedError`
- **Cause**: `closeRound` was called before the round timestamp has passed.
- **Recovery Action**: Inspect `err.roundEnd`; display a countdown timer and only enable round closure once current time > `roundEnd`.
- **Example**:
```typescript
try {
  await client.milestones.closeRound("inv-100");
} catch (err) {
  if (err instanceof RoundNotEndedError) {
    const remainingSeconds = err.roundEnd - Math.floor(Date.now() / 1000);
    console.log(`Round is still active. Please wait ${remainingSeconds}s.`);
  }
}
```

### `WRONG_MILESTONE`
- **Class**: `WrongMilestoneError`
- **Cause**: `completeMilestone` was called for an inactive milestone index.
- **Recovery Action**: Query `client.milestones.getActive(invoiceId)` and complete milestones sequentially.

### `NOTHING_TO_CLAIM`
- **Class**: `NothingToClaimError`
- **Cause**: User called `claimReferralRewards()`, but their referral balance is 0.
- **Recovery Action**: Query `client.getReferralBalance(address)` prior to calling claim.

---

## 9. Validation & Batch Errors

### `BATCH_TOO_LARGE`
- **Class**: `BatchTooLargeError`
- **Cause**: Submitted batch of payments exceeds maximum batch limit (default: 20).
- **Recovery Action**: Chunk array of payments into slices of `maxSize` using `chunk()` utility before submission.

### `VALIDATION_ERROR`
- **Class**: `ValidationError`
- **Cause**: Provided arguments failed client-side validation (e.g., negative stroop amounts, invalid address checksums, malformed metadata).
- **Recovery Action**: Correct input arguments based on `err.context`.

---

## 10. Recommended Error Handling Patterns

```typescript
import {
  StellarSplitClient,
  StellarSplitError,
  isRetryable,
  InvoiceNotFoundError,
  PaymentCooldownActiveError,
} from "@stellar-split/sdk";

async function executePaymentWithRecovery(client: StellarSplitClient, invoiceId: string, amount: bigint, payer: string) {
  try {
    const tx = await client.payments.pay({ invoiceId, amount, payer });
    console.log(`Payment successful: ${tx.txHash}`);
    return tx;
  } catch (err: unknown) {
    // 1. Check for transient/retryable conditions
    if (isRetryable(err)) {
      if (err instanceof PaymentCooldownActiveError) {
        console.warn(`Cooldown active until ${err.retryAfter}. Retrying later.`);
        return;
      }
      console.warn("Transient RPC failure encountered. Retrying...");
      // Backoff and retry
    }

    // 2. Specific domain errors
    if (err instanceof InvoiceNotFoundError) {
      console.error(`Invoice ${err.invoiceId} was not found on-chain.`);
      return;
    }

    // 3. Catch-all for typed StellarSplit errors
    if (err instanceof StellarSplitError) {
      console.error(`SDK Error [${err.code}]: ${err.message}`, err.context);
      if (err.raw) {
        console.error("Soroban contract panic:", err.raw);
      }
      return;
    }

    // 4. Unexpected generic errors
    console.error("Unexpected error:", err);
  }
}
```
