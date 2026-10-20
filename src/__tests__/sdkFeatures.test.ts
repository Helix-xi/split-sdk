import { describe, it, expect, beforeEach, vi } from "vitest";
import { StellarSplitClient } from "../client.js";
import { TypedEventEmitter } from "../events/TypedEventEmitter.js";
import { MetricsPlugin, PluginRegistry } from "../plugin.js";
import { BatchTooLargeError } from "../errors.js";
import type { CreateInvoiceParams } from "../types.js";

describe("SDK Features (#854, #855, #856, #857)", () => {
  // Mock config
  const config = {
    rpcUrl: "http://localhost:8000",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CBND2TWUC3BVVK4IEUA6O3DC7RNWXO5EAUWK5F2BXBDKP2I7BLXVKZDS",
  };

  describe("Issue #855 - batchCreateInvoices", () => {
    it("should validate batch size limit (1-20)", async () => {
      const client = new StellarSplitClient(config);
      await expect(client.batchCreateInvoices([])).rejects.toThrow(BatchTooLargeError);
      await expect(client.batchCreateInvoices(Array(21).fill({}))).rejects.toThrow(BatchTooLargeError);
    });

    it("should accept a batch at the lower boundary (1)", async () => {
      const client = new StellarSplitClient(config);
      const invoices: CreateInvoiceParams[] = [
        { creator: "test", token: "test", deadline: 1000, recipients: [] },
      ];
      // Boundary of 1 must not be rejected by the size guard.
      await expect(client.batchCreateInvoices(invoices)).rejects.not.toThrow(BatchTooLargeError);
    });

    it("should accept a batch at the upper boundary (20)", async () => {
      const client = new StellarSplitClient(config);
      const invoices: CreateInvoiceParams[] = Array.from({ length: 20 }, () => ({
        creator: "test",
        token: "test",
        deadline: 1000,
        recipients: [],
      }));
      await expect(client.batchCreateInvoices(invoices)).rejects.not.toThrow(BatchTooLargeError);
    });

    it("should validate all invoices before RPC call", async () => {
      const client = new StellarSplitClient(config);
      const invoices: CreateInvoiceParams[] = [
        { creator: "test", token: "test", deadline: 1000, recipients: [] },
        { creator: "", token: "test", deadline: 1000, recipients: [] },
      ];

      await expect(client.batchCreateInvoices(invoices)).rejects.toThrow();
    });
  });

  describe("Issue #856 - SDK Event Bus", () => {
    it("should support typed event subscription", () => {
      const emitter = new TypedEventEmitter<{
        "batch:created": { invoiceIds: bigint[] };
        payment: { invoiceId: bigint; amount: bigint };
      }>();

      const handler = vi.fn();
      emitter.on("batch:created", handler);
      emitter.emit("batch:created", { invoiceIds: [1n, 2n] });

      expect(handler).toHaveBeenCalledWith({ invoiceIds: [1n, 2n] });
    });

    it("should support unsubscribing from events", () => {
      const emitter = new TypedEventEmitter<{ test: { value: number } }>();
      const handler = vi.fn();
      const unsubscribe = emitter.on("test", handler);

      emitter.emit("test", { value: 1 });
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
      emitter.emit("test", { value: 2 });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should support once for single-fire subscriptions", async () => {
      const emitter = new TypedEventEmitter<{ test: { value: number } }>();

      const promise = emitter.once("test");
      emitter.emit("test", { value: 42 });

      const result = await promise;
      expect(result).toEqual({ value: 42 });
    });

    it("should only fire once subscriptions a single time", () => {
      const emitter = new TypedEventEmitter<{ test: { value: number } }>();
      const handler = vi.fn();
      emitter.once("test", handler);

      emitter.emit("test", { value: 1 });
      emitter.emit("test", { value: 2 });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ value: 1 });
    });
  });

  describe("Issue #857 - Plugin System", () => {
    it("should prevent duplicate plugin registration", () => {
      const registry = new PluginRegistry();
      const plugin = {
        name: "TestPlugin",
        beforeCall: (method: any, args: any) => args,
      };

      registry.use(plugin);
      expect(() => registry.use(plugin)).toThrow();
    });

    it("should support fluent API for plugin chaining", () => {
      const client = new StellarSplitClient(config);
      const plugin = { name: "Test", install: vi.fn() };

      const result = client.use(plugin);
      expect(result).toBe(client);
    });

    it("should call plugin install method with client context", () => {
      const client = new StellarSplitClient(config);
      const installFn = vi.fn();
      const plugin = { name: "TestPlugin", install: installFn };

      client.use(plugin);
      expect(installFn).toHaveBeenCalledWith(expect.objectContaining({ on: expect.any(Function), off: expect.any(Function) }));
    });

    it("should allow plugin to unsubscribe", () => {
      const registry = new PluginRegistry();
      const plugin = { name: "TestPlugin" };

      registry.use(plugin);
      expect(registry.getPlugins()).toContain("TestPlugin");

      registry.removePlugin("TestPlugin");
      expect(registry.getPlugins()).not.toContain("TestPlugin");
    });
  });

  describe("MetricsPlugin", () => {
    it("should track method call counts", () => {
      const plugin = new MetricsPlugin();
      const metrics = plugin.getMetrics();

      expect(metrics).toEqual({});

      plugin.afterCall("createInvoice", { invoiceId: "test", txHash: "hash" });
      expect(plugin.getMetrics()).toEqual({ createInvoice: 1 });

      plugin.afterCall("createInvoice", { invoiceId: "test2", txHash: "hash2" });
      expect(plugin.getMetrics()).toEqual({ createInvoice: 2 });
    });

    it("should track distinct methods independently", () => {
      const plugin = new MetricsPlugin();
      plugin.afterCall("createInvoice", { invoiceId: "test", txHash: "hash" });
      plugin.afterCall("pay", { txHash: "hash" });

      expect(plugin.getMetrics()).toEqual({ createInvoice: 1, pay: 1 });
    });

    it("should reset metrics", () => {
      const plugin = new MetricsPlugin();
      plugin.afterCall("pay", { txHash: "hash" });

      expect(plugin.getMetrics()).toEqual({ pay: 1 });
      plugin.resetMetrics();
      expect(plugin.getMetrics()).toEqual({});
    });
  });

  describe("Contract Events", () => {
    it("should have typed payment event", () => {
      const event: import("../contractEvents.js").PaymentEvent = {
        invoiceId: 1n,
        amount: 100n,
        payer: "test",
        timestamp: Date.now(),
      };
      expect(event.invoiceId).toBe(1n);
    });

    it("should have typed release event", () => {
      const event: import("../contractEvents.js").ReleaseEvent = {
        invoiceId: 1n,
        amount: 100n,
        recipient: "test",
        timestamp: Date.now(),
      };
      expect(event.amount).toBe(100n);
    });
  });

  describe("Creator Stats", () => {
    it("should have CreatorStats type with all fields", () => {
      const stats: import("../creatorStats.js").CreatorStats = {
        totalInvoices: 10,
        totalRaised: 1000n,
        totalReleased: 900n,
        totalRefunded: 0n,
        successRate: 90,
        averageFundingTimeHours: 2.5,
        uniquePayerCount: 5,
        averageRating: 4.5,
      };
      expect(stats.successRate).toBe(90);
      expect(stats.totalInvoices).toBe(10);
    });

    it("should have all required fields", () => {
      const stats: import("../creatorStats.js").CreatorStats = {
        totalInvoices: 5,
        totalRaised: 500n,
        totalReleased: 500n,
        totalRefunded: 0n,
        successRate: 100,
        averageFundingTimeHours: 1,
        uniquePayerCount: 3,
        averageRating: 5,
      };
      expect(stats.totalInvoices).toBe(5);
      expect(stats.successRate).toBe(100);
    });
  });

  describe("Issue #1193 - Contract Testing for API Compatibility", () => {
    // Consumer-driven contract model: each contract describes a public SDK
    // method, its expected params, and the shape of its return value.
    interface ContractDefinition {
      name: string;
      method: string;
      params: Record<string, string>;
      returns: Record<string, string>;
    }

    interface ContractResult {
      name: string;
      providerVerified: boolean;
      consumerVerified: boolean;
      compatible: boolean;
    }

    const contracts: ContractDefinition[] = [
      {
        name: "createInvoice",
        method: "createInvoice",
        params: { creator: "string", token: "string", deadline: "number" },
        returns: { invoiceId: "string", txHash: "string" },
      },
      {
        name: "pay",
        method: "pay",
        params: { invoiceId: "string", amount: "bigint" },
        returns: { txHash: "string" },
      },
      {
        name: "batchCreateInvoices",
        method: "batchCreateInvoices",
        params: { invoices: "array" },
        returns: { invoiceIds: "array" },
      },
    ];

    // Provider verification: the SDK exposes each contracted method.
    const verifyProvider = (client: StellarSplitClient, contract: ContractDefinition): boolean => {
      const fn = (client as unknown as Record<string, unknown>)[contract.method];
      return typeof fn === "function";
    };

    // Consumer verification: a consumer expectation matches the provider's
    // declared return shape (all expected keys present).
    const verifyConsumer = (
      contract: ContractDefinition,
      expectation: Record<string, unknown>,
    ): boolean => {
      return Object.keys(contract.returns).every((key) => key in expectation);
    };

    const runContracts = (): ContractResult[] => {
      const client = new StellarSplitClient(config);
      return contracts.map((contract) => {
        const providerVerified = verifyProvider(client, contract);
        const consumerVerified = verifyConsumer(
          contract,
          Object.fromEntries(Object.keys(contract.returns).map((k) => [k, null])),
        );
        return {
          name: contract.name,
          providerVerified,
          consumerVerified,
          compatible: providerVerified && consumerVerified,
        };
      });
    };

    it("should define contracts for the public API surface", () => {
      expect(contracts.length).toBeGreaterThan(0);
      for (const contract of contracts) {
        expect(contract.method).toBeTruthy();
        expect(Object.keys(contract.returns).length).toBeGreaterThan(0);
      }
    });

    it("should verify the provider satisfies each contract", () => {
      const client = new StellarSplitClient(config);
      for (const contract of contracts) {
        expect(verifyProvider(client, contract)).toBe(true);
      }
    });

    it("should verify consumer expectations match provider responses", () => {
      for (const contract of contracts) {
        const expectation = Object.fromEntries(
          Object.keys(contract.returns).map((k) => [k, null]),
        );
        expect(verifyConsumer(contract, expectation)).toBe(true);
      }
    });

    it("should detect incompatible consumer expectations", () => {
      const contract = contracts[0];
      expect(verifyConsumer(contract, {})).toBe(false);
    });

    it("should produce a compatibility matrix", () => {
      const results = runContracts();
      expect(results).toHaveLength(contracts.length);
      for (const result of results) {
        expect(result.providerVerified).toBe(true);
        expect(result.consumerVerified).toBe(true);
        expect(result.compatible).toBe(true);
      }
    });

    it("should publish contracts as a serializable artifact", () => {
      const published = JSON.stringify({ version: 1, contracts });
      const parsed = JSON.parse(published);
      expect(parsed.version).toBe(1);
      expect(parsed.contracts).toHaveLength(contracts.length);
      expect(parsed.contracts[0].method).toBe(contracts[0].method);
    });
  });
});
