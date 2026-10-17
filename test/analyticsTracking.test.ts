import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AnalyticsTracker,
  PrivacyController,
  AnalyticsCollector,
  wrapClientWithAnalytics,
} from "../src/analyticsTracking.js";

describe("Analytics Tracking (#1036)", () => {
  describe("Opt-in & Lifecycle Controls", () => {
    it("is disabled by default (strictly opt-in)", () => {
      const tracker = new AnalyticsTracker();
      expect(tracker.isEnabled()).toBe(false);

      tracker.track({ name: "test_event" });
      const report = tracker.generateReport();
      expect(report.totalEvents).toBe(0);
      expect(report.totalMethodCalls).toBe(0);
    });

    it("can opt in explicitly", () => {
      const tracker = new AnalyticsTracker({ enabled: false });
      expect(tracker.isEnabled()).toBe(false);

      tracker.optIn();
      expect(tracker.isEnabled()).toBe(true);

      tracker.track({ name: "test_event" });
      const report = tracker.generateReport();
      expect(report.totalEvents).toBe(1);
    });

    it("can opt out and clears accumulated state", () => {
      const tracker = new AnalyticsTracker({ enabled: true });
      tracker.track({ name: "event_1" });
      expect(tracker.generateReport().totalEvents).toBe(1);

      tracker.optOut();
      expect(tracker.isEnabled()).toBe(false);
      expect(tracker.generateReport().totalEvents).toBe(0);

      tracker.track({ name: "event_2" });
      expect(tracker.generateReport().totalEvents).toBe(0);
    });
  });

  describe("Privacy Controls", () => {
    const validGAddress = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
    const validSSecret = "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4";

    it("redacts Stellar secret keys (S...)", () => {
      const controller = new PrivacyController({ stripSecrets: true });
      const sanitized = controller.sanitizeString(`Signing with ${validSSecret}`);
      expect(sanitized).toBe("Signing with [REDACTED_SECRET]");
      expect(sanitized).not.toContain(validSSecret);
    });

    it("anonymizes Stellar public keys (G...) in anonymized mode", () => {
      const controller = new PrivacyController({ level: "anonymized", anonymizeAddresses: true });
      const sanitized = controller.sanitizeString(validGAddress);
      expect(sanitized).not.toBe(validGAddress);
      expect(sanitized.startsWith("GA7Q...")).toBe(true);
      expect(sanitized.endsWith("...VSGZ")).toBe(true);
    });

    it("redacts addresses completely in strict mode", () => {
      const controller = new PrivacyController({ level: "strict" });
      const sanitized = controller.anonymizeAddress(validGAddress);
      expect(sanitized).toBe("[REDACTED_ADDRESS]");

      const props = controller.sanitizeProperties({
        user: validGAddress,
        amount: 100,
      });
      expect(props).toEqual({});
    });

    it("redacts PII fields like email, ip, and password", () => {
      const controller = new PrivacyController({ allowPII: false });
      const sanitized = controller.sanitizeProperties({
        email: "alice@example.com",
        ip: "192.168.1.1",
        password: "supersecretpassword",
        memo: "payment invoice 123",
      });

      expect(sanitized["email"]).toBe("[REDACTED_PII]");
      expect(sanitized["ip"]).toBe("[REDACTED_PII]");
      expect(sanitized["password"]).toBe("[REDACTED_PII]");
      expect(sanitized["memo"]).toBe("payment invoice 123");
    });

    it("tracks events with privacy sanitization applied", () => {
      const tracker = new AnalyticsTracker({
        enabled: true,
        privacy: { level: "anonymized" },
      });

      tracker.track({
        name: "create_invoice",
        category: "invoices",
        properties: {
          creator: validGAddress,
          secretKey: validSSecret,
          email: "creator@example.com",
          amount: 500,
        },
      });

      const report = tracker.generateReport();
      expect(report.totalEvents).toBe(1);
      const event = report.events[0];
      expect(event?.properties["secretKey"]).toBe("[REDACTED_SECRET]");
      expect(event?.properties["email"]).toBe("[REDACTED_PII]");
      expect(event?.properties["creator"]).not.toBe(validGAddress);
      expect(event?.properties["amount"]).toBe(500);
    });
  });

  describe("Collector & Accurate Reporting", () => {
    it("accumulates method latencies and computes accurate statistics", () => {
      const tracker = new AnalyticsTracker({ enabled: true });

      tracker.trackMethod("getInvoice", 10, true);
      tracker.trackMethod("getInvoice", 20, true);
      tracker.trackMethod("getInvoice", 30, true);
      tracker.trackMethod("getInvoice", 40, false);

      const report = tracker.generateReport();
      const methodStats = report.methods["getInvoice"];

      expect(methodStats).toBeDefined();
      expect(methodStats?.calls).toBe(4);
      expect(methodStats?.errors).toBe(1);
      expect(methodStats?.errorRate).toBe(0.25);
      expect(methodStats?.minDurationMs).toBe(10);
      expect(methodStats?.maxDurationMs).toBe(40);
      expect(methodStats?.avgDurationMs).toBe(25);
      expect(methodStats?.p50DurationMs).toBe(20);
      expect(methodStats?.p95DurationMs).toBe(40);
    });

    it("tracks custom metrics and error rates accurately", () => {
      const tracker = new AnalyticsTracker({ enabled: true });

      tracker.trackMetric("retries", 3);
      tracker.trackMetric("retries", 2);
      tracker.trackError(new Error("RPC Timeout"), { code: 504 });

      const report = tracker.generateReport();
      expect(report.metrics["retries"]).toBe(5);
      expect(report.metrics["error_count"]).toBe(1);
      expect(report.eventsByCategory["errors"]).toBe(1);
    });

    it("limits queue size and evicts oldest events", () => {
      const collector = new AnalyticsCollector(3);
      collector.recordEvent({ name: "e1", category: "c", properties: {}, timestamp: 1 });
      collector.recordEvent({ name: "e2", category: "c", properties: {}, timestamp: 2 });
      collector.recordEvent({ name: "e3", category: "c", properties: {}, timestamp: 3 });
      collector.recordEvent({ name: "e4", category: "c", properties: {}, timestamp: 4 });

      const events = collector.getEvents();
      expect(events.length).toBe(3);
      expect(events[0]?.name).toBe("e2");
      expect(events[2]?.name).toBe("e4");
    });
  });

  describe("Reporting & Flush", () => {
    it("invokes onReport callback when generating report or flushing", async () => {
      const onReport = vi.fn();
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      const tracker = new AnalyticsTracker({
        enabled: true,
        endpoint: "https://telemetry.stellar.org/v1/metrics",
        onReport,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      tracker.track({ name: "invoice_paid" });
      const flushedReport = await tracker.flush();

      expect(onReport).toHaveBeenCalledTimes(1);
      expect(flushedReport?.totalEvents).toBe(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://telemetry.stellar.org/v1/metrics",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );

      // State is reset after flush
      expect(tracker.generateReport().totalEvents).toBe(0);
    });
  });

  describe("wrapClientWithAnalytics Proxy", () => {
    it("returns unwrapped client when analytics is disabled", () => {
      const tracker = new AnalyticsTracker({ enabled: false });
      const client = {
        fetchData: () => "data",
      };

      const proxied = wrapClientWithAnalytics(client, tracker);
      expect(proxied).toBe(client);
    });

    it("intercepts successful and failing calls on wrapped client", async () => {
      const tracker = new AnalyticsTracker({ enabled: true });
      const client = {
        async getInvoice(id: string) {
          return { id };
        },
        async failOperation() {
          throw new Error("Simulation failure");
        },
      };

      const proxied = wrapClientWithAnalytics(client, tracker);

      await proxied.getInvoice("inv-123");
      await expect(proxied.failOperation()).rejects.toThrow("Simulation failure");

      const report = tracker.generateReport();
      expect(report.methods["getInvoice"]?.calls).toBe(1);
      expect(report.methods["getInvoice"]?.errors).toBe(0);
      expect(report.methods["failOperation"]?.calls).toBe(1);
      expect(report.methods["failOperation"]?.errors).toBe(1);
    });
  });
});
