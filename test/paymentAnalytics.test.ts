import { describe, it, expect } from "vitest";
import {
  PaymentAnalyticsEngine,
} from "../src/paymentAnalytics.js";
import type { Invoice } from "../src/types.js";

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv-1",
    creator: "GCREATOR",
    recipients: [{ address: "GRECIP", amount: 100_000_000n }],
    token: "USDC",
    deadline: Math.floor(Date.now() / 1000) + 86400,
    funded: 0n,
    status: "Pending",
    payments: [],
    createdAt: Date.now() - 100_000,
    ...overrides,
  };
}

describe("Payment Analytics (#1055)", () => {
  const engine = new PaymentAnalyticsEngine();

  describe("Analytics work & Data accurate", () => {
    it("handles empty invoice arrays gracefully", () => {
      const summary = engine.aggregate([]);
      expect(summary.totalInvoices).toBe(0);
      expect(summary.totalFunded).toBe(0n);
      expect(summary.totalTarget).toBe(0n);
      expect(summary.uniquePayers).toBe(0);
      expect(summary.fundingRatePercent).toBe(0);
      expect(summary.paymentStats.mean).toBe(0n);
    });

    it("aggregates volume, target, and basis points accurately", () => {
      const inv1 = makeInvoice({
        id: "1",
        recipients: [{ address: "R1", amount: 1_000_000n }],
        funded: 600_000n,
        payments: [{ payer: "P1", amount: 600_000n, timestamp: Date.now() }],
        status: "Pending",
      });
      const inv2 = makeInvoice({
        id: "2",
        recipients: [{ address: "R2", amount: 1_000_000n }],
        funded: 400_000n,
        payments: [{ payer: "P2", amount: 400_000n, timestamp: Date.now() }],
        status: "Released",
      });

      const summary = engine.aggregate([inv1, inv2]);

      expect(summary.totalInvoices).toBe(2);
      expect(summary.totalTarget).toBe(2_000_000n);
      expect(summary.totalFunded).toBe(1_000_000n);
      expect(summary.totalOutstanding).toBe(1_000_000n);
      expect(summary.fundingRateBps).toBe(5_000); // 50%
      expect(summary.fundingRatePercent).toBe(50);
      expect(summary.totalPayments).toBe(2);
      expect(summary.uniquePayers).toBe(2);
      expect(summary.paymentStats.min).toBe(400_000n);
      expect(summary.paymentStats.max).toBe(600_000n);
      expect(summary.paymentStats.mean).toBe(500_000n);
      expect(summary.paymentStats.median).toBe(500_000n);
    });

    it("aggregates payer statistics, ranking, and repeat payer rate", () => {
      const inv1 = makeInvoice({
        id: "1",
        payments: [
          { payer: "P1", amount: 100n, timestamp: 1000 },
          { payer: "P2", amount: 50n, timestamp: 2000 },
        ],
      });
      const inv2 = makeInvoice({
        id: "2",
        payments: [
          { payer: "P1", amount: 200n, timestamp: 3000 },
        ],
      });

      const payers = engine.aggregatePayers([inv1, inv2]);

      expect(payers.totalUniquePayers).toBe(2);
      expect(payers.repeatPayers).toBe(1); // P1 paid twice
      expect(payers.repeatPayerRate).toBe(50);
      expect(payers.topPayers[0]!.address).toBe("P1");
      expect(payers.topPayers[0]!.totalPaid).toBe(300n);
      expect(payers.topPayers[0]!.paymentCount).toBe(2);
      expect(payers.topPayers[0]!.invoiceCount).toBe(2);
      expect(payers.topPayers[1]!.address).toBe("P2");
      expect(payers.topPayers[1]!.totalPaid).toBe(50n);
    });

    it("aggregates time-series payment volume accurately", () => {
      const now = 1_700_000_000_000;
      const inv = makeInvoice({
        payments: [
          { payer: "P1", amount: 10_000_000n, timestamp: now },
          { payer: "P2", amount: 20_000_000n, timestamp: now + 3600 * 1000 },
        ],
      });

      const series = engine.aggregateTimeSeries([inv], { interval: "hour", bucketCount: 2 });
      expect(series).toHaveLength(2);
      expect(series[0]!.volume).toBe(10_000_000n);
      expect(series[1]!.volume).toBe(20_000_000n);
    });

    it("evaluates invoice health accurately", () => {
      const activeInv = makeInvoice({
        id: "active",
        funded: 50_000_000n,
        recipients: [{ address: "R1", amount: 100_000_000n }],
        deadline: Math.floor(Date.now() / 1000) + 100_000,
      });
      const completedInv = makeInvoice({
        id: "completed",
        status: "Released",
        funded: 100_000_000n,
        recipients: [{ address: "R1", amount: 100_000_000n }],
      });
      const overdueInv = makeInvoice({
        id: "overdue",
        status: "Pending",
        funded: 10n,
        recipients: [{ address: "R1", amount: 100_000_000n }],
        deadline: 1_000, // past
      });

      const records = engine.analyzeInvoicePerformance([activeInv, completedInv, overdueInv]);
      expect(records.find((r) => r.id === "active")?.health).toBe("on-track");
      expect(records.find((r) => r.id === "completed")?.health).toBe("completed");
      expect(records.find((r) => r.id === "overdue")?.health).toBe("overdue");
    });
  });

  describe("Visuals helpful", () => {
    it("renders ASCII bar charts with proper scaling", () => {
      const data = [
        { label: "Pending", value: 10 },
        { label: "Released", value: 20 },
      ];
      const chart = engine.renderAsciiBarChart(data, { width: 10 });
      expect(chart).toContain("Pending");
      expect(chart).toContain("Released");
      expect(chart).toContain("█");
    });

    it("generates sparklines across value ranges", () => {
      const sparkline = engine.renderSparkline([1, 2, 5, 10, 8, 3]);
      expect(sparkline.length).toBe(6);
      expect(sparkline).toContain("█");
    });

    it("exports structured chart data for frontend charting libraries", () => {
      const inv = makeInvoice({ status: "Released", funded: 100n });
      const summary = engine.aggregate([inv]);
      const chartData = engine.exportChartData(summary);

      expect(chartData.labels).toContain("Released");
      expect(chartData.datasets[0]!.data).toEqual([1]);
    });
  });

  describe("Reports clear", () => {
    it("generates a comprehensive report bundle", () => {
      const inv = makeInvoice({
        id: "inv-report",
        status: "Pending",
        funded: 50_000_000n,
        payments: [{ payer: "GADDR", amount: 50_000_000n, timestamp: Date.now() }],
      });
      const report = engine.generateReport([inv]);

      expect(report.summary.totalInvoices).toBe(1);
      expect(report.payers.totalUniquePayers).toBe(1);
      expect(report.invoices).toHaveLength(1);

      const text = engine.formatReport(report);
      expect(text).toContain("PAYMENT & PERFORMANCE REPORT");
      expect(text).toContain("Total Funded:");

      const json = engine.exportJson(report);
      expect(json).toContain('"totalInvoices": 1');

      const csv = engine.exportCsv(report);
      expect(csv).toContain("InvoiceId,Status,Token");
      expect(csv).toContain("inv-report,Pending,USDC");
    });
  });
});
