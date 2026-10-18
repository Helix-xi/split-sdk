# Error Codes and Recovery Strategies

Reference for the SDK's machine-readable error codes (`SdkErrorCode`,
issue #1067), their recovery strategies (issue #1068), and the Soroban
contract-address validation rules (issue #1065).

Related APIs:

- `describeSdkErrorCode(code)` — human-readable description of a code
- `isRetryableErrorCode(code)` — whether the failure is safe to retry unchanged
- `getSuggestion(error)` — remediation suggestion for UI/logs
- `getRecoveryPlan(error)` — recovery strategy + suggestion
- `executeWithRecovery(op)` — apply the mapped strategy automatically
- `validateContractAddress(address)` / `assertValidContractAddress(address)`

## Error code categories

`SdkErrorCode` is an exhaustive enum: every SDK failure mode maps to exactly
one code, and every code must have a description
(`SDK_ERROR_CODE_DESCRIPTIONS`), a suggestion (`getSuggestion`), and a
recovery strategy (`RECOVERY_STRATEGY_TABLE`). Adding a code without all
three is a compile error.

### Invoice / resource lifecycle

| Code | Description |
| ---- | ----------- |
| `INVOICE_NOT_FOUND` | The requested invoice does not exist on-chain. |
| `INVOICE_NOT_PENDING` | The invoice is not in the Pending state required by this operation. |
| `DEADLINE_EXPIRED` | The invoice's payment deadline has passed. |
| `INVOICE_FROZEN` | The invoice is frozen due to an active dispute or lock. |

### Accounts & funds

| Code | Description |
| ---- | ----------- |
| `ACCOUNT_NOT_FOUND` | The referenced Stellar account does not exist on the network. |
| `INSUFFICIENT_FUNDS` | The account balance is too low to cover the operation. |

### Input validation

| Code | Description |
| ---- | ----------- |
| `INVALID_INPUT` | A generic input failed validation. |
| `INVALID_ADDRESS` | A Stellar account address is malformed. |
| `INVALID_CONTRACT_ADDRESS` | A Soroban contract address is malformed or fails its CRC16 checksum. |
| `INVALID_AMOUNT` | A payment amount is malformed or out of range. |
| `INVALID_RECIPIENT` | One or more recipient addresses are invalid. |
| `INVALID_CONFIG` | The SDK configuration is invalid. |

### Network / transport

| Code | Description |
| ---- | ----------- |
| `NETWORK_ERROR` | A network-level failure occurred (DNS, TLS, connection reset). |
| `NETWORK_TIMEOUT` | A network request timed out. |
| `RPC_FAILED` | The RPC node rejected or failed to process the request. |
| `HORIZON_ERROR` | Horizon returned an error response. |
| `SERVICE_UNAVAILABLE` | The network endpoint is temporarily unavailable. |
| `RATE_LIMITED` | The endpoint is rate limiting requests. |

### Transaction lifecycle

| Code | Description |
| ---- | ----------- |
| `TRANSACTION_FAILED` | The transaction was rejected or failed on-chain. |
| `TRANSACTION_EXPIRED` | The transaction's time bounds elapsed before inclusion in a ledger. |
| `SEQUENCE_MISMATCH` | The transaction's sequence number does not match the account state. |
| `INSUFFICIENT_FEE` | The provided fee is below the network minimum or resource-fee quote. |
| `SUBMISSION_FAILED` | Submitting the transaction to the network failed. |
| `CONFIRMATION_TIMEOUT` | The transaction was submitted but was not confirmed in time. |
| `VERIFICATION_FAILED` | Pre-submit transaction verification found one or more failed checks. |
| `MISSING_SIGNATURE` | A required signature is missing from the transaction. |
| `INVALID_SIGNATURE` | A signature on the transaction failed cryptographic verification. |

### Soroban contract execution

| Code | Description |
| ---- | ----------- |
| `CONTRACT_NOT_FOUND` | The referenced contract does not exist on the network. |
| `CONTRACT_REJECTED` | The contract rejected the transaction (panic or error result). |
| `SIMULATION_FAILED` | Simulating the contract invocation failed. |
| `OUT_OF_RESOURCE` | The invocation exceeded the Soroban CPU or memory budget. |

### Authorization

| Code | Description |
| ---- | ----------- |
| `UNAUTHORIZED` | The caller is not authorized to perform the operation. |
| `WALLET_NOT_CONNECTED` | No wallet is connected (or the connection was lost). |
| `AUTHENTICATION_FAILED` | Wallet / signer authentication failed. |

### Operational / state

| Code | Description |
| ---- | ----------- |
| `STATE_CONFLICT` | Concurrent modification produced a state conflict. |
| `CIRCUIT_OPEN` | The circuit breaker is open and calls are being short-circuited. |
| `OPERATION_ABORTED` | The operation was aborted before completion. |
| `BATCH_TOO_LARGE` | A batch exceeds the maximum permitted size. |
| `INTERNAL_ERROR` | An unexpected internal SDK error occurred. |

## Retryability

`RETRYABLE_ERROR_CODES` is deliberately conservative — only transient
network-level failures are safe to retry **unchanged**:

`NETWORK_ERROR`, `NETWORK_TIMEOUT`, `RPC_FAILED`, `HORIZON_ERROR`,
`SERVICE_UNAVAILABLE`, `RATE_LIMITED`, `CONFIRMATION_TIMEOUT`.

Transaction-state errors such as `SEQUENCE_MISMATCH` or `TRANSACTION_FAILED`
are **not** retryable: a blind retry can double-submit. They require
re-fetching state and rebuilding the transaction
(`action: "refresh_and_retry"`).

## Recovery strategies

Every code maps to a strategy in `RECOVERY_STRATEGY_TABLE`:

| Action | Meaning |
| ------ | ------- |
| `retry` | Re-issue the same request immediately. |
| `retry_with_backoff` | Re-issue after exponential backoff (`backoffMs * 2^(n-1)`). |
| `refresh_and_retry` | Re-fetch on-chain/network state, rebuild, then retry. |
| `correct_input` | Fix the caller's input; retrying unchanged will fail again. |
| `use_fallback` | Switch to a fallback RPC/Horizon endpoint. |
| `wait_for_resolution` | External state (dispute, freeze, cooldown) must change first. |
| `abort` | Terminal failure — do not retry. |

Retryable strategies carry `maxAttempts` and `backoffMs`, which
`executeWithRecovery` applies automatically:

```ts
import { executeWithRecovery } from "@stellar-split/sdk";

const invoice = await executeWithRecovery(() => client.getInvoice(id), {
  onRetry: (attempt, strategy) =>
    console.warn(`Retry ${attempt}: ${strategy.description}`),
});
```

Errors without a known code (plain `Error`s) use a conservative generic
strategy: `retry_with_backoff`, 3 attempts, 500 ms base delay.

See `examples/error-recovery-example.ts` for a runnable walkthrough.

## Contract address validation rules (#1065)

A valid Soroban contract address must satisfy all of:

1. **Type** — a non-empty string.
2. **Length** — exactly 56 characters.
3. **Prefix** — starts with `C`.
4. **Alphabet** — uppercase RFC 4648 base32 only (`A`–`Z`, `2`–`7`); the
   encoding is case-sensitive.
5. **Checksum** — the trailing characters encode a CRC16-XModem checksum over
   the version byte plus the 32-byte payload (StrKey / SEP-0023).

Rules 2–4 are reported as the `format` check and rule 5 as the `checksum`
check by `validateContractAddress`, so a mistyped address is distinguishable
from a corrupted one:

```ts
import { validateContractAddress } from "@stellar-split/sdk";

const result = validateContractAddress(candidate);
if (!result.valid) {
  console.error(result.errors); // e.g. ["Contract address failed CRC16 checksum validation"]
}
```

`assertValidContractAddress(candidate)` throws `InvalidContractAddressError`
(code `INVALID_CONTRACT_ADDRESS`) instead of returning a result.

## Transaction verification checks (#1066)

`verifyTransaction(tx, options)` runs:

| Check | Verifies |
| ----- | -------- |
| `structure` | At least one operation; parseable positive integer fee. |
| `fee` | Fee is positive and at or below `maxFee` (when provided). |
| `sequence` | Sequence number equals `expectedSequence` (when provided). |
| `timebounds` | Current time lies within the transaction's time bounds. |
| `signatures` | Every key in `signers` holds a valid ed25519 signature over the tx hash; at least `minSignatures` entries are present. |
| `hash` | Recomputed hash equals `expectedHash` (hex or base64, when provided). |

Options whose properties you cannot vouch for should be omitted — skipped
checks are not passed vacuously. `assertTransactionVerified` throws
`TransactionVerificationError` (code `VERIFICATION_FAILED`) listing the
failed checks.


