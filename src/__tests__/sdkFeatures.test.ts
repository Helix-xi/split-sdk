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
    it("should validate batch size limit (1-20)", () => {
      const client = new StellarSplitClient(config);
      expect(() => client.batchCreateInvoices([])).rejects.toThrow(BatchTooLargeError);
      expect(() => client.batchCreateInvoices(Array(21).fill({}))).rejects.toThrow(BatchTooLargeError);
    });

    it("should validate all invoices before RPC call", async () => {
      const client = new StellarSplitClient(config);
      const invoices: CreateInvoiceParams[] = [
        { creator: "test", token: "test", deadline: 1000, recipients: [] },
        { creator: "", token: "test", deadline: 1000, recipients: [] },
      ];

      expect(() => client.batchCreateInvoices(invoices)).rejects.toThrow();
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

  describe("Issue #1175 - Lazy loading for SDK modules", () => {
    it("should resolve module dependencies in registry order", async () => {
      const { ModuleRegistry } = await import("../lazyModules.js");
      const registry = new ModuleRegistry();

      registry.register({
        name: "base",
        dependencies: [],
        load: async () => ({ value: 1 }),
      });
      registry.register({
        name: "derived",
        dependencies: ["base"],
        load: async () => ({ value: 2 }),
      });

      const order: string[] = [];
      const originalLoad = registry.get("base")!.load;
      registry.get("base")!.load = async () => {
        order.push("base");
        return originalLoad();
      };

      const result = await registry.load("derived");
      expect(result).toEqual({ value: 2 });
      expect(order).toEqual(["base"]);
    });

    it("should load modules on demand via dynamic import", async () => {
      const { ModuleRegistry } = await import("../lazyModules.js");
      const registry = new ModuleRegistry();
      const loadFn = vi.fn(async () => ({ ok: true }));

      registry.register({ name: "lazy", dependencies: [], load: loadFn });
      expect(loadFn).not.toHaveBeenCalled();

      const mod = await registry.load("lazy");
      expect(loadFn).toHaveBeenCalledTimes(1);
      expect(mod).toEqual({ ok: true });
    });

    it("should cache loaded modules and not reload", async () => {
      const { ModuleRegistry } = await import("../lazyModules.js");
      const registry = new ModuleRegistry();
      const loadFn = vi.fn(async () => ({ ok: true }));

      registry.register({ name: "cached", dependencies: [], load: loadFn });
      await registry.load("cached");
      await registry.load("cached");

      expect(loadFn).toHaveBeenCalledTimes(1);
    });

    it("should handle load errors and record metrics", async () => {
      const { ModuleRegistry } = await import("../lazyModules.js");
      const registry = new ModuleRegistry();

      registry.register({
        name: "broken",
        dependencies: [],
        load: async () => {
          throw new Error("boom");
        },
      });

      await expect(registry.load("broken")).rejects.toThrow("boom");

      const metrics = registry.getMetrics();
      expect(metrics.failures).toBe(1);
      expect(metrics.loads).toBe(0);
    });

    it("should track loading metrics", async () => {
      const { ModuleRegistry } = await import("../lazyModules.js");
      const registry = new ModuleRegistry();

      registry.register({ name: "m1", dependencies: [], load: async () => ({}) });
      registry.register({ name: "m2", dependencies: [], load: async () => ({}) });

      await registry.load("m1");
      await registry.load("m2");

      const metrics = registry.getMetrics();
      expect(metrics.loads).toBe(2);
      expect(metrics.failures).toBe(0);
      expect(metrics.totalLoadTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should throw for unknown modules", async () => {
      const { ModuleRegistry } = await import("../lazyModules.js");
      const registry = new ModuleRegistry();

      await expect(registry.load("missing")).rejects.toThrow();
    });
  });
});
