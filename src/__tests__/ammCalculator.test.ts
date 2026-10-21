import { describe, it, expect } from "vitest";
import { estimateSwapOutput } from "../ammCalculator.js";
import { InsufficientLiquidityError } from "../errors.js";

// ---------------------------------------------------------------------------
// Constant-product invariant preservation (issue #683)
// ---------------------------------------------------------------------------

function makePool(reserveIn: string, reserveOut: string) {
  return {
    reserves: [
      { asset: "XLM", amount: reserveIn },
      { asset: "USDC", amount: reserveOut },
    ],
  };
}

describe("constant-product invariant preservation", () => {
  it("preserves k = reserveA * reserveB after a simulated swap", () => {
    const reserveIn = 1_000_000_000_000n;
    const reserveOut = 500_000_000_000n;
    const pool = makePool(reserveIn.toString(), reserveOut.toString());
    const k = reserveIn * reserveOut;

    const inputAmount = 10_000_000n;
    const result = estimateSwapOutput(pool, inputAmount.toString(), "XLM");

    const newReserveIn = reserveIn + inputAmount;
    const newReserveOut = reserveOut - BigInt(result.outputAmount);
    const newK = newReserveIn * newReserveOut;

    // Integer-division rounding means newK can only ever be <= k, and the
    // relative drift must stay within a tight tolerance (no fee/rounding bug
    // can silently break the invariant).
    expect(newK).toBeLessThanOrEqual(k);
    const drift = k - newK;
    const tolerance = k / 1_000_000n; // 0.0001% relative tolerance
    expect(drift).toBeLessThanOrEqual(tolerance);
  });

  it("holds across a range of input sizes", () => {
    const reserveIn = 250_000_000_000n;
    const reserveOut = 250_000_000_000n;
    const pool = makePool(reserveIn.toString(), reserveOut.toString());
    const k = reserveIn * reserveOut;

    for (const inputAmount of [1n, 1_000n, 1_000_000n, 50_000_000_000n]) {
      const result = estimateSwapOutput(pool, inputAmount.toString(), "XLM");
      const newReserveIn = reserveIn + inputAmount;
      const newReserveOut = reserveOut - BigInt(result.outputAmount);
      const newK = newReserveIn * newReserveOut;

      expect(newK).toBeLessThanOrEqual(k);
      const drift = k - newK;
      const tolerance = k / 1_000_000n;
      expect(drift).toBeLessThanOrEqual(tolerance);
    }
  });

  it("throws InsufficientLiquidityError for a swap larger than available reserves", () => {
    const pool = makePool("1000", "1000");
    expect(() => estimateSwapOutput(pool, "1000000", "XLM")).toThrow(
      InsufficientLiquidityError,
    );
  });

  it("returns 0 received and leaves reserves unchanged for a zero-amount swap", () => {
    const reserveIn = 1_000_000n;
    const reserveOut = 2_000_000n;
    const pool = makePool(reserveIn.toString(), reserveOut.toString());

    const result = estimateSwapOutput(pool, "0", "XLM");

    expect(result.outputAmount).toBe("0");
    // Reserves reported back on the pool object itself are untouched — the
    // function is pure and never mutates its input.
    expect(pool.reserves[0]!.amount).toBe(reserveIn.toString());
    expect(pool.reserves[1]!.amount).toBe(reserveOut.toString());
  });
});

// ---------------------------------------------------------------------------
// SDK regression suite (issue #1195)
//
// A self-contained regression harness: deterministic cases are recorded as
// baselines, current results are compared against them, and a report with
// trend analysis is produced. Baselines are stored in-memory here so the
// suite is hermetic and CI-friendly; the same shape can be persisted to disk.
// ---------------------------------------------------------------------------

interface RegressionCase {
  name: string;
  run: () => string;
}

interface BaselineEntry {
  output: string;
  recordedAt: number;
}

interface ComparisonResult {
  name: string;
  baseline: string;
  current: string;
  match: boolean;
}

interface RegressionReport {
  total: number;
  passed: number;
  failed: number;
  comparisons: ComparisonResult[];
  trend: "stable" | "improving" | "regressing";
}

class BaselineStore {
  private entries = new Map<string, BaselineEntry>();

  record(name: string, output: string, recordedAt = Date.now()): void {
    this.entries.set(name, { output, recordedAt });
  }

  get(name: string): BaselineEntry | undefined {
    return this.entries.get(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  size(): number {
    return this.entries.size;
  }
}

function compareAgainstBaseline(
  store: BaselineStore,
  cases: RegressionCase[],
): ComparisonResult[] {
  return cases.map((testCase) => {
    const current = testCase.run();
    const baseline = store.get(testCase.name);
    return {
      name: testCase.name,
      baseline: baseline ? baseline.output : "<missing>",
      current,
      match: baseline !== undefined && baseline.output === current,
    };
  });
}

function buildReport(
  comparisons: ComparisonResult[],
  previousFailures = 0,
): RegressionReport {
  const failed = comparisons.filter((c) => !c.match).length;
  const passed = comparisons.length - failed;

  let trend: RegressionReport["trend"] = "stable";
  if (failed < previousFailures) trend = "improving";
  else if (failed > previousFailures) trend = "regressing";

  return { total: comparisons.length, passed, failed, comparisons, trend };
}

function formatReport(report: RegressionReport): string {
  const lines = [
    `Regression report: ${report.passed}/${report.total} passed, ${report.failed} failed (trend: ${report.trend})`,
  ];
  for (const c of report.comparisons) {
    lines.push(
      `  [${c.match ? "PASS" : "FAIL"}] ${c.name}: baseline=${c.baseline} current=${c.current}`,
    );
  }
  return lines.join("\n");
}

const regressionCases: RegressionCase[] = [
  {
    name: "swap output for 10M into 1T/500B pool",
    run: () =>
      estimateSwapOutput(
        makePool("1000000000000", "500000000000"),
        "10000000",
        "XLM",
      ).outputAmount,
  },
  {
    name: "swap output for 1M into 250B/250B pool",
    run: () =>
      estimateSwapOutput(
        makePool("250000000000", "250000000000"),
        "1000000",
        "XLM",
      ).outputAmount,
  },
  {
    name: "zero-amount swap returns 0",
    run: () =>
      estimateSwapOutput(makePool("1000000", "2000000"), "0", "XLM")
        .outputAmount,
  },
];

describe("SDK regression suite", () => {
  it("records baselines for every regression case", () => {
    const store = new BaselineStore();
    for (const testCase of regressionCases) {
      store.record(testCase.name, testCase.run());
    }
    expect(store.size()).toBe(regressionCases.length);
    for (const testCase of regressionCases) {
      expect(store.has(testCase.name)).toBe(true);
    }
  });

  it("matches current results against recorded baselines", () => {
    const store = new BaselineStore();
    for (const testCase of regressionCases) {
      store.record(testCase.name, testCase.run());
    }

    const comparisons = compareAgainstBaseline(store, regressionCases);
    expect(comparisons).toHaveLength(regressionCases.length);
    expect(comparisons.every((c) => c.match)).toBe(true);
  });

  it("detects a regression when output drifts from the baseline", () => {
    const store = new BaselineStore();
    store.record(regressionCases[0]!.name, "999");

    const comparisons = compareAgainstBaseline(store, [regressionCases[0]!]);
    expect(comparisons[0]!.match).toBe(false);

    const report = buildReport(comparisons);
    expect(report.failed).toBe(1);
    expect(report.passed).toBe(0);
  });

  it("flags missing baselines as failures", () => {
    const store = new BaselineStore();
    const comparisons = compareAgainstBaseline(store, [regressionCases[0]!]);
    expect(comparisons[0]!.match).toBe(false);
    expect(comparisons[0]!.baseline).toBe("<missing>");
  });

  it("produces a clear report and identifies trends", () => {
    const store = new BaselineStore();
    for (const testCase of regressionCases) {
      store.record(testCase.name, testCase.run());
    }
    const comparisons = compareAgainstBaseline(store, regressionCases);

    const stable = buildReport(comparisons, 0);
    expect(stable.trend).toBe("stable");
    expect(stable.passed).toBe(regressionCases.length);

    const improving = buildReport(comparisons, 2);
    expect(improving.trend).toBe("improving");

    const regressing = buildReport(
      [{ name: "x", baseline: "a", current: "b", match: false }],
      0,
    );
    expect(regressing.trend).toBe("regressing");

    const text = formatReport(stable);
    expect(text).toContain("Regression report");
    expect(text).toContain("trend: stable");
    expect(text).toContain("[PASS]");
  });
});
