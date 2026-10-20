import { describe, it, expect, beforeEach, vi } from "vitest";
import { StellarSplitClient } from "../client.js";
import { TypedEventEmitter } from "../events/TypedEventEmitter.js";
import { MetricsPlugin, PluginRegistry } from "../plugin.js";
import { BatchTooLargeError } from "../errors.js";
import type { CreateInvoiceParams } from "../types.js";

/**
 * SDK test utilities and mocking (#1183)
 *
 * Lightweight, dependency-free helpers for exercising the SDK in tests:
 * - MockProvider: records calls and returns queued responses (RPC/horizon-style)
 * - fixtures: reusable, valid SDK payloads
 * - assertions: focused helpers for SDK responses/errors
 * - hooks: beforeEach/afterEach style setup + teardown
 */

interface MockCall {
  method: string;
  args: unknown[];
}

class MockProvider {
  readonly calls: MockCall[] = [];
  private responses: unknown[] = [];
  private error: unknown = null;

  queueResponse(response: unknown): this {
    this.responses.push(response);
    return this;
  }

  queueError(error: unknown): this {
    this.error = error;
    return this;
  }

  async call(method: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ method, args });
    if (this.error) {
      const err = this.error;
      this.error = null;
      throw err;
    }
    return this.responses.length > 0 ? this.responses.shift() : undefined;
  }

  getCallCount(method?: string): number {
    return method ? this.calls.filter((c) => c.method === method).length : this.calls.length;
  }

  reset(): void {
    this.calls.length = 0;
    this.responses = [];
    this.error = null;
  }
}

const fixtures = {
  config: {
    rpcUrl: "http://localhost:8000",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CBND2TWUC3BVVK4IEUA6O3DC7RNWXO5EAUWK5F2BXBDKP2I7BLXVKZDS",
  },
  invoice(overrides: Partial<CreateInvoiceParams> = {}): CreateInvoiceParams {
    return {
      creator: "GCREATOR",
      token: "CTOKEN",
      deadline: 1000,
      recipients: [],
      ...overrides,
    };
  },
  paymentEvent(overrides: Record<string, unknown> = {}) {
    return { invoiceId: 1n, amount: 100n, payer: "GPAYER", timestamp: 1_700_000_000, ...overrides };
  },
};

const assertions = {
  toBeSuccessfulResponse(response: unknown): void {
    expect(response).toBeDefined();
    expect(response).not.toBeNull();
  },
  async toRejectWith(promise: Promise<unknown>, errorType: new (...args: any[]) => Error): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(errorType);
  },
  toHaveBeenCalledWithMethod(provider: MockProvider, method: string): void {
    expect(provider.calls.some((c) => c.method === method)).toBe(true);
  },
};

function createTestHooks() {
  const provider = new MockProvider();
  return {
    provider,
    beforeEach: () => provider.reset(),
    afterEach: () => provider.reset(),
  };
}

describe("SDK Features (#854, #855, #856, #857)", () => {
  // Mock config
  const config = fixtures.config;

  describe("Issue #855 - batchCreateInvoices", () => {
    it("should validate batch size limit (1-20)", () => {
      const client = new StellarSplitClient(config);
      expect(() => client.batchCreateInvoices([])).rejects.toThrow(BatchTooLargeError);
      expect(() => client.batchCreateInvoices(Array(21).fill({}))).rejects.toThrow(BatchTooLargeError);
    });

    it("should validate all invoices before RPC call", async () => {
      const client = new StellarSplitClient(config);
      const invoices: CreateInvoiceParams[] = [
        fixtures.invoice({ creator: "test", token: "test" }),
        fixtures.invoice({ creator: "", token: "test" }),
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

  describe("Issue #1183 - SDK test utilities and mocking", () => {
    let hooks: ReturnType<typeof createTestHooks>;

    beforeEach(() => {
      hooks = createTestHooks();
      hooks.beforeEach();
    });

    it("MockProvider records calls and returns queued responses", async () => {
      hooks.provider.queueResponse({ invoiceId: "inv-1" });
      const result = await hooks.provider.call("createInvoice", fixtures.invoice());

      expect(result).toEqual({ invoiceId: "inv-1" });
      expect(hooks.provider.getCallCount("createInvoice")).toBe(1);
      assertions.toHaveBeenCalledWithMethod(hooks.provider, "createInvoice");
    });

    it("MockProvider surfaces queued errors", async () => {
      hooks.provider.queueError(new BatchTooLargeError("too many"));
      await assertions.toRejectWith(hooks.provider.call("batchCreateInvoices"), BatchTooLargeError);
    });

    it("fixtures produce valid invoice payloads", () => {
      const invoice = fixtures.invoice({ creator: "GOVERRIDE" });
      expect(invoice.creator).toBe("GOVERRIDE");
      expect(invoice.token).toBe("CTOKEN");
      expect(invoice.deadline).toBe(1000);
    });

    it("assertion helpers validate successful responses", () => {
      assertions.toBeSuccessfulResponse({ txHash: "hash" });
      expect(() => assertions.toBeSuccessfulResponse(null)).toThrow();
    });

    it("test hooks reset provider state between runs", async () => {
      await hooks.provider.call("pay");
      expect(hooks.provider.getCallCount()).toBe(1);

      hooks.afterEach();
      expect(hooks.provider.getCallCount()).toBe(0);
    });
  });
});
