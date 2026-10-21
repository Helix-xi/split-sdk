/**
 * Advanced invoice analytics engine.
 *
 * Provides deep analytics over a collection of invoices including payer
 * rankings, funding trend analysis, status breakdowns, and period-based
 * revenue aggregation. Supports event callbacks for when analytics are ready.
 */

import type { Invoice } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Aggregated analytics for a single payer address. */
export interface PayerAnalytics {
  /** Payer's Stellar address. */
  address: string;
  /** Total amount paid in stroops across all invoices. */
  totalPaid: bigint;
  /** Number of individual payments made. */
  paymentCount: number;
  /** Number of distinct invoices this payer contributed to. */
  invoiceCount: number;
}

/** Funding trend data point for a time bucket. */
export interface FundingTrendPoint {
  /** Start of the time bucket (Unix seconds). */
  periodStart: number;
  /** End of the time bucket (Unix seconds). */
  periodEnd: number;
  /** Total amount funded in stroops within this bucket. */
  totalFunded: bigint;
  /** Number of payments in this bucket. */
  paymentCount: number;
}

/** Distribution of invoices across statuses. */
export interface StatusBreakdown {
  /** Status label (e.g. "Pending", "Released", "Refunded"). */
  status: string;
  /** Number of invoices with this status. */
  count: number;
  /** Fraction of the total (0–1). */
  fraction: number;
}

/** Revenue aggregated over a calendar period. */
export interface RevenuePeriod {
  /** Start of the period (Unix seconds). */
  periodStart: number;
  /** End of the period (Unix seconds). */
  periodEnd: number;
  /** Total revenue (funded) in stroops for this period. */
  revenue: bigint;
  /** Number of invoices that received payments in this period. */
  invoiceCount: number;
}

/** Top-level analytics report produced by {@link InvoiceAnalyticsEngine.analyze}. */
export interface AnalyticsReport {
  /** Total number of invoices analysed. */
  invoiceCount: number;
  /** Total funded amount across all invoices in stroops. */
  totalFunded: bigint;
  /** Total owed amount across all invoices in stroops. */
  totalOwed: bigint;
  /** Overall funding completion in basis points (0–10 000). */
  completionBps: number;
  /** Unique payer count across all invoices. */
  uniquePayers: number;
  /** Total payment count across all invoices. */
  totalPayments: number;
  /** Average funded amount per invoice in stroops. */
  avgFundedPerInvoice: bigint;
  /** Top payer by total amount paid. */
  topPayer: PayerAnalytics | null;
  /** Status breakdown. */
  statusBreakdown: StatusBreakdown[];
}

/** Callback invoked when an analytics computation completes. */
export type AnalyticsReadyCallback = (report: AnalyticsReport) => void;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Advanced invoice analytics engine.
 *
 * Accumulates analytics from one or more invoice collections and fires
 * registered callbacks when a computation is completed.
 *
 * @example
 * ```ts
 * const engine = new InvoiceAnalyticsEngine();
 * engine.onAnalyticsReady((report) => console.log(report));
 * const report = engine.analyze(invoices);
 * ```
 */
export class InvoiceAnalyticsEngine {
  private readonly _callbacks: AnalyticsReadyCallback[] = [];

  // ---------------------------------------------------------------------------
  // Event registration
  // ---------------------------------------------------------------------------

  /**
   * Register a callback to be invoked after each call to {@link analyze}.
   *
   * Multiple callbacks can be registered and will all be called in registration
   * order. Returns an `unsubscribe` function.
   *
   * @param callback - Function to invoke with the completed analytics report.
   * @returns A function that removes this callback when called.
   */
  onAnalyticsReady(callback: AnalyticsReadyCallback): () => void {
    this._callbacks.push(callback);
    return () => {
      const idx = this._callbacks.indexOf(callback);
      if (idx !== -1) this._callbacks.splice(idx, 1);
    };
  }

  // ---------------------------------------------------------------------------
  // Core analytics
  // ---------------------------------------------------------------------------

  /**
   * Compute a comprehensive analytics report over a set of invoices.
   *
   * All registered `onAnalyticsReady` callbacks are invoked synchronously
   * with the result before it is returned.
   *
   * @param invoices - The invoices to analyse.
   * @returns A complete {@link AnalyticsReport}.
   */
  analyze(invoices: Invoice[]): AnalyticsReport {
    if (invoices.length === 0) {
      const empty: AnalyticsReport = {
        invoiceCount: 0,
        totalFunded: 0n,
        totalOwed: 0n,
        completionBps: 0,
        uniquePayers: 0,
        totalPayments: 0,
        avgFundedPerInvoice: 0n,
        topPayer: null,
        statusBreakdown: [],
      };
      this._emit(empty);
      return empty;
    }

    let totalFunded = 0n;
    let totalOwed = 0n;
    let totalPayments = 0;

    const payerMap = new Map<string, PayerAnalytics>();
    const statusMap = new Map<string, number>();

    for (const invoice of invoices) {
      const owed = invoice.recipients.reduce((s, r) => s + r.amount, 0n);
      totalOwed += owed;
      totalFunded += invoice.funded;

      // Status breakdown
      statusMap.set(invoice.status, (statusMap.get(invoice.status) ?? 0) + 1);

      // Payer aggregation
      const invoicePayers = new Set<string>();
      for (const payment of invoice.payments) {
        totalPayments++;
        invoicePayers.add(payment.payer);

        const existing = payerMap.get(payment.payer);
        if (existing) {
          existing.totalPaid += payment.amount;
          existing.paymentCount++;
        } else {
          payerMap.set(payment.payer, {
            address: payment.payer,
            totalPaid: payment.amount,
            paymentCount: 1,
            invoiceCount: 0,
          });
        }
      }

      // Increment invoiceCount per payer for each invoice they touched
      for (const payer of invoicePayers) {
        const entry = payerMap.get(payer);
        if (entry) entry.invoiceCount++;
      }
    }

    // Status breakdown
    const statusBreakdown: StatusBreakdown[] = [];
    for (const [status, count] of statusMap) {
      statusBreakdown.push({
        status,
        count,
        fraction: count / invoices.length,
      });
    }
    statusBreakdown.sort((a, b) => b.count - a.count);

    // Top payer
    let topPayer: PayerAnalytics | null = null;
    for (const payer of payerMap.values()) {
      if (!topPayer || payer.totalPaid > topPayer.totalPaid) {
        topPayer = payer;
      }
    }

    const completionBps =
      totalOwed > 0n
        ? Number((totalFunded * 10_000n) / totalOwed > 10_000n ? 10_000n : (totalFunded * 10_000n) / totalOwed)
        : 0;

    const report: AnalyticsReport = {
      invoiceCount: invoices.length,
      totalFunded,
      totalOwed,
      completionBps,
      uniquePayers: payerMap.size,
      totalPayments,
      avgFundedPerInvoice: totalFunded / BigInt(invoices.length),
      topPayer,
      statusBreakdown,
    };

    this._emit(report);
    return report;
  }

  /**
   * Return the top-N payers by total amount paid across all invoices.
   *
   * @param invoices - The invoices to analyse.
   * @param n        - Maximum number of payers to return (default 10).
   * @returns Payer analytics sorted descending by total amount paid.
   */
  getTopPayers(invoices: Invoice[], n = 10): PayerAnalytics[] {
    const payerMap = new Map<string, PayerAnalytics>();

    for (const invoice of invoices) {
      const invoicePayers = new Set<string>();
      for (const payment of invoice.payments) {
        invoicePayers.add(payment.payer);
        const existing = payerMap.get(payment.payer);
        if (existing) {
          existing.totalPaid += payment.amount;
          existing.paymentCount++;
        } else {
          payerMap.set(payment.payer, {
            address: payment.payer,
            totalPaid: payment.amount,
            paymentCount: 1,
            invoiceCount: 0,
          });
        }
      }
      for (const payer of invoicePayers) {
        const entry = payerMap.get(payer);
        if (entry) entry.invoiceCount++;
      }
    }

    return [...payerMap.values()]
      .sort((a, b) => (a.totalPaid > b.totalPaid ? -1 : a.totalPaid < b.totalPaid ? 1 : 0))
      .slice(0, n);
  }

  /**
   * Compute a funding trend by bucketing payments into equal time windows.
   *
   * Returns one {@link FundingTrendPoint} per bucket. Payments without
   * timestamps are excluded.
   *
   * @param invoices    - The invoices to analyse.
   * @param buckets     - Number of time buckets to divide the range into (default 7).
   * @returns Array of trend points ordered by time, or `[]` when there are no
   *          timestamped payments.
   */
  getFundingTrend(invoices: Invoice[], buckets = 7): FundingTrendPoint[] {
    // Collect all timestamped payments
    type TimedPayment = { timestamp: number; amount: bigint };
    const payments: TimedPayment[] = [];

    for (const invoice of invoices) {
      for (const p of invoice.payments) {
        if (typeof p.timestamp === "number") {
          payments.push({ timestamp: p.timestamp, amount: p.amount });
        }
      }
    }

    if (payments.length === 0) return [];

    const minTs = Math.min(...payments.map((p) => p.timestamp));
    const maxTs = Math.max(...payments.map((p) => p.timestamp));

    // Avoid zero-width range
    const range = maxTs > minTs ? maxTs - minTs : 1;
    const bucketSize = range / buckets;

    const points: FundingTrendPoint[] = Array.from({ length: buckets }, (_, i) => ({
      periodStart: Math.floor(minTs + i * bucketSize),
      periodEnd: Math.floor(minTs + (i + 1) * bucketSize),
      totalFunded: 0n,
      paymentCount: 0,
    }));

    for (const { timestamp, amount } of payments) {
      const idx = Math.min(
        Math.floor(((timestamp - minTs) / range) * buckets),
        buckets - 1,
      );
      points[idx]!.totalFunded += amount;
      points[idx]!.paymentCount++;
    }

    return points;
  }

  /**
   * Compute the distribution of invoices by status.
   *
   * @param invoices - The invoices to analyse.
   * @returns Status breakdown sorted by count descending.
   */
  getStatusBreakdown(invoices: Invoice[]): StatusBreakdown[] {
    if (invoices.length === 0) return [];

    const statusMap = new Map<string, number>();
    for (const invoice of invoices) {
      statusMap.set(invoice.status, (statusMap.get(invoice.status) ?? 0) + 1);
    }

    const breakdown: StatusBreakdown[] = [];
    for (const [status, count] of statusMap) {
      breakdown.push({ status, count, fraction: count / invoices.length });
    }

    return breakdown.sort((a, b) => b.count - a.count);
  }

  /**
   * Aggregate revenue (funded amounts) by fixed-duration calendar periods.
   *
   * Uses `invoice.deadline` as the reference timestamp for assigning an
   * invoice to a period. Invoices with `deadline <= 0` are skipped.
   *
   * @param invoices   - The invoices to analyse.
   * @param periodDays - Duration of each period in days (default 30).
   * @returns Revenue periods ordered by start time ascending, or `[]` when
   *          there are no invoices with usable deadlines.
   */
  getRevenueByPeriod(invoices: Invoice[], periodDays = 30): RevenuePeriod[] {
    const valid = invoices.filter((inv) => inv.deadline > 0);
    if (valid.length === 0) return [];

    const periodSec = periodDays * 86_400;
    const minTs = Math.min(...valid.map((inv) => inv.deadline));
    const maxTs = Math.max(...valid.map((inv) => inv.deadline));

    const buckets = Math.ceil((maxTs - minTs) / periodSec) || 1;
    const periods: RevenuePeriod[] = Array.from({ length: buckets }, (_, i) => ({
      periodStart: Math.floor(minTs + i * periodSec),
      periodEnd: Math.floor(minTs + (i + 1) * periodSec),
      revenue: 0n,
      invoiceCount: 0,
    }));

    for (const invoice of valid) {
      const idx = Math.min(
        Math.floor((invoice.deadline - minTs) / periodSec),
        buckets - 1,
      );
      periods[idx]!.revenue += invoice.funded;
      periods[idx]!.invoiceCount++;
    }

    return periods;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _emit(report: AnalyticsReport): void {
    for (const cb of this._callbacks) {
      cb(report);
    }
  }
}
