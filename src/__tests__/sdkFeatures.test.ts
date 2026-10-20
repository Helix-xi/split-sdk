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

  describe("Issue #1195 - SDK Regression Suite", () => {
    // Baseline management: store/load baseline results for regression comparison.
    type RegressionResult = { name: string; passed: boolean; durationMs: number };
    type Baseline = Record<string, RegressionResult>;

    const createBaseline = (results: RegressionResult[]): Baseline =>
      results.reduce<Baseline>((acc, r) => {
        acc[r.name] = r;
        return acc;
      }, {});

    const compareToBaseline = (current: RegressionResult[], baseline: Baseline) => {
      const regressions: string[] = [];
      const improvements: string[] = [];
      const missing: string[] = [];

      for (const result of current) {
        const base = baseline[result.name];
        if (!base) {
          missing.push(result.name);
          continue;
        }
        if (base.passed && !result.passed) regressions.push(result.name);
        if (!base.passed && result.passed) improvements.push(result.name);
      }

      return { regressions, improvements, missing };
    };

    const analyzeTrend = (history: number[]): "improving" | "degrading" | "stable" => {
      if (history.length < 2) return "stable";
      const first = history[0];
      const last = history[history.length - 1];
      if (last < first) return "improving";
      if (last > first) return "degrading";
      return "stable";
    };

    const formatReport = (comparison: ReturnType<typeof compareToBaseline>): string => {
      const lines = ["SDK Regression Report"];
      lines.push(`Regressions: ${comparison.regressions.length}`);
      lines.push(`Improvements: ${comparison.improvements.length}`);
      lines.push(`Missing: ${comparison.missing.length}`);
      return lines.join("\n");
    };

    it("should store and load baseline results", () => {
      const results: RegressionResult[] = [
        { name: "batchCreateInvoices", passed: true, durationMs: 12 },
        { name: "eventBus", passed: true, durationMs: 5 },
      ];
      const baseline = createBaseline(results);
      expect(Object.keys(baseline)).toHaveLength(2);
      expect(baseline["eventBus"].passed).toBe(true);
    });

    it("should detect regressions against baseline", () => {
      const baseline = createBaseline([
        { name: "batchCreateInvoices", passed: true, durationMs: 12 },
        { name: "eventBus", passed: true, durationMs: 5 },
      ]);
      const current: RegressionResult[] = [
        { name: "batchCreateInvoices", passed: false, durationMs: 20 },
        { name: "eventBus", passed: true, durationMs: 5 },
      ];
      const comparison = compareToBaseline(current, baseline);
      expect(comparison.regressions).toEqual(["batchCreateInvoices"]);
      expect(comparison.improvements).toEqual([]);
    });

    it("should detect improvements and missing cases", () => {
      const baseline = createBaseline([
        { name: "batchCreateInvoices", passed: false, durationMs: 12 },
      ]);
      const current: RegressionResult[] = [
        { name: "batchCreateInvoices", passed: true, durationMs: 10 },
        { name: "newFeature", passed: true, durationMs: 3 },
      ];
      const comparison = compareToBaseline(current, baseline);
      expect(comparison.improvements).toEqual(["batchCreateInvoices"]);
      expect(comparison.missing).toEqual(["newFeature"]);
    });

    it("should produce a clear report", () => {
      const baseline = createBaseline([
        { name: "batchCreateInvoices", passed: true, durationMs: 12 },
      ]);
      const current: RegressionResult[] = [
        { name: "batchCreateInvoices", passed: false, durationMs: 20 },
      ];
      const report = formatReport(compareToBaseline(current, baseline));
      expect(report).toContain("SDK Regression Report");
      expect(report).toContain("Regressions: 1");
    });

    it("should identify trends across runs", () => {
      expect(analyzeTrend([5, 4, 3])).toBe("improving");
      expect(analyzeTrend([3, 4, 5])).toBe("degrading");
      expect(analyzeTrend([4, 4, 4])).toBe("stable");
      expect(analyzeTrend([4])).toBe("stable");
    });

    it("should run regression cases against SDK behavior", async () => {
      const client = new StellarSplitClient(config);
      const cases: Array<{ name: string; run: () => Promise<boolean> }> = [
        {
          name: "batch size guard rejects empty",
          run: async () => {
            try {
              await client.batchCreateInvoices([]);
              return false;
            } catch (err) {
              return err instanceof BatchTooLargeError;
            }
          },
        },
        {
          name: "event bus delivers payload",
          run: async () => {
            const emitter = new TypedEventEmitter<{ ping: { value: number } }>();
            let received = 0;
            emitter.on("ping", (p) => {
              received = p.value;
            });
            emitter.emit("ping", { value: 7 });
            return received === 7;
          },
        },
      ];

      const results: RegressionResult[] = [];
      for (const c of cases) {
        const start = Date.now();
        const passed = await c.run();
        results.push({ name: c.name, passed, durationMs: Date.now() - start });
      }

      expect(results.every((r) => r.passed)).toBe(true);
      const baseline = createBaseline(results);
      const comparison = compareToBaseline(results, baseline);
      expect(comparison.regressions).toEqual([]);
    });
  });
});
