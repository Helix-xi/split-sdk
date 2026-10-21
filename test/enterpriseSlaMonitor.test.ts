import { describe, expect, it, vi } from "vitest";
import {
  EnterpriseSlaMonitor,
  SlaTiers,
} from "../src/enterpriseSlaMonitor.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EnterpriseSlaMonitor", () => {
  // ── registerSla() ─────────────────────────────────────────────────────────

  describe("registerSla()", () => {
    it("registers a new SLA without error", () => {
      const monitor = new EnterpriseSlaMonitor();
      expect(() =>
        monitor.registerSla({ name: "op.fetch", thresholdMs: 500 })
      ).not.toThrow();
    });

    it("replacing an existing SLA updates the threshold", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 100 });
      monitor.registerSla({ name: "op", thresholdMs: 9_000 });

      monitor.recordEvent("op", 5_000);
      const report = monitor.getSlaReport();
      const metrics = report.metrics.find((m) => m.name === "op")!;

      // With thresholdMs=9000, a 5000ms event should NOT be a violation
      expect(metrics.violations).toBe(0);
    });
  });

  // ── registerSlaTier() ─────────────────────────────────────────────────────

  describe("registerSlaTier()", () => {
    it("uses Gold tier threshold", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSlaTier("op.gold", "Gold");
      monitor.recordEvent("op.gold", SlaTiers.Gold + 1);

      expect(monitor.getViolations("op.gold")).toHaveLength(1);
    });

    it("uses Silver tier threshold", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSlaTier("op.silver", "Silver");

      monitor.recordEvent("op.silver", SlaTiers.Gold + 1); // within Silver
      expect(monitor.getViolations("op.silver")).toHaveLength(0);

      monitor.recordEvent("op.silver", SlaTiers.Silver + 1); // breaches Silver
      expect(monitor.getViolations("op.silver")).toHaveLength(1);
    });

    it("uses Bronze tier threshold", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSlaTier("op.bronze", "Bronze");
      monitor.recordEvent("op.bronze", SlaTiers.Bronze + 1);

      expect(monitor.getViolations("op.bronze")).toHaveLength(1);
    });
  });

  // ── recordEvent() ─────────────────────────────────────────────────────────

  describe("recordEvent()", () => {
    it("returns null for unknown SLA", () => {
      const monitor = new EnterpriseSlaMonitor();
      expect(monitor.recordEvent("unknown.sla", 100)).toBeNull();
    });

    it("records a compliant event", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 1_000 });

      const event = monitor.recordEvent("op", 500);
      expect(event).not.toBeNull();
      expect(event!.violated).toBe(false);
      expect(event!.durationMs).toBe(500);
    });

    it("records a violating event", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 1_000 });

      const event = monitor.recordEvent("op", 1_500);
      expect(event!.violated).toBe(true);
    });

    it("event at exactly the threshold is NOT a violation", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 500 });

      const event = monitor.recordEvent("op", 500);
      expect(event!.violated).toBe(false);
    });
  });

  // ── onViolation() ─────────────────────────────────────────────────────────

  describe("onViolation()", () => {
    it("fires callback when threshold is exceeded", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 300 });
      const cb = vi.fn();
      monitor.onViolation(cb);

      monitor.recordEvent("op", 500);

      expect(cb).toHaveBeenCalledOnce();
      expect(cb.mock.calls[0]![0].violated).toBe(true);
    });

    it("does NOT fire callback on compliant event", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 1_000 });
      const cb = vi.fn();
      monitor.onViolation(cb);

      monitor.recordEvent("op", 200);
      expect(cb).not.toHaveBeenCalled();
    });

    it("unsubscribe removes the callback", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 100 });
      const cb = vi.fn();
      const unsub = monitor.onViolation(cb);

      unsub();
      monitor.recordEvent("op", 9_999);
      expect(cb).not.toHaveBeenCalled();
    });

    it("fires multiple callbacks in registration order", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 100 });
      const order: number[] = [];
      monitor.onViolation(() => order.push(1));
      monitor.onViolation(() => order.push(2));

      monitor.recordEvent("op", 9_999);
      expect(order).toEqual([1, 2]);
    });
  });

  // ── getViolations() ───────────────────────────────────────────────────────

  describe("getViolations()", () => {
    it("returns empty array when no violations have occurred", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 1_000 });
      monitor.recordEvent("op", 100);
      expect(monitor.getViolations()).toEqual([]);
    });

    it("returns only violating events", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 500 });
      monitor.recordEvent("op", 100); // ok
      monitor.recordEvent("op", 600); // violation
      monitor.recordEvent("op", 700); // violation

      expect(monitor.getViolations()).toHaveLength(2);
    });

    it("filters by slaName when provided", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op.a", thresholdMs: 100 });
      monitor.registerSla({ name: "op.b", thresholdMs: 100 });
      monitor.recordEvent("op.a", 999);
      monitor.recordEvent("op.b", 999);

      expect(monitor.getViolations("op.a")).toHaveLength(1);
      expect(monitor.getViolations("op.b")).toHaveLength(1);
      expect(monitor.getViolations()).toHaveLength(2);
    });
  });

  // ── getSlaReport() ────────────────────────────────────────────────────────

  describe("getSlaReport()", () => {
    it("returns empty metrics for no registered SLAs", () => {
      const monitor = new EnterpriseSlaMonitor();
      const report = monitor.getSlaReport();
      expect(report.metrics).toEqual([]);
      expect(report.totalViolations).toBe(0);
      expect(report.overallComplianceRate).toBe(1);
    });

    it("computes compliance rate correctly", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 500 });
      monitor.recordEvent("op", 100); // ok
      monitor.recordEvent("op", 200); // ok
      monitor.recordEvent("op", 600); // violation
      monitor.recordEvent("op", 700); // violation

      const report = monitor.getSlaReport();
      const m = report.metrics[0]!;

      expect(m.totalEvents).toBe(4);
      expect(m.violations).toBe(2);
      expect(m.complianceRate).toBeCloseTo(0.5);
      expect(report.overallComplianceRate).toBeCloseTo(0.5);
    });

    it("computes min / max / avg correctly", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 9_999 });
      monitor.recordEvent("op", 100);
      monitor.recordEvent("op", 300);
      monitor.recordEvent("op", 500);

      const { metrics } = monitor.getSlaReport();
      expect(metrics[0]!.minDurationMs).toBe(100);
      expect(metrics[0]!.maxDurationMs).toBe(500);
      expect(metrics[0]!.avgDurationMs).toBeCloseTo((100 + 300 + 500) / 3);
    });

    it("computes p95 for a larger dataset", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 99_999 });
      // 20 events: 1..20ms
      for (let i = 1; i <= 20; i++) monitor.recordEvent("op", i * 10);

      const { metrics } = monitor.getSlaReport();
      expect(metrics[0]!.p95DurationMs).toBeGreaterThan(0);
    });

    it("includes generatedAt timestamp", () => {
      const monitor = new EnterpriseSlaMonitor();
      const before = Date.now();
      const report = monitor.getSlaReport();
      const after = Date.now();

      expect(report.generatedAt).toBeGreaterThanOrEqual(before);
      expect(report.generatedAt).toBeLessThanOrEqual(after);
    });
  });

  // ── clearEvents() ─────────────────────────────────────────────────────────

  describe("clearEvents()", () => {
    it("removes all events but keeps SLA definitions", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 100 });
      monitor.recordEvent("op", 999);
      monitor.clearEvents();

      expect(monitor.getViolations()).toHaveLength(0);
      expect(monitor.getSlaReport().metrics[0]!.totalEvents).toBe(0);
    });
  });

  // ── deregisterSla() ───────────────────────────────────────────────────────

  describe("deregisterSla()", () => {
    it("removes the SLA and its events", () => {
      const monitor = new EnterpriseSlaMonitor();
      monitor.registerSla({ name: "op", thresholdMs: 100 });
      monitor.recordEvent("op", 999);
      monitor.deregisterSla("op");

      expect(monitor.getSlaReport().metrics).toHaveLength(0);
      expect(monitor.getViolations("op")).toHaveLength(0);
      expect(monitor.recordEvent("op", 1)).toBeNull();
    });
  });
});
