import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StellarSplitClient } from "../src/client.js";
import { OfflineQueue } from "../src/offlineQueue.js";
import * as health from "../src/health.js";
import { resolveConflict } from "../src/conflictResolver.js";
import type { Invoice } from "../src/types.js";

import { Keypair, StrKey } from "@stellar/stellar-sdk";

const validContractId = StrKey.encodeContract(Keypair.random().rawPublicKey());
const validNetworkPassphrase = "Test SDF Network ; September 2015";

describe("OfflineQueue and Synchronization (#1041)", () => {
  let client: StellarSplitClient;
  let healthSpy: any;

  beforeEach(() => {
    // Setup in-memory mock localStorage
    const store: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (key: string) => store[key] || null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
    };

    client = new StellarSplitClient({
      rpcUrl: "http://localhost:8000",
      networkPassphrase: validNetworkPassphrase,
      contractId: validContractId,
      offlineQueue: {
        enabled: true,
        maxQueueSize: 3,
        persistToStorage: true,
      },
    });

    healthSpy = vi.spyOn(health, "checkRPCHealth").mockResolvedValue({
      status: "down",
      latencyMs: 0,
      blockHeight: 0,
      timestamp: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Queue Storage Tests
  // =========================================================================
  describe("Queue Storage", () => {
    it("fills on RPC failure and returns queued result", async () => {
      const result = await client.pay({ invoiceId: "1", amount: 100n, payer: "A" });
      expect(result).toEqual({ txHash: "queued" });

      const q = client.getOfflineQueue();
      expect(q).toHaveLength(1);
      expect(q[0].method).toBe("pay");
      expect(q[0].args[0].invoiceId).toBe("1");
      expect(q[0].args[0].amount).toBe(100n);
    });

    it("enforces maxQueueSize with FIFO eviction when full", async () => {
      await client.pay({ invoiceId: "1", amount: 100n, payer: "A" });
      await client.pay({ invoiceId: "2", amount: 200n, payer: "B" });
      await client.pay({ invoiceId: "3", amount: 300n, payer: "C" });
      await client.pay({ invoiceId: "4", amount: 400n, payer: "D" });

      const q = client.getOfflineQueue();
      expect(q).toHaveLength(3);
      expect(q.map((op) => op.args[0].invoiceId)).toEqual(["2", "3", "4"]);
    });

    it("persists queue to localStorage including BigInt fields", async () => {
      await client.pay({ invoiceId: "101", amount: 5000000000n, payer: "A" });

      // Create new client instance loading from same storage
      const client2 = new StellarSplitClient({
        rpcUrl: "http://localhost:8000",
        networkPassphrase: validNetworkPassphrase,
        contractId: validContractId,
        offlineQueue: {
          enabled: true,
          maxQueueSize: 5,
          persistToStorage: true,
        },
      });

      const q = client2.getOfflineQueue();
      expect(q).toHaveLength(1);
      expect(q[0].args[0].invoiceId).toBe("101");
      expect(q[0].args[0].amount).toBe(5000000000n);
    });

    it("clearing the queue wipes in-memory and persistent storage", async () => {
      await client.pay({ invoiceId: "1", amount: 100n, payer: "A" });
      expect(client.getOfflineQueue()).toHaveLength(1);

      client.clearOfflineQueue();
      expect(client.getOfflineQueue()).toHaveLength(0);

      // Re-hydrating another client sees empty queue
      const client2 = new StellarSplitClient({
        rpcUrl: "http://localhost:8000",
        networkPassphrase: validNetworkPassphrase,
        contractId: validContractId,
        offlineQueue: {
          enabled: true,
          maxQueueSize: 5,
          persistToStorage: true,
        },
      });
      expect(client2.getOfflineQueue()).toHaveLength(0);
    });

    it("gracefully tolerates corrupted storage data without throwing", () => {
      (globalThis as any).localStorage.setItem("stellar_split_offline_queue", "invalid-json-content{");
      const offlineQueue = new OfflineQueue(client, {
        enabled: true,
        maxQueueSize: 5,
        persistToStorage: true,
      });

      expect(offlineQueue.getQueue()).toEqual([]);
    });
  });

  // =========================================================================
  // 2. Sync Process Tests
  // =========================================================================
  describe("Sync Process", () => {
    it("drains and executes queued operations when network recovers", async () => {
      await client.pay({ invoiceId: "1", amount: 100n, payer: "A" });
      await client.pay({ invoiceId: "2", amount: 200n, payer: "B" });

      // Health recovers
      healthSpy.mockResolvedValue({ status: "ok", latencyMs: 10, blockHeight: 1, timestamp: 1 });
      const paySpy = vi.spyOn(client, "pay").mockResolvedValue({ txHash: "tx-success" });

      const drainedPromise = client.once("queue:drained");
      await client.checkRPCHealth();
      await drainedPromise;

      expect(client.getOfflineQueue()).toHaveLength(0);
      expect(paySpy).toHaveBeenCalledTimes(2);
      expect(paySpy).toHaveBeenNthCalledWith(1, { invoiceId: "1", amount: 100n, payer: "A" });
      expect(paySpy).toHaveBeenNthCalledWith(2, { invoiceId: "2", amount: 200n, payer: "B" });
    });

    it("emits queue:operation:failed on error and continues remaining sync operations", async () => {
      await client.pay({ invoiceId: "fail-1", amount: 100n, payer: "A" });
      await client.pay({ invoiceId: "pass-2", amount: 200n, payer: "B" });

      healthSpy.mockResolvedValue({ status: "ok", latencyMs: 10, blockHeight: 1, timestamp: 1 });
      const failedOps: any[] = [];
      client.on("queue:operation:failed", (evt) => failedOps.push(evt));

      vi.spyOn(client, "pay").mockImplementation(async (params: any) => {
        if (params.invoiceId === "fail-1") {
          throw new Error("Simulation failure: balance too low");
        }
        return { txHash: "tx-pass" };
      });

      const syncResult = await client.syncOfflineQueue();
      expect(syncResult).not.toBeNull();
      expect(syncResult?.synced).toBe(1);
      expect(syncResult?.failed).toBe(1);
      expect(failedOps).toHaveLength(1);
      expect(failedOps[0].operation.args[0].invoiceId).toBe("fail-1");
      expect(failedOps[0].error.message).toContain("Simulation failure");
    });

    it("prevents re-entrant sync calls when a sync is already in flight", async () => {
      await client.pay({ invoiceId: "1", amount: 100n, payer: "A" });

      let syncResolve: any;
      const syncBlocker = new Promise((resolve) => {
        syncResolve = resolve;
      });

      vi.spyOn(client, "pay").mockImplementation(async () => {
        await syncBlocker;
        return { txHash: "tx-done" };
      });

      const queueInstance = (client as any)._offlineQueue;
      const firstSync = queueInstance.sync();
      const concurrentSync = queueInstance.sync();

      // Concurrent call returns early without duplicating operations
      const concurrentResult = await concurrentSync;
      expect(concurrentResult.operations).toHaveLength(0);

      syncResolve();
      const firstResult = await firstSync;
      expect(firstResult.synced).toBe(1);
    });
  });

  // =========================================================================
  // 3. Conflict Resolution Tests
  // =========================================================================
  describe("Conflict Resolution", () => {
    it("resolves conflicting invoice states using resolveConflict helper", () => {
      const localInvoice = {
        id: "inv-1",
        status: "pending",
        totalAmount: 1000n,
        paidAmount: 500n,
        lastModifiedLedger: 100,
      } as unknown as Invoice;

      const remoteInvoice = {
        id: "inv-1",
        status: "paid",
        totalAmount: 1000n,
        paidAmount: 1000n,
        lastModifiedLedger: 110,
      } as unknown as Invoice;

      // remote-wins
      const resolvedRemote = resolveConflict(localInvoice, remoteInvoice, "remote-wins");
      expect(resolvedRemote.status).toBe("paid");
      expect(resolvedRemote.paidAmount).toBe(1000n);

      // local-wins
      const resolvedLocal = resolveConflict(localInvoice, remoteInvoice, "local-wins");
      expect(resolvedLocal.status).toBe("pending");
      expect(resolvedLocal.paidAmount).toBe(500n);

      // latest-ledger: remote has higher ledger
      const resolvedLedger = resolveConflict(localInvoice, remoteInvoice, "latest-ledger");
      expect(resolvedLedger.lastModifiedLedger).toBe(110);
      expect(resolvedLedger.status).toBe("paid");
    });

    it("detects conflict on sync when remote invoice is already paid and skips obsolete mutation with remote-wins", async () => {
      await client.pay({ invoiceId: "inv-conflict", amount: 500n, payer: "A" });

      // Stub getInvoice to return an invoice that settled remotely while offline
      vi.spyOn(client, "getInvoice").mockResolvedValue({
        id: "inv-conflict",
        status: "paid",
        totalAmount: 500n,
        paidAmount: 500n,
        token: "USDC",
        creator: "GC",
        recipient: "GR",
        recipients: [],
        createdAt: 0,
      } as Invoice);

      const paySpy = vi.spyOn(client, "pay").mockResolvedValue({ txHash: "should-not-be-called" });
      const conflictEvents: any[] = [];
      client.on("queue:conflict:resolved", (evt) => conflictEvents.push(evt));

      const result = await client.syncOfflineQueue("remote-wins");
      expect(result?.conflicts).toBe(1);
      expect(result?.synced).toBe(0);
      expect(paySpy).not.toHaveBeenCalled();
      expect(conflictEvents).toHaveLength(1);
      expect(conflictEvents[0].operation.args[0].invoiceId).toBe("inv-conflict");
      expect(conflictEvents[0].remoteState.status).toBe("paid");
    });
  });

  // =========================================================================
  // 4. State Recovery Tests
  // =========================================================================
  describe("State Recovery", () => {
    it("recovers state from storage using recoverState() after simulated crash", async () => {
      await client.pay({ invoiceId: "crash-test", amount: 999n, payer: "GCRASH" });

      const offlineQueue = (client as any)._offlineQueue;
      // Clear in-memory queue to simulate memory loss
      (offlineQueue as any).queue = [];
      expect(offlineQueue.getQueue()).toHaveLength(0);

      // Recover state from persistent storage
      const recovered = offlineQueue.recoverState();
      expect(recovered).toHaveLength(1);
      expect(recovered[0].args[0].invoiceId).toBe("crash-test");
      expect(recovered[0].args[0].amount).toBe(999n);
    });

    it("handles multiple offline/online cycles recovering and syncing correctly", async () => {
      // Cycle 1: Offline
      await client.pay({ invoiceId: "cycle-1", amount: 10n, payer: "A" });
      expect(client.getOfflineQueue()).toHaveLength(1);

      // Cycle 1: Come online and sync
      healthSpy.mockResolvedValue({ status: "ok", latencyMs: 5, blockHeight: 1, timestamp: 1 });
      const paySpy1 = vi.spyOn(client, "pay").mockResolvedValue({ txHash: "tx-cycle-1" });
      await client.syncOfflineQueue();
      expect(client.getOfflineQueue()).toHaveLength(0);
      paySpy1.mockRestore();

      // Cycle 2: Goes offline again
      healthSpy.mockResolvedValue({ status: "down", latencyMs: 0, blockHeight: 0, timestamp: 2 });
      await client.pay({ invoiceId: "cycle-2", amount: 20n, payer: "B" });
      expect(client.getOfflineQueue()).toHaveLength(1);

      // Cycle 2: Recovery and sync
      healthSpy.mockResolvedValue({ status: "ok", latencyMs: 5, blockHeight: 2, timestamp: 3 });
      const paySpy2 = vi.spyOn(client, "pay").mockResolvedValue({ txHash: "tx-cycle-2" });
      await client.syncOfflineQueue();
      expect(client.getOfflineQueue()).toHaveLength(0);
      paySpy2.mockRestore();
    });
  });
});
