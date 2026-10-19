import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InvoiceStateSubscriber,
  matchesFilter,
  type InvoiceStateUpdate,
} from "../src/invoiceStateSubscription.js";
import { EventEmitter } from "events";

class MockWebSocket extends EventEmitter {
  static instances: MockWebSocket[] = [];
  readyState = 0; // CONNECTING
  url: string;
  sentMessages: string[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
    // Simulate async open
    setTimeout(() => {
      this.readyState = 1; // OPEN
      if (this.onopen) this.onopen();
      this.emit("open");
    }, 10);
  }

  onopen: (() => void) | null = null;
  onclose: ((event: { reason?: string }) => void) | null = null;
  onerror: ((err: any) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  send(data: string) {
    this.sentMessages.push(data);
  }

  close(code = 1000, reason = "Normal closure") {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose({ reason });
    this.emit("close", { reason });
  }

  simulateServerMessage(payload: Record<string, unknown>) {
    const data = JSON.stringify(payload);
    if (this.onmessage) {
      this.onmessage({ data });
    }
    this.emit("message", { data });
  }
}

describe("Invoice State Subscription (#1034)", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  describe("Filtering Logic", () => {
    const sampleUpdate: InvoiceStateUpdate = {
      invoiceId: "inv-100",
      status: "Released",
      funded: 50_000_000n,
      timestamp: Date.now(),
      lastPayment: {
        payer: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
        amount: 25_000_000n,
        timestamp: Date.now(),
      },
      metadata: {
        creator: "GCREATOR123",
      },
    };

    it("matches wildcard invoiceId '*'", () => {
      expect(matchesFilter(sampleUpdate, { invoiceId: "*" })).toBe(true);
    });

    it("filters by single invoiceId", () => {
      expect(matchesFilter(sampleUpdate, { invoiceId: "inv-100" })).toBe(true);
      expect(matchesFilter(sampleUpdate, { invoiceId: "inv-999" })).toBe(false);
    });

    it("filters by array of invoiceIds", () => {
      expect(matchesFilter(sampleUpdate, { invoiceId: ["inv-1", "inv-100"] })).toBe(true);
      expect(matchesFilter(sampleUpdate, { invoiceId: ["inv-1", "inv-2"] })).toBe(false);
    });

    it("filters by status", () => {
      expect(matchesFilter(sampleUpdate, { status: "Released" })).toBe(true);
      expect(matchesFilter(sampleUpdate, { status: "Pending" })).toBe(false);
      expect(matchesFilter(sampleUpdate, { status: ["Pending", "Released"] })).toBe(true);
      expect(matchesFilter(sampleUpdate, { status: ["Cancelled", "Refunded"] })).toBe(false);
    });

    it("filters by creator", () => {
      expect(matchesFilter(sampleUpdate, { creator: "gcreator123" })).toBe(true);
      expect(matchesFilter(sampleUpdate, { creator: "gothercreator" })).toBe(false);
    });

    it("filters by payer", () => {
      expect(
        matchesFilter(sampleUpdate, {
          payer: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
        }),
      ).toBe(true);
      expect(matchesFilter(sampleUpdate, { payer: "GUNKNOWN" })).toBe(false);
    });

    it("filters by minimum funded amount", () => {
      expect(matchesFilter(sampleUpdate, { minFunded: 40_000_000n })).toBe(true);
      expect(matchesFilter(sampleUpdate, { minFunded: 50_000_000n })).toBe(true);
      expect(matchesFilter(sampleUpdate, { minFunded: 60_000_000n })).toBe(false);
    });

    it("evaluates custom predicate filter", () => {
      expect(matchesFilter(sampleUpdate, { custom: (u) => u.funded > 10_000_000n })).toBe(true);
      expect(matchesFilter(sampleUpdate, { custom: (u) => u.status === "Pending" })).toBe(false);
    });
  });

  describe("Real-time WebSocket Subscriptions", () => {
    it("subscribes and receives real-time invoice state updates", async () => {
      const subscriber = new InvoiceStateSubscriber({
        wsUrl: "ws://localhost:9000",
        wsFactory: () => new MockWebSocket("ws://localhost:9000") as unknown as WebSocket,
      });

      const callback = vi.fn();
      const handle = subscriber.subscribe({ invoiceId: "inv-42" }, callback);

      // Wait for socket to open
      await new Promise((r) => setTimeout(r, 20));
      const ws = MockWebSocket.instances[0]!;

      // Simulate incoming message
      ws.simulateServerMessage({
        invoiceId: "inv-42",
        status: "Pending",
        funded: "10000000",
        timestamp: Date.now(),
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: "inv-42",
          status: "Pending",
          funded: 10_000_000n,
        }),
      );

      // Unsubscribe stops delivery
      handle.unsubscribe();
      expect(handle.isActive).toBe(false);

      ws.simulateServerMessage({
        invoiceId: "inv-42",
        status: "Released",
        funded: "10000000",
      });

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("supports dynamic filter updates via updateFilter()", async () => {
      const subscriber = new InvoiceStateSubscriber({
        wsUrl: "ws://localhost:9000",
        wsFactory: () => new MockWebSocket("ws://localhost:9000") as unknown as WebSocket,
      });

      const callback = vi.fn();
      const handle = subscriber.subscribe({ status: "Pending" }, callback);

      await new Promise((r) => setTimeout(r, 20));
      const ws = MockWebSocket.instances[0]!;

      ws.simulateServerMessage({ invoiceId: "inv-1", status: "Released", funded: 0 });
      expect(callback).not.toHaveBeenCalled();

      // Update filter to accept "Released"
      handle.updateFilter({ status: "Released" });

      ws.simulateServerMessage({ invoiceId: "inv-2", status: "Released", funded: 0 });
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: "inv-2" }));

      handle.unsubscribe();
    });
  });

  describe("Reliable Reconnection", () => {
    it("automatically reconnects and re-registers active subscriptions upon reconnect", async () => {
      const subscriber = new InvoiceStateSubscriber({
        wsUrl: "ws://localhost:9000",
        wsFactory: () => new MockWebSocket("ws://localhost:9000") as unknown as WebSocket,
        reconnect: {
          enabled: true,
          baseDelayMs: 20,
          maxDelayMs: 50,
          maxAttempts: 3,
          jitter: false,
        },
      });

      const onConnect = vi.fn();
      const onDisconnect = vi.fn();
      const onReconnect = vi.fn();

      subscriber.on("connect", onConnect);
      subscriber.on("disconnect", onDisconnect);
      subscriber.on("reconnect", onReconnect);

      const callback = vi.fn();
      const handle = subscriber.subscribe("inv-auto-recon", callback);

      await new Promise((r) => setTimeout(r, 25));
      expect(onConnect).toHaveBeenCalledTimes(1);

      const ws1 = MockWebSocket.instances[0]!;
      // Simulate unexpected socket drop
      ws1.close(1006, "Abnormal closure");
      expect(onDisconnect).toHaveBeenCalledWith("Abnormal closure");

      // Wait for reconnect delay
      await new Promise((r) => setTimeout(r, 50));

      expect(onReconnect).toHaveBeenCalledWith(1, 3);
      expect(MockWebSocket.instances.length).toBe(2);

      const ws2 = MockWebSocket.instances[1]!;
      await new Promise((r) => setTimeout(r, 25));
      expect(onConnect).toHaveBeenCalledTimes(2);

      // Verify that subscription receives events on reconnected socket
      ws2.simulateServerMessage({
        invoiceId: "inv-auto-recon",
        status: "Paid",
        funded: "500",
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: "inv-auto-recon" }),
      );

      handle.unsubscribe();
      subscriber.disconnect();
    });

    it("stops after maxAttempts and triggers reconnect_failed", async () => {
      const subscriber = new InvoiceStateSubscriber({
        wsUrl: "ws://localhost:9000",
        wsFactory: () => {
          throw new Error("Connection refused");
        },
        reconnect: {
          enabled: true,
          baseDelayMs: 10,
          maxDelayMs: 20,
          maxAttempts: 2,
          jitter: false,
        },
      });

      const onFailed = vi.fn();
      subscriber.on("reconnect_failed", onFailed);

      subscriber.subscribe("inv-fail", () => {});

      // Wait for retry attempts to exhaust
      await new Promise((r) => setTimeout(r, 60));

      expect(onFailed).toHaveBeenCalledWith(2);
      subscriber.disconnect();
    });
  });
});
