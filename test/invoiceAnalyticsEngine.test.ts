import { describe, expect, it, vi } from "vitest";
import {
  InvoiceAnalyticsEngine,
} from "../src/invoiceAnalyticsEngine.js";
import type { Invoice } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "1",
    creator: "GCREATOR",
    recipients: [{ address: "GRECIP", amount: 1_000n }],
    token: "USDC",
    deadline: 2_000_000_000,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InvoiceAnalyticsEngine", () => {
  // ── analyze() ─────────────────────────────────────────────────────────────

  describe("analyze()", () => {
    it("returns zeroed report for empty input", () => {
      const engine = new InvoiceAnalyticsEngine();
      const report = engine.analyze([]);

      expect(report.invoiceCount).toBe(0);
      expect(report.totalFunded).toBe(0n);
      expect(report.totalOwed).toBe(0n);
      expect(report.completionBps).toBe(0);
      expect(report.uniquePayers).toBe(0);
      expect(report.totalPayments).toBe(0);
      expect(report.avgFundedPerInvoice).toBe(0n);
      expect(report.topPayer).toBeNull();
      expect(report.statusBreakdown).toEqual([]);
    });

    it("aggregates totals correctly", () => {
      const engine = new InvoiceAnalyticsEngine();
      const invoices: Invoice[] = [
        makeInvoice({
          id: "1",
          funded: 600n,
          recipients: [{ address: "R1", amount: 1_000n }],
          payments: [{ payer: "P1", amount: 600n, timestamp: 1000 }],
        }),
        makeInvoice({
          id: "2",
          funded: 400n,
          recipients: [{ address: "R2", amount: 1_000n }],
          payments: [{ payer: "P2", amount: 400n, timestamp: 2000 }],
        }),
      ];

      const report = engine.analyze(invoices);

      expect(report.invoiceCount).toBe(2);
      expect(report.totalFunded).toBe(1_000n);
      expect(report.totalOwed).toBe(2_000n);
      expect(report.completionBps).toBe(5_000); // 50%
      expect(report.uniquePayers).toBe(2);
      expect(report.totalPayments).toBe(2);
      expect(report.avgFundedPerInvoice).toBe(500n);
    });

    it("identifies the top payer correctly", () => {
      const engine = new InvoiceAnalyticsEngine();
      const invoices: Invoice[] = [
        makeInvoice({
          id: "1",
          funded: 900n,
          payments: [
            { payer: "PBIG", amount: 800n },
            { payer: "PSMALL", amount: 100n },
          ],
        }),
        makeInvoice({
          id: "2",
          funded: 200n,
          payments: [{ payer: "PBIG", amount: 200n }],
        }),
      ];

      const report = engine.analyze(invoices);

      expect(report.topPayer?.address).toBe("PBIG");
      expect(report.topPayer?.totalPaid).toBe(1_000n);
      expect(report.topPayer?.paymentCount).toBe(2);
      expect(report.topPayer?.invoiceCount).toBe(2);
    });

    it("builds correct status breakdown with fractions", () => {
      const engine = new InvoiceAnalyticsEngine();
      const invoices: Invoice[] = [
        makeInvoice({ id: "1", status: "Pending" }),
        makeInvoice({ id: "2", status: "Pending" }),
        makeInvoice({ id: "3", status: "Released" }),
        makeInvoice({ id: "4", status: "Refunded" }),
      ];

      const report = engine.analyze(invoices);
      const pending = report.statusBreakdown.find((s) => s.status === "Pending")!;
      const released = report.statusBreakdown.find((s) => s.status === "Released")!;

      expect(pending.count).toBe(2);
      expect(pending.fraction).toBeCloseTo(0.5);
      expect(released.count).toBe(1);
      expect(released.fraction).toBeCloseTo(0.25);
    });

    it("completionBps caps at 10 000 when overfunded", () => {
      const engine = new InvoiceAnalyticsEngine();
      const invoices: Invoice[] = [
        makeInvoice({
          id: "1",
          funded: 2_000n,
          recipients: [{ address: "R1", amount: 1_000n }],
        }),
      ];

      const report = engine.analyze(invoices);
      expect(report.completionBps).toBe(10_000);
    });
  });

  // ── onAnalyticsReady() ────────────────────────────────────────────────────

  describe("onAnalyticsReady()", () => {
    it("fires callback after analyze()", () => {
      const engine = new InvoiceAnalyticsEngine();
      const cb = vi.fn();
      engine.onAnalyticsReady(cb);

      const invoices = [makeInvoice()];
      const report = engine.analyze(invoices);

      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith(report);
    });

    it("fires multiple callbacks in registration order", () => {
      const engine = new InvoiceAnalyticsEngine();
      const order: number[] = [];
      engine.onAnalyticsReady(() => order.push(1));
      engine.onAnalyticsReady(() => order.push(2));
      engine.onAnalyticsReady(() => order.push(3));

      engine.analyze([]);

      expect(order).toEqual([1, 2, 3]);
    });

    it("unsubscribe removes the callback", () => {
      const engine = new InvoiceAnalyticsEngine();
      const cb = vi.fn();
      const unsub = engine.onAnalyticsReady(cb);

      unsub();
      engine.analyze([]);

      expect(cb).not.toHaveBeenCalled();
    });

    it("fires callback even for empty invoice list", () => {
      const engine = new InvoiceAnalyticsEngine();
      const cb = vi.fn();
      engine.onAnalyticsReady(cb);
      engine.analyze([]);
      expect(cb).toHaveBeenCalledOnce();
    });
  });

  // ── getTopPayers() ────────────────────────────────────────────────────────

  describe("getTopPayers()", () => {
    it("returns empty array for invoices with no payments", () => {
      const engine = new InvoiceAnalyticsEngine();
      expect(engine.getTopPayers([makeInvoice()])).toEqual([]);
    });

    it("returns payers sorted by totalPaid descending", () => {
      const engine = new InvoiceAnalyticsEngine();
      const invoices: Invoice[] = [
        makeInvoice({
          id: "1",
          payments: [
            { payer: "PA", amount: 300n },
            { payer: "PB", amount: 700n },
          ],
        }),
      ];

      const top = engine.getTopPayers(invoices);
      expect(top[0]!.address).toBe("PB");
      expect(top[1]!.address).toBe("PA");
    });

    it("limits results to n", () => {
      const engine = new InvoiceAnalyticsEngine();
      const payments = Array.from({ length: 10 }, (_, i) => ({
        payer: `P${i}`,
        amount: BigInt(i + 1) * 100n,
      }));
      const invoices = [makeInvoice({ id: "1", payments })];

      expect(engine.getTopPayers(invoices, 3)).toHaveLength(3);
    });

    it("aggregates payments from the same payer across invoices", () => {
      const engine = new InvoiceAnalyticsEngine();
      const invoices: Invoice[] = [
        makeInvoice({ id: "1", payments: [{ payer: "P1", amount: 500n }] }),
        makeInvoice({ id: "2", payments: [{ payer: "P1", amount: 500n }] }),
      ];

      const top = engine.getTopPayers(invoices);
      expect(top[0]!.totalPaid).toBe(1_000n);
      expect(top[0]!.invoiceCount).toBe(2);
    });
  });

  // ── getFundingTrend() ─────────────────────────────────────────────────────

  describe("getFundingTrend()", () => {
    it("returns empty array when no timestamped payments exist", () => {
      const engine = new InvoiceAnalyticsEngine();
      const invoices = [makeInvoice({ payments: [{ payer: "P", amount: 100n }] })];
      expect(engine.getFundingTrend(invoices)).toEqual([]);
    });

    it("returns correct number of buckets", () => {
      const engine = new InvoiceAnalyticsEngine();
      const invoices: Invoice[] = [
        makeInvoice({
          payments: [
            { payer: "P", amount: 100n, timestamp: 1000 },
            { payer: "P", amount: 100n, timestamp: 2000 },
            { payer: "P", amount: 100n, timestamp: 3000 },
          ],
        }),
      ];

      expect(engine.getFundingTrend(invoices, 3)).toHaveLength(3);
    });

    it("places a single payment in a single bucket", () => {
      const engine = new InvoiceAnalyticsEngine();
      const invoices = [
        makeInvoice({ payments: [{ payer: "P", amount: 500n, timestamp: 1000 }] }),
      ];

      const trend = engine.getFundingTrend(invoices, 5);
      const total = trend.reduce((s, p) => s + p.totalFunded, 0n);
      expect(total).toBe(500n);
    });

    it("distributes payments to correct buckets", () => {
      const engine = new InvoiceAnalyticsEngine();
      // Two payments: one at start of range, one at end
      const invoices: Invoice[] = [
        makeInvoice({
          payments: [
            { payer: "P", amount: 100n, timestamp: 0 },
            { payer: "P", amount: 200n, timestamp: 1000 },
          ],
        }),
      ];

      const trend = engine.getFundingTrend(invoices, 2);
      expect(trend).toHaveLength(2);
      // All amounts accounted for
      const total = trend.reduce((s, p) => s + p.totalFunded, 0n);
      expect(total).toBe(300n);
    });
  });

  // ── getStatusBreakdown() ──────────────────────────────────────────────────

  describe("getStatusBreakdown()", () => {
    it("returns empty array for empty input", () => {
      const engine = new InvoiceAnalyticsEngine();
      expect(engine.getStatusBreakdown([])).toEqual([]);
    });

    it("counts each status correctly", () => {
      const engine = new InvoiceAnalyticsEngine();
      const invoices = [
        makeInvoice({ status: "Pending" }),
        makeInvoice({ status: "Pending" }),
        makeInvoice({ status: "Released" }),
      ];

      const breakdown = engine.getStatusBreakdown(invoices);
      const pending = breakdown.find((b) => b.status === "Pending")!;
      expect(pending.count).toBe(2);
      expect(pending.fraction).toBeCloseTo(2 / 3);
    });

    it("sorts by count descending", () => {
      const engine = new InvoiceAnalyticsEngine();
      const invoices = [
        makeInvoice({ status: "Refunded" }),
        makeInvoice({ status: "Pending" }),
        makeInvoice({ status: "Pending" }),
        makeInvoice({ status: "Pending" }),
      ];

      const breakdown = engine.getStatusBreakdown(invoices);
      expect(breakdown[0]!.status).toBe("Pending");
    });
  });

  // ── getRevenueByPeriod() ──────────────────────────────────────────────────

  describe("getRevenueByPeriod()", () => {
    it("returns empty array for empty input", () => {
      const engine = new InvoiceAnalyticsEngine();
      expect(engine.getRevenueByPeriod([])).toEqual([]);
    });

    it("aggregates revenue into periods", () => {
      const engine = new InvoiceAnalyticsEngine();
      const DAY = 86_400;
      const baseTs = 1_700_000_000;

      const invoices: Invoice[] = [
        makeInvoice({ id: "1", deadline: baseTs, funded: 500n }),
        makeInvoice({ id: "2", deadline: baseTs + 5 * DAY, funded: 300n }),
        makeInvoice({ id: "3", deadline: baseTs + 35 * DAY, funded: 200n }),
      ];

      const periods = engine.getRevenueByPeriod(invoices, 30);

      // First period should contain invoices 1 and 2 (days 0 and 5)
      expect(periods[0]!.revenue).toBe(800n);
      expect(periods[0]!.invoiceCount).toBe(2);
    });

    it("skips invoices with zero deadline", () => {
      const engine = new InvoiceAnalyticsEngine();
      const invoices = [makeInvoice({ deadline: 0, funded: 999n })];
      expect(engine.getRevenueByPeriod(invoices)).toEqual([]);
    });

    it("uses periodDays parameter", () => {
      const engine = new InvoiceAnalyticsEngine();
      const DAY = 86_400;
      const base = 1_700_000_000;
      const invoices: Invoice[] = [
        makeInvoice({ id: "1", deadline: base, funded: 100n }),
        makeInvoice({ id: "2", deadline: base + 8 * DAY, funded: 200n }),
      ];

      // 7-day periods → invoices fall in different periods
      const periods = engine.getRevenueByPeriod(invoices, 7);
      const totalRevenue = periods.reduce((s, p) => s + p.revenue, 0n);
      expect(totalRevenue).toBe(300n);
    });
  });
});
