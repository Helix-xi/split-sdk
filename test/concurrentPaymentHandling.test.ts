import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../src/client.js";
import { NonceDeduplicator } from "../src/cache.js";
import { IdempotencyManager } from "../src/idempotency.js";
import { OptimisticCache } from "../src/cache/OptimisticCache.js";
import { InvoiceBatchProcessor } from "../src/invoiceBatchProcessor.js";
import type { Invoice } from "../src/types.js";

const validContractId = StrKey.encodeContract(Keypair.random().rawPublicKey());
const validNetworkPassphrase = "Test SDF Network ; September 2015";
const randomAddress = () => Keypair.random().publicKey();

function createMockClient(): StellarSplitClient {
  return new StellarSplitClient({
    rpcUrl: "http://localhost:8000",
    networkPassphrase: validNetworkPassphrase,
    contractId: validContractId,
  });
}

describe("Concurrent Payment Handling (#1040)", () => {
  let client: StellarSplitClient;

  beforeEach(() => {
    client = createMockClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Multiple Pays Tests
  // =========================================================================
  describe("Multiple Pays", () => {
    it("handles multiple concurrent pay operations across distinct invoices", async () => {
      vi.spyOn(client as any, "_submitTx").mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return {
          txHash: `tx-hash-${Math.random().toString(36).slice(2)}`,
          returnValue: { value: () => 100n },
        };
      });

      // Submit 5 concurrent payments with valid Stellar addresses
      const payments = [
        client.pay({ invoiceId: "1", amount: 100n, payer: randomAddress() }),
        client.pay({ invoiceId: "2", amount: 200n, payer: randomAddress() }),
        client.pay({ invoiceId: "3", amount: 300n, payer: randomAddress() }),
        client.pay({ invoiceId: "4", amount: 400n, payer: randomAddress() }),
        client.pay({ invoiceId: "5", amount: 500n, payer: randomAddress() }),
      ];

      const results = await Promise.all(payments);

      expect(results).toHaveLength(5);
      results.forEach((res) => {
        expect(res.txHash).toMatch(/^tx-hash-/);
      });
    });

    it("executes concurrent batch invoice payments respecting maxConcurrent limits", async () => {
      let activeSubmissions = 0;
      let maxActiveSubmissions = 0;
      const completedInvoices: string[] = [];

      const mockSubmitter = {
        submitPayment: vi.fn().mockImplementation(async ({ invoiceId }: { invoiceId: string }) => {
          activeSubmissions++;
          maxActiveSubmissions = Math.max(maxActiveSubmissions, activeSubmissions);
          await new Promise((resolve) => setTimeout(resolve, 20));
          completedInvoices.push(invoiceId);
          activeSubmissions--;
          return { txHash: `tx-${invoiceId}` };
        }),
      };

      const processor = new InvoiceBatchProcessor(mockSubmitter);
      const invoiceIds = ["inv-1", "inv-2", "inv-3", "inv-4", "inv-5", "inv-6"];
      const amounts = invoiceIds.reduce<Record<string, bigint>>((acc, id) => {
        acc[id] = 100n;
        return acc;
      }, {});

      const results: any[] = [];
      for await (const res of processor.process(invoiceIds, {
        payer: randomAddress(),
        amounts,
        maxConcurrent: 2,
      })) {
        results.push(res);
      }

      expect(results).toHaveLength(6);
      expect(results.every((r) => r.status === "success")).toBe(true);
      expect(maxActiveSubmissions).toBeLessThanOrEqual(2);
      expect(completedInvoices).toHaveLength(6);
    });

    it("allows independent callers to pay the same invoice concurrently (partial split)", async () => {
      vi.spyOn(client as any, "_submitTx").mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 15));
        return {
          txHash: `tx-split-${Math.random().toString(36).slice(2)}`,
          returnValue: { value: () => 100n },
        };
      });

      // 3 distinct payers contributing to split invoice "100"
      const p1 = client.pay({ invoiceId: "100", amount: 50n, payer: randomAddress() });
      const p2 = client.pay({ invoiceId: "100", amount: 30n, payer: randomAddress() });
      const p3 = client.pay({ invoiceId: "100", amount: 20n, payer: randomAddress() });

      const results = await Promise.all([p1, p2, p3]);
      expect(results).toHaveLength(3);
      results.forEach((r) => expect(r.txHash).toBeDefined());
    });
  });

  // =========================================================================
  // 2. Nonce Handling Tests
  // =========================================================================
  describe("Nonce Handling", () => {
    it("accepts unique nonces for concurrent payment requests", () => {
      const dedup = new NonceDeduplicator({ enabled: true, ttlMs: 60_000, maxEntries: 100 });
      const nonces = Array.from({ length: 10 }, (_, i) => `nonce-${Date.now()}-${i}`);

      const outcomes = nonces.map((nonce) => dedup.check(nonce));
      expect(outcomes.every((outcome) => outcome === "accepted")).toBe(true);
      expect(dedup.size).toBe(10);
    });

    it("rejects duplicate nonces during concurrent payment replay", () => {
      const dedup = new NonceDeduplicator({ enabled: true, ttlMs: 60_000, maxEntries: 100 });
      const nonce = "replay-nonce-xyz";

      const first = dedup.check(nonce);
      expect(first).toBe("accepted");

      // Repeated submissions with the same nonce must be detected as duplicate
      const duplicate1 = dedup.check(nonce);
      const duplicate2 = dedup.check(nonce);

      expect(duplicate1).toBe("duplicate");
      expect(duplicate2).toBe("duplicate");
      expect(dedup.isDuplicate(nonce)).toBe(true);
    });

    it("enforces idempotency key claims so identical concurrent calls share the same txHash", () => {
      const idemp = new IdempotencyManager({ ttlMs: 60_000 });
      const key = idemp.generateKey(randomAddress(), "operation-xdr-payload");

      const claim1 = idemp.tryClaim(key, { txHash: "tx-settled-first" });
      expect(claim1.duplicate).toBe(false);

      const claim2 = idemp.tryClaim(key, { txHash: "tx-settled-second" });
      expect(claim2.duplicate).toBe(true);
      expect(claim2.existing?.txHash).toBe("tx-settled-first");

      // Re-fetching result returns original transaction
      const cached = idemp.getResult(key);
      expect(cached?.txHash).toBe("tx-settled-first");
    });
  });

  // =========================================================================
  // 3. State Consistency Tests
  // =========================================================================
  describe("State Consistency", () => {
    it("maintains consistent optimistic cache state across concurrent mutations", () => {
      const initialInvoice: Invoice = {
        id: "1",
        status: "pending",
        totalAmount: 1000n,
        paidAmount: 0n,
        token: "USDC",
        creator: randomAddress(),
        recipient: randomAddress(),
        recipients: [],
        createdAt: Date.now(),
      };

      const cache = new OptimisticCache<Invoice>();

      // Apply first optimistic payment of 200n
      const mutation1 = cache.applyOptimistic(
        "1",
        { ...initialInvoice, paidAmount: 200n },
        initialInvoice
      );
      expect(cache.get("1")?.paidAmount).toBe(200n);

      // Apply second concurrent optimistic payment of another 300n (total 500n)
      const invoiceAt200 = { ...initialInvoice, paidAmount: 200n };
      const mutation2 = cache.applyOptimistic(
        "1",
        { ...initialInvoice, paidAmount: 500n },
        invoiceAt200
      );
      expect(cache.get("1")?.paidAmount).toBe(500n);

      // Roll back mutation 2, reverts to baseline before mutation 2 (200n)
      mutation2.rollback();
      expect(cache.get("1")?.paidAmount).toBe(200n);

      // Commit mutation 1, permanently commits 200n
      mutation1.commit();
      expect(cache.get("1")?.paidAmount).toBe(200n);
    });

    it("guarantees consistent state when concurrent payments succeed and fail mixed together", async () => {
      let callCount = 0;
      vi.spyOn(client as any, "_submitTx").mockImplementation(async () => {
        callCount++;
        if (callCount % 2 === 0) {
          throw new Error("Simulated failure: insufficient allowance");
        }
        return {
          txHash: `tx-consistent-${callCount}`,
          returnValue: { value: () => 100n },
        };
      });

      const promises = [
        client.pay({ invoiceId: "1", amount: 100n, payer: randomAddress() }),
        client.pay({ invoiceId: "2", amount: 100n, payer: randomAddress() }),
        client.pay({ invoiceId: "3", amount: 100n, payer: randomAddress() }),
        client.pay({ invoiceId: "4", amount: 100n, payer: randomAddress() }),
      ];

      const settled = await Promise.allSettled(promises);

      const fulfilled = settled.filter((s) => s.status === "fulfilled");
      const rejected = settled.filter((s) => s.status === "rejected");

      expect(fulfilled).toHaveLength(2);
      expect(rejected).toHaveLength(2);
      expect(callCount).toBe(4);
    });
  });

  // =========================================================================
  // 4. Race Conditions Tests
  // =========================================================================
  describe("Race Conditions", () => {
    it("serializes concurrent transactions via the priority queue without race corruption", async () => {
      const executionOrder: number[] = [];

      vi.spyOn(client as any, "_doSubmitTx").mockImplementation(async () => {
        const id = executionOrder.length + 1;
        executionOrder.push(id);
        await new Promise((r) => setTimeout(r, 10));
        return {
          txHash: `tx-queued-${id}`,
          returnValue: { value: () => id },
        };
      });

      // Launch 5 concurrent payments simultaneously
      const submissions = [
        client.pay({ invoiceId: "1", amount: 10n, payer: randomAddress() }),
        client.pay({ invoiceId: "2", amount: 20n, payer: randomAddress() }),
        client.pay({ invoiceId: "3", amount: 30n, payer: randomAddress() }),
        client.pay({ invoiceId: "4", amount: 40n, payer: randomAddress() }),
        client.pay({ invoiceId: "5", amount: 50n, payer: randomAddress() }),
      ];

      const results = await Promise.all(submissions);
      expect(results).toHaveLength(5);
      // All 5 executed in sequential order through queue
      expect(executionOrder).toEqual([1, 2, 3, 4, 5]);
    });

    it("survives a high-concurrency burst of 20 concurrent payment attempts without race errors", async () => {
      let completed = 0;
      vi.spyOn(client as any, "_submitTx").mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 5));
        completed++;
        return {
          txHash: `burst-tx-${completed}`,
          returnValue: { value: () => completed },
        };
      });

      const burst = Array.from({ length: 20 }, (_, i) =>
        client.pay({ invoiceId: `${i + 1}`, amount: BigInt(i + 1), payer: randomAddress() })
      );

      const results = await Promise.all(burst);
      expect(results).toHaveLength(20);
      expect(completed).toBe(20);
      const uniqueHashes = new Set(results.map((r) => r.txHash));
      expect(uniqueHashes.size).toBe(20);
    });
  });
});
