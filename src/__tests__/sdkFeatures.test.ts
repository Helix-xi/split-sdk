import { describe, it, expect, beforeEach, vi } from "vitest";
import { StellarSplitClient } from "../client.js";
import { TypedEventEmitter } from "../events/TypedEventEmitter.js";
import { MetricsPlugin, PluginRegistry } from "../plugin.js";
import { BatchTooLargeError } from "../errors.js";
import type { CreateInvoiceParams } from "../types.js";
import {
  DebugLevel,
  DebugLogger,
  DebugBreakpoints,
  DebugConsole,
  DebugAnalytics,
  formatDebugValue,
  inspectState,
} from "../debug.js";

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

  describe("Issue #1180 - Debug Mode", () => {
    it("should gate verbose logging by debug level threshold", () => {
      const logger = new DebugLogger({ level: DebugLevel.Info });
      const sink = vi.fn();
      logger.addSink(sink);

      logger.trace("trace msg");
      logger.debug("debug msg");
      logger.info("info msg");
      logger.error("error msg");

      expect(sink).toHaveBeenCalledTimes(2);
      expect(sink.mock.calls[0][0]).toMatchObject({ level: DebugLevel.Info, message: "info msg" });
      expect(sink.mock.calls[1][0]).toMatchObject({ level: DebugLevel.Error, message: "error msg" });
    });

    it("should emit verbose operation logs with context", () => {
      const logger = new DebugLogger({ level: DebugLevel.Trace });
      const sink = vi.fn();
      logger.addSink(sink);

      logger.operation("createInvoice", { invoiceId: 1n }, { durationMs: 12 });

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0][0]).toMatchObject({
        level: DebugLevel.Trace,
        operation: "createInvoice",
        context: { invoiceId: 1n },
        durationMs: 12,
      });
    });

    it("should support enabling and disabling debug mode", () => {
      const logger = new DebugLogger({ level: DebugLevel.Off });
      const sink = vi.fn();
      logger.addSink(sink);

      logger.info("hidden");
      expect(sink).not.toHaveBeenCalled();

      logger.enable(DebugLevel.Debug);
      logger.debug("visible");
      expect(sink).toHaveBeenCalledTimes(1);

      logger.disable();
      logger.error("hidden again");
      expect(sink).toHaveBeenCalledTimes(1);
    });

    it("should trigger debug breakpoints when enabled", () => {
      const breakpoints = new DebugBreakpoints();
      const onHit = vi.fn();
      breakpoints.register("beforeRpc", onHit);

      breakpoints.hit("beforeRpc", { method: "createInvoice" });
      expect(onHit).toHaveBeenCalledWith({ method: "createInvoice" });

      breakpoints.disable();
      breakpoints.hit("beforeRpc", { method: "pay" });
      expect(onHit).toHaveBeenCalledTimes(1);
    });

    it("should format debug values and inspect state", () => {
      expect(formatDebugValue({ a: 1n, b: [1, 2] })).toContain("1n");
      const snapshot = inspectState({ count: 3, nested: { ok: true } });
      expect(snapshot).toMatchObject({ count: 3, nested: { ok: true } });
    });

    it("should expose a debug console that records entries", () => {
      const logger = new DebugLogger({ level: DebugLevel.Debug });
      const console = new DebugConsole(logger);

      console.log("hello", { value: 1 });
      console.warn("careful");

      const entries = console.getEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ level: DebugLevel.Debug, message: "hello" });
      expect(entries[1]).toMatchObject({ level: DebugLevel.Warn, message: "careful" });

      console.clear();
      expect(console.getEntries()).toHaveLength(0);
    });

    it("should collect debug analytics", () => {
      const analytics = new DebugAnalytics();
      analytics.record("createInvoice", 10);
      analytics.record("createInvoice", 30);
      analytics.record("pay", 5);

      const summary = analytics.getSummary();
      expect(summary.totalOperations).toBe(3);
      expect(summary.byOperation.createInvoice).toMatchObject({ count: 2, totalMs: 40, averageMs: 20 });
      expect(summary.byOperation.pay).toMatchObject({ count: 1, totalMs: 5, averageMs: 5 });

      analytics.reset();
      expect(analytics.getSummary().totalOperations).toBe(0);
    });
  });
});
