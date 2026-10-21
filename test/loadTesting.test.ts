import { describe, expect, it, vi } from "vitest";
import {
  LoadTester,
  computeLatencyStats,
  formatLoadTestReport,
} from "../src/loadTesting.js";

describe("LoadTester (Issue #982)", () => {
  it("computes accurate latency statistics and percentiles", () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const stats = computeLatencyStats(samples);

    expect(stats.min).toBe(10);
    expect(stats.max).toBe(100);
    expect(stats.mean).toBe(55);
    expect(stats.median).toBe(50);
    expect(stats.p90).toBe(90);
    expect(stats.p95).toBe(100);
    expect(stats.p99).toBe(100);
  });

  it("handles empty latency arrays gracefully", () => {
    const stats = computeLatencyStats([]);
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(0);
    expect(stats.mean).toBe(0);
  });

  it("executes tasks with concurrency and generates complete report", async () => {
    const tester = new LoadTester();
    let counter = 0;

    const report = await tester.run(
      {
        name: "Concurrent Invoice Processing",
        concurrency: 4,
        iterations: 20,
      },
      async () => {
        counter++;
        await new Promise((r) => setTimeout(r, 5));
        return counter;
      }
    );

    expect(counter).toBe(20);
    expect(report.totalIterations).toBe(20);
    expect(report.successCount).toBe(20);
    expect(report.failureCount).toBe(0);
    expect(report.errorRate).toBe(0);
    expect(report.concurrency).toBe(4);
    expect(report.throughputRps).toBeGreaterThan(0);
    expect(report.latency.min).toBeGreaterThan(0);
  });

  it("dispatches all lifecycle events properly", async () => {
    const tester = new LoadTester();
    const startListener = vi.fn();
    const iterStartListener = vi.fn();
    const iterEndListener = vi.fn();
    const errorListener = vi.fn();
    const completeListener = vi.fn();

    tester.on("start", startListener);
    tester.on("iterationStart", iterStartListener);
    tester.on("iterationEnd", iterEndListener);
    tester.on("error", errorListener);
    tester.on("complete", completeListener);

    await tester.run(
      {
        concurrency: 2,
        iterations: 4,
      },
      async ({ iteration }) => {
        if (iteration === 2) {
          throw new Error("Simulated failure");
        }
        return "ok";
      }
    );

    expect(startListener).toHaveBeenCalledTimes(1);
    expect(iterStartListener).toHaveBeenCalledTimes(4);
    expect(iterEndListener).toHaveBeenCalledTimes(4);
    expect(errorListener).toHaveBeenCalledTimes(1);
    expect(completeListener).toHaveBeenCalledTimes(1);
  });

  it("captures error breakdowns when iterations fail", async () => {
    const tester = new LoadTester();

    const report = await tester.run(
      {
        concurrency: 2,
        iterations: 10,
      },
      async ({ iteration }) => {
        if (iteration % 2 === 1) {
          throw new Error("Network timeout");
        }
      }
    );

    expect(report.totalIterations).toBe(10);
    expect(report.successCount).toBe(5);
    expect(report.failureCount).toBe(5);
    expect(report.errorRate).toBe(0.5);
    expect(report.errorBreakdown["Network timeout"]).toBe(5);
  });

  it("respects durationMs limit", async () => {
    const tester = new LoadTester();

    const report = await tester.run(
      {
        concurrency: 2,
        durationMs: 50,
      },
      async () => {
        await new Promise((r) => setTimeout(r, 10));
      }
    );

    expect(report.totalIterations).toBeGreaterThan(0);
    expect(report.durationMs).toBeGreaterThanOrEqual(45);
  });

  it("formats human-readable report string", async () => {
    const tester = new LoadTester();

    const report = await tester.run(
      {
        name: "Benchmark Scenario",
        concurrency: 1,
        iterations: 2,
      },
      async () => "ok"
    );

    const formatted = formatLoadTestReport(report);
    expect(formatted).toContain("Benchmark Scenario");
    expect(formatted).toContain("Total Operations: 2");
    expect(formatted).toContain("ops/sec");
  });

  it("allows removing event listeners with off()", async () => {
    const tester = new LoadTester();
    const listener = vi.fn();

    tester.on("start", listener);
    tester.off("start", listener);

    await tester.run({ iterations: 1 }, async () => {});

    expect(listener).not.toHaveBeenCalled();
  });
});
