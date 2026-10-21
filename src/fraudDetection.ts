/**
 * FraudDetectionIntegration — pluggable fraud-detection layer for the
 * StellarSplit SDK.
 *
 * Analyses payment and invoice events in real-time, emits typed fraud events,
 * and exposes a composable rule engine so host applications can extend the
 * built-in checks with domain-specific rules without modifying SDK internals.
 *
 * Issue #973 — Add SDK fraud detection integration.
 */

import type { Payment } from "./types.js";
import type { ContractEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Severity level of a detected fraud signal. */
export type FraudSeverity = "low" | "medium" | "high" | "critical";

/** Categories of built-in fraud checks. */
export type FraudCheckKind =
  | "VELOCITY_BREACH"
  | "DUPLICATE_PAYMENT"
  | "BLACKLISTED_ADDRESS"
  | "SUSPICIOUS_AMOUNT_PATTERN"
  | "RAPID_INVOICE_CHURN"
  | "STRUCTURING";

/** A single fraud signal raised by a check. */
export interface FraudSignal {
  /** The check that produced this signal. */
  kind: FraudCheckKind | string;
  /** Human-readable explanation. */
  reason: string;
  /** Severity of the signal. */
  severity: FraudSeverity;
  /** Unix timestamp (seconds) when the signal was produced. */
  detectedAt: number;
  /** Additional context emitted alongside the signal (address, amount, …). */
  context?: Record<string, unknown>;
}

/** Result of running all checks against a payment or event. */
export interface FraudAssessment {
  /** `true` when at least one signal was raised. */
  flagged: boolean;
  /** All signals raised during the assessment. */
  signals: FraudSignal[];
  /** Overall risk score in [0, 1]. Aggregated from per-signal severity weights. */
  riskScore: number;
}

/** Payment details used by fraud checks; invoiceId is required for duplicate detection. */
export type FraudPayment = Payment & { invoiceId?: string };

/** A pluggable fraud rule. Return a signal to flag the input, or `null` to pass. */
export interface FraudRule {
  /** Unique identifier for this rule (used in signal `kind`). */
  id: string;
  /** Check a payment and optionally return a signal. */
  checkPayment?(payment: FraudPayment, ctx: FraudRuleContext): FraudSignal | null;
  /** Check a contract event and optionally return a signal. */
  checkEvent?(event: ContractEvent, ctx: FraudRuleContext): FraudSignal | null;
}

/** Contextual information passed to rule checks. */
export interface FraudRuleContext {
  /** Current Unix time in seconds. */
  now: number;
  /** Retrieves recent payments for the given payer (within the detection window). */
  getRecentPayments(payer: string): readonly Payment[];
  /** Retrieves recent contract events for the given invoice ID. */
  getRecentEvents(invoiceId: string): readonly ContractEvent[];
  /** Returns `true` if the address appears on the configured blacklist. */
  isBlacklisted(address: string): boolean;
}

/** Event map for FraudDetectionIntegration. */
export interface FraudDetectionEvents {
  /** Emitted whenever an assessment flags a payment or event. */
  fraud: (assessment: FraudAssessment & { source: "payment" | "event" }) => void;
  /** Emitted after every assessment, flagged or not. */
  assessed: (assessment: FraudAssessment & { source: "payment" | "event" }) => void;
}

/** Configuration for the built-in checks. */
export interface FraudDetectionOptions {
  /**
   * Time window (seconds) used for velocity and pattern checks.
   * @default 3600
   */
  windowSeconds?: number;
  /**
   * Maximum number of payments allowed per payer per window before a
   * VELOCITY_BREACH is raised.
   * @default 20
   */
  maxPaymentsPerWindow?: number;
  /**
   * Payments below this amount (stroops) are considered "small".
   * Used for STRUCTURING detection.
   * @default 1_000_000n  (0.1 USDC)
   */
  smallPaymentThreshold?: bigint;
  /**
   * Number of small payments in the window before STRUCTURING is raised.
   * @default 5
   */
  structuringCount?: number;
  /**
   * Time (seconds) within which a duplicate payment to the same invoice by
   * the same payer is flagged as DUPLICATE_PAYMENT.
   * @default 60
   */
  duplicateWindowSeconds?: number;
  /**
   * Maximum invoice create→cancel/refund cycles per creator per window before
   * RAPID_INVOICE_CHURN is raised.
   * @default 5
   */
  maxChurnCycles?: number;
  /**
   * Seconds between invoice creation and cancellation to consider it a churn
   * cycle.
   * @default 300
   */
  churnCycleSeconds?: number;
  /** Addresses always treated as suspicious. */
  blacklist?: readonly string[];
  /** Additional custom rules. */
  rules?: readonly FraudRule[];
  /** Override the time source (Unix seconds). Useful in tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Severity weights (used for risk score aggregation)
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHT: Record<FraudSeverity, number> = {
  low: 0.15,
  medium: 0.35,
  high: 0.65,
  critical: 1.0,
};

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

interface TimedPayment extends FraudPayment {
  timestamp: number;
}

interface InvoiceLifecycleEvent {
  invoiceId: string;
  type: "created" | "refunded";
  creator: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// FraudDetectionIntegration
// ---------------------------------------------------------------------------

type Listener<T extends unknown[]> = (...args: T) => void;

/**
 * Core fraud-detection integration for the StellarSplit SDK.
 *
 * Maintains rolling windows of payment and event history per address and
 * invoice. Exposes `assessPayment` and `assessEvent` for synchronous checks.
 * Emits `fraud` whenever a flag is raised and `assessed` after every check.
 *
 * @example
 * ```ts
 * const fraud = new FraudDetectionIntegration({ blacklist: ["GBAD..."] });
 * fraud.on("fraud", ({ signals }) => console.warn("fraud!", signals));
 *
 * // In payment handler:
 * const result = fraud.assessPayment(payment);
 * if (result.flagged) { throw new Error("Payment blocked by fraud check"); }
 * ```
 */
export class FraudDetectionIntegration {
  private readonly windowSeconds: number;
  private readonly maxPaymentsPerWindow: number;
  private readonly smallPaymentThreshold: bigint;
  private readonly structuringCount: number;
  private readonly duplicateWindowSeconds: number;
  private readonly maxChurnCycles: number;
  private readonly churnCycleSeconds: number;
  private readonly blacklist: Set<string>;
  private readonly customRules: readonly FraudRule[];
  private readonly nowFn: () => number;

  /** Rolling payment history keyed by payer address. */
  private readonly paymentHistory = new Map<string, TimedPayment[]>();
  /** Rolling lifecycle events keyed by creator address. */
  private readonly lifecycleHistory = new Map<string, InvoiceLifecycleEvent[]>();
  /** Recent contract events keyed by invoiceId. */
  private readonly eventHistory = new Map<string, ContractEvent[]>();

  private readonly listeners = new Map<string, Listener<unknown[]>[]>();

  constructor(options: FraudDetectionOptions = {}) {
    this.windowSeconds = options.windowSeconds ?? 3600;
    this.maxPaymentsPerWindow = options.maxPaymentsPerWindow ?? 20;
    this.smallPaymentThreshold = options.smallPaymentThreshold ?? 1_000_000n;
    this.structuringCount = options.structuringCount ?? 5;
    this.duplicateWindowSeconds = options.duplicateWindowSeconds ?? 60;
    this.maxChurnCycles = options.maxChurnCycles ?? 5;
    this.churnCycleSeconds = options.churnCycleSeconds ?? 300;
    this.blacklist = new Set(options.blacklist ?? []);
    this.customRules = options.rules ?? [];
    this.nowFn = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Record a payment into the rolling history and return a fraud assessment.
   *
   * Built-in checks: VELOCITY_BREACH, DUPLICATE_PAYMENT, BLACKLISTED_ADDRESS,
   * STRUCTURING, SUSPICIOUS_AMOUNT_PATTERN.
   * Custom rules registered via `options.rules` are also evaluated.
   */
  assessPayment(payment: FraudPayment): FraudAssessment {
    const now = this.nowFn();
    this._recordPayment({ ...payment, timestamp: now });
    this._pruneOldPayments(payment.payer, now);

    const signals: FraudSignal[] = [];

    // Built-in checks
    signals.push(...this._checkVelocity(payment.payer, now));
    signals.push(...this._checkDuplicate(payment, now));
    signals.push(...this._checkBlacklist(payment.payer, now));
    signals.push(...this._checkStructuring(payment.payer, now));
    signals.push(...this._checkSuspiciousAmountPattern(payment.payer, now));

    // Custom rules
    const ctx = this._buildContext(now);
    for (const rule of this.customRules) {
      if (rule.checkPayment) {
        const sig = rule.checkPayment(payment, ctx);
        if (sig) signals.push(sig);
      }
    }

    const assessment: FraudAssessment & { source: "payment" } = {
      flagged: signals.length > 0,
      signals,
      riskScore: this._aggregateScore(signals),
      source: "payment",
    };

    this._emit("assessed", assessment);
    if (assessment.flagged) this._emit("fraud", assessment);

    return assessment;
  }

  /**
   * Record a contract event and return a fraud assessment.
   *
   * Built-in check: RAPID_INVOICE_CHURN (creator spins up and immediately
   * cancels/refunds many invoices in the window).
   * Custom rules registered via `options.rules` are also evaluated.
   */
  assessEvent(event: ContractEvent): FraudAssessment {
    const now = this.nowFn();
    this._recordEvent(event, now);

    const signals: FraudSignal[] = [];

    // Churn detection applies to refunds shortly after invoice creation.
    if (
      event.type === "refunded" &&
      typeof (event.data as { creator?: string }).creator === "string"
    ) {
      const creator = (event.data as { creator: string }).creator;
      signals.push(...this._checkChurn(creator, event.invoiceId, now));
    }

    // BLACKLISTED_ADDRESS check on any address-bearing field
    const addressFields: unknown[] = [
      (event.data as Record<string, unknown>)?.creator,
      (event.data as Record<string, unknown>)?.payer,
    ];
    for (const addr of addressFields) {
      if (typeof addr === "string" && this.blacklist.has(addr)) {
        signals.push({
          kind: "BLACKLISTED_ADDRESS",
          reason: `Address ${addr} is blacklisted`,
          severity: "critical",
          detectedAt: now,
          context: { address: addr },
        });
      }
    }

    // Custom rules
    const ctx = this._buildContext(now);
    for (const rule of this.customRules) {
      if (rule.checkEvent) {
        const sig = rule.checkEvent(event, ctx);
        if (sig) signals.push(sig);
      }
    }

    const assessment: FraudAssessment & { source: "event" } = {
      flagged: signals.length > 0,
      signals,
      riskScore: this._aggregateScore(signals),
      source: "event",
    };

    this._emit("assessed", assessment);
    if (assessment.flagged) this._emit("fraud", assessment);

    return assessment;
  }

  /**
   * Add an address to the runtime blacklist.
   * Takes effect immediately for all subsequent assessments.
   */
  addToBlacklist(address: string): void {
    this.blacklist.add(address);
  }

  /** Remove an address from the runtime blacklist. */
  removeFromBlacklist(address: string): void {
    this.blacklist.delete(address);
  }

  /** Returns `true` when `address` is on the active blacklist. */
  isBlacklisted(address: string): boolean {
    return this.blacklist.has(address);
  }

  /** Subscribe to a named event. Returns an unsubscribe function. */
  on<K extends keyof FraudDetectionEvents>(
    event: K,
    listener: FraudDetectionEvents[K],
  ): () => void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as Listener<unknown[]>);
    this.listeners.set(event, listeners);
    return () => this.off(event, listener);
  }

  /** Unsubscribe a listener. */
  off<K extends keyof FraudDetectionEvents>(
    event: K,
    listener: FraudDetectionEvents[K],
  ): void {
    const current = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      current.filter((l) => l !== (listener as Listener<unknown[]>)),
    );
  }

  // -------------------------------------------------------------------------
  // Built-in checks
  // -------------------------------------------------------------------------

  private _checkVelocity(payer: string, now: number): FraudSignal[] {
    const recent = this._getRecentPayments(payer, now);
    if (recent.length > this.maxPaymentsPerWindow) {
      return [
        {
          kind: "VELOCITY_BREACH",
          reason: `Payer ${payer} made ${recent.length} payments in the detection window (max ${this.maxPaymentsPerWindow})`,
          severity: "high",
          detectedAt: now,
          context: { payer, count: recent.length, window: this.windowSeconds },
        },
      ];
    }
    return [];
  }

  private _checkDuplicate(payment: FraudPayment, now: number): FraudSignal[] {
    if (payment.invoiceId === undefined) return [];
    const since = now - this.duplicateWindowSeconds;
    const recent = (this.paymentHistory.get(payment.payer) ?? []).filter(
      (p) => p.timestamp >= since && p.invoiceId === payment.invoiceId,
    );
    // More than one entry means at least one prior identical payment exists
    if (recent.length > 1) {
      return [
        {
          kind: "DUPLICATE_PAYMENT",
          reason: `Payer ${payment.payer} submitted duplicate payment to invoice ${payment.invoiceId}`,
          severity: "medium",
          detectedAt: now,
          context: { payer: payment.payer, invoiceId: payment.invoiceId },
        },
      ];
    }
    return [];
  }

  private _checkBlacklist(address: string, now: number): FraudSignal[] {
    if (this.blacklist.has(address)) {
      return [
        {
          kind: "BLACKLISTED_ADDRESS",
          reason: `Address ${address} is on the fraud blacklist`,
          severity: "critical",
          detectedAt: now,
          context: { address },
        },
      ];
    }
    return [];
  }

  private _checkStructuring(payer: string, now: number): FraudSignal[] {
    const recent = this._getRecentPayments(payer, now);
    const small = recent.filter((p) => p.amount < this.smallPaymentThreshold);
    if (small.length >= this.structuringCount) {
      return [
        {
          kind: "STRUCTURING",
          reason: `Payer ${payer} made ${small.length} small payments (< ${this.smallPaymentThreshold} stroops) — possible structuring`,
          severity: "high",
          detectedAt: now,
          context: { payer, smallCount: small.length, threshold: this.smallPaymentThreshold.toString() },
        },
      ];
    }
    return [];
  }

  private _checkSuspiciousAmountPattern(payer: string, now: number): FraudSignal[] {
    const recent = this._getRecentPayments(payer, now);
    if (recent.length < 3) return [];

    const amounts = recent.map((p) => Number(p.amount));
    const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    if (mean === 0) return [];
    const variance = amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length;
    const cv = Math.sqrt(variance) / mean;

    if (cv > 2.0) {
      return [
        {
          kind: "SUSPICIOUS_AMOUNT_PATTERN",
          reason: `Payment amounts for ${payer} show unusually high variance (CV=${cv.toFixed(2)})`,
          severity: "medium",
          detectedAt: now,
          context: { payer, cv },
        },
      ];
    }
    return [];
  }

  private _checkChurn(creator: string, invoiceId: string, now: number): FraudSignal[] {
    this._pruneOldLifecycle(creator, now);
    const events = this.lifecycleHistory.get(creator) ?? [];

    // Find the creation event for this invoice
    const created = events.find(
      (e) => e.invoiceId === invoiceId && e.type === "created",
    );
    if (created && now - created.timestamp <= this.churnCycleSeconds) {
      const cycles = events.filter(
        (e) => e.type === "refunded" && now - e.timestamp <= this.windowSeconds,
      );
      if (cycles.length >= this.maxChurnCycles) {
        return [
          {
            kind: "RAPID_INVOICE_CHURN",
            reason: `Creator ${creator} cycled ${cycles.length} invoices rapidly`,
            severity: "high",
            detectedAt: now,
            context: { creator, cycles: cycles.length },
          },
        ];
      }
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // History management
  // -------------------------------------------------------------------------

  private _recordPayment(payment: TimedPayment): void {
    const list = this.paymentHistory.get(payment.payer) ?? [];
    list.push(payment);
    this.paymentHistory.set(payment.payer, list);
  }

  private _pruneOldPayments(payer: string, now: number): void {
    const cutoff = now - this.windowSeconds;
    const list = this.paymentHistory.get(payer) ?? [];
    this.paymentHistory.set(payer, list.filter((p) => p.timestamp >= cutoff));
  }

  private _pruneOldLifecycle(creator: string, now: number): void {
    const cutoff = now - this.windowSeconds;
    const list = this.lifecycleHistory.get(creator) ?? [];
    this.lifecycleHistory.set(creator, list.filter((e) => e.timestamp >= cutoff));
  }

  private _recordEvent(event: ContractEvent, now: number): void {
    // Events per invoice
    const byInvoice = this.eventHistory.get(event.invoiceId) ?? [];
    byInvoice.push(event);
    this.eventHistory.set(event.invoiceId, byInvoice);

    // Lifecycle tracking
    if (event.type === "created" || event.type === "refunded") {
      const creator = (event.data as Record<string, unknown>)?.creator;
      if (typeof creator === "string") {
        const list = this.lifecycleHistory.get(creator) ?? [];
        list.push({
          invoiceId: event.invoiceId,
          type: event.type,
          creator,
          timestamp: now,
        });
        this.lifecycleHistory.set(creator, list);
      }
    }
  }

  private _getRecentPayments(payer: string, now: number): TimedPayment[] {
    const cutoff = now - this.windowSeconds;
    return (this.paymentHistory.get(payer) ?? []).filter((p) => p.timestamp >= cutoff);
  }

  // -------------------------------------------------------------------------
  // Risk score aggregation
  // -------------------------------------------------------------------------

  private _aggregateScore(signals: FraudSignal[]): number {
    if (signals.length === 0) return 0;
    // Max-pool severity weights; cap at 1.0
    const max = signals.reduce((m, s) => Math.max(m, SEVERITY_WEIGHT[s.severity] ?? 0), 0);
    return Math.min(max, 1.0);
  }

  // -------------------------------------------------------------------------
  // Context builder (for custom rules)
  // -------------------------------------------------------------------------

  private _buildContext(now: number): FraudRuleContext {
    return {
      now,
      getRecentPayments: (payer) => this._getRecentPayments(payer, now),
      getRecentEvents: (invoiceId) => this.eventHistory.get(invoiceId) ?? [],
      isBlacklisted: (addr) => this.blacklist.has(addr),
    };
  }

  // -------------------------------------------------------------------------
  // Tiny event emitter
  // -------------------------------------------------------------------------

  private _emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}
