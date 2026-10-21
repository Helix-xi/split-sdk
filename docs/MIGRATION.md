# Migration Guides for StellarSplit SDK

Comprehensive guide for migrating across major versions of the StellarSplit SDK.

---

## Semantic Versioning Principles

StellarSplit follows strict Semantic Versioning (`MAJOR.MINOR.PATCH`):
- **MAJOR**: Incompatible API changes, signature removals, altered default behavior.
- **MINOR**: Backwards-compatible functionality additions, non-breaking features.
- **PATCH**: Backwards-compatible bug fixes, internal performance optimizations.

---

## Migrating from v1.x to v2.x

### 1. Unified Wallet Adapter Interface
In v1.x, each wallet connector used a distinct proprietary contract. In v2.x, all connectors adhere to the common `WalletAdapter` interface.

**v1.x:**
```typescript
import { FreighterConnector } from 'split-sdk';
const wallet = new FreighterConnector();
await wallet.requestAccess();
```

**v2.x:**
```typescript
import { FreighterAdapter } from 'split-sdk';
const wallet = new FreighterAdapter();
const address = await wallet.connect();
```

### 2. BigInt Strictness for Token Amounts
All stroop/amount calculations have moved from `number` to `bigint` to prevent floating-point precision loss.

**v1.x:**
```typescript
client.createInvoice({ amount: 1000000 });
```

**v2.x:**
```typescript
client.createInvoice({ amount: 1000000n });
```

---

## Migration Checklist

1. [ ] Audit existing `process.env` references for new SDK environment config schemas.
2. [ ] Replace deprecated wallet connect methods with the unified `WalletAdapter.connect()`.
3. [ ] Convert numerical Stroop balance inputs to `bigint`.
4. [ ] Run full test suite with `npm test`.
