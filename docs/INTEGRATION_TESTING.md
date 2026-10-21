# Integration Testing Guide for StellarSplit SDK

This guide details best practices, patterns, and architectural principles for writing integration tests within the StellarSplit SDK.

---

## 1. Overview: Integration vs. Unit Tests

- **Unit Tests**: Focus on isolated business logic, utility algorithms, mathematical calculations (e.g., fee computation, input sanitization), and pure functions without relying on external dependencies or network simulations.
- **Integration Tests**: Verify interactions across multiple SDK subsystems, transaction assembly pipelines, RPC/Horizon client abstractions, caching layers, and wallet adapters.

---

## 2. Directory & File Naming Conventions

All test suites live in the top-level `test/` directory:
- Integration tests: `test/<feature>.test.ts` or `test/<feature>.integration.test.ts`
- File naming follows camelCase or PascalCase matching the underlying module.

---

## 3. Mocking Strategy

### Mocking the Horizon Client & Soroban RPC
Avoid hitting live public RPC endpoints in CI tests. Use `vi.fn()` or simulated response fixtures:

```typescript
import { vi } from 'vitest';

export function createMockRpcClient() {
  return {
    sendTransaction: vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      hash: 'mock-tx-hash-64-bytes-stellar',
      latestLedger: 1234567,
    }),
    getAccount: vi.fn().mockResolvedValue({
      id: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
      sequence: '100',
    }),
  };
}
```

### Mocking Wallet Providers
When verifying transaction signing pipelines:

```typescript
import type { WalletAdapter } from '../src/types.js';

export class MockWalletAdapter implements WalletAdapter {
  readonly name = 'MockWallet';
  connected = true;

  async connect(): Promise<string> {
    return 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
  }

  async signTransaction(xdr: string): Promise<string> {
    return `signed-${xdr}`;
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onAccountChange(_cb: (address: string | null) => void): () => void {
    return () => {};
  }
}
```

---

## 4. End-to-End Payment Flow Test Example

```typescript
import { describe, it, expect } from 'vitest';
import { MockWalletAdapter } from './fixtures/mockWallet.js';

describe('Payment Orchestration Flow', () => {
  it('signs and verifies an invoice payment batch', async () => {
    const wallet = new MockWalletAdapter();
    const address = await wallet.connect();
    expect(address).toMatch(/^G[A-Z2-7]{55}$/);

    const unsignedXdr = 'AAAA...payload';
    const signedXdr = await wallet.signTransaction(unsignedXdr);
    expect(signedXdr).toContain('signed-');
  });
});
```

---

## 5. Running Integration Tests

Run the full suite:
```bash
npm test
```

Target a specific integration test:
```bash
npm test -- test/batchOperations.test.ts
```
