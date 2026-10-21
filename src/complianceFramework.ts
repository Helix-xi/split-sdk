/**
 * SDK compliance framework.
 *
 * Extends the basic compliance utilities in `compliance.ts` with a full
 * framework: a pluggable rule engine, detailed per-invoice violation records,
 * real-time violation callbacks, and JSON / CSV report export.
 *
 * Built-in rules cover deadline validation, amount validation, recipient
 * validation, and duplicate payment detection. Custom rules can be added with
 * {@link ComplianceFramework.registerRule}.
 */

import type { Invoice } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Severity level of a compliance rule. */
export type ComplianceRuleSeverity = "error" | "warning" | "info";

/** A compliance rule that can be evaluated against an invoice. */
export interface ComplianceRule {
  /** Unique identifier for this rule. */
  id: string;
  /** Short human-readable name. */
  name: string;
  /** Long description of what the rule checks. */
  description: string;
  /**
   * Evaluate the rule against an invoice.
   * Return `true` when the invoice passes; `false` or a non-empty string
   * (used as the violation detail) when it fails.
   */
  check(invoice: Invoice): boolean | string;
  /** How severe a failure is. Defaults to `"error"` when omitted. */
  severity?: ComplianceRuleSeverity;
}

/** A single violation detail within a compliance check result. */
export interface ComplianceViolation {
  /** The ID of the rule that was violated. */
  ruleId: string;
  /** Rule name at the time of the violation. */
  ruleName: string;
  /** Human-readable detail about what failed. */
  detail: string;
  /** Severity of the violated rule. */
  severity: ComplianceRuleSeverity;
}

/** Result of running all rules against a single invoice. */
export interface InvoiceComplianceResult {
  /** The invoice ID. */
  invoiceId: string;
  /** Whether all rules passed for this invoice. */
  passed: boolean;
  /** List of violations, empty when `passed` is `true`. */
  violations: ComplianceViolation[];
  /** Unix millisecond timestamp when the check was performed. */
  checkedAt: number;
}

/** Aggregated compliance report across a collection of invoices. */
export interface ComplianceReport {
  /** Per-invoice check results. */
  results: InvoiceComplianceResult[];
  /** Total number of invoices checked. */
  totalInvoices: number;
  /** Number of invoices that passed all rules. */
  passedCount: number;
  /** Number of invoices that failed at least one rule. */
  failedCount: number;
  /** Overall pass rate (0–1). */
  passRate: number;
  /** Total violation count across all invoices and rules. */
  totalViolations: number;
  /** Unix millisecond timestamp when the report was generated. */
  generatedAt: number;
}

/** Callback invoked for each invoice that fails at least one rule. */
export type ViolationCallback = (result: InvoiceComplianceResult) => void;

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

/**
 * Return the set of built-in compliance rules.
 *
 * Built-in rules:
 * - `deadline.valid` — deadline must be in the future.
 * - `amount.positive` — total recipient amount must be > 0.
 * - `recipients.nonEmpty` — invoice must have at least one recipient.
 * - `payments.noDuplicates` — no two payments from the same payer in the same
 *   ledger sequence.
 */
export function builtInRules(): ComplianceRule[] {
  return [
    {
      id: "deadline.valid",
      name: "Deadline must be in the future",
      description: "The invoice deadline (Unix seconds) must be greater than the current time.",
      severity: "error",
      check(invoice: Invoice): boolean | string {
        const nowSec = Math.floor(Date.now() / 1000);
        if (invoice.deadline <= nowSec) {
          return `deadline ${invoice.deadline} is in the past (now=${nowSec})`;
        }
        return true;
      },
    },
    {
      id: "amount.positive",
      name: "Total amount must be positive",
      description: "The sum of all recipient amounts must be greater than zero.",
      severity: "error",
      check(invoice: Invoice): boolean | string {
        const total = invoice.recipients.reduce((s, r) => s + r.amount, 0n);
        if (total <= 0n) {
          return `total recipient amount is ${total}, must be > 0`;
        }
        return true;
      },
    },
    {
      id: "recipients.nonEmpty",
      name: "Invoice must have at least one recipient",
      description: "An invoice with no recipients cannot be funded.",
      severity: "error",
      check(invoice: Invoice): boolean | string {
        if (invoice.recipients.length === 0) {
          return "invoice has no recipients";
        }
        return true;
      },
    },
    {
      id: "payments.noDuplicates",
      name: "No duplicate payments",
      description:
        "No two payments should originate from the same payer in the same ledger sequence.",
      severity: "warning",
      check(invoice: Invoice): boolean | string {
        const seen = new Map<string, number[]>();
        for (const payment of invoice.payments) {
          if (payment.ledger === undefined) continue;
          const key = payment.payer;
          const ledgers = seen.get(key) ?? [];
          if (ledgers.includes(payment.ledger)) {
            return `payer ${payment.payer} has duplicate payment at ledger ${payment.ledger}`;
          }
          ledgers.push(payment.ledger);
          seen.set(key, ledgers);
        }
        return true;
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Framework
// ---------------------------------------------------------------------------

/**
 * Pluggable SDK compliance framework.
 *
 * Register built-in or custom rules, run checks against a collection of
 * invoices, subscribe to real-time violation events, and export the results
 * as JSON or CSV.
 *
 * @example
 * ```ts
 * const framework = new ComplianceFramework();
 * framework.loadBuiltInRules();
 * framework.onViolation((result) => logger.warn("Violation", result));
 *
 * const report = framework.runChecks(invoices);
 * console.log(`Pass rate: ${(report.passRate * 100).toFixed(1)}%`);
 *
 * const csv = framework.exportReport("csv");
 * ```
 */
export class ComplianceFramework {
  private readonly _rules = new Map<string, ComplianceRule>();
  private readonly _callbacks: ViolationCallback[] = [];
  private _lastReport: ComplianceReport | null = null;

  // ---------------------------------------------------------------------------
  // Rule management
  // ---------------------------------------------------------------------------

  /**
   * Register a custom compliance rule.
   *
   * If a rule with the same `id` was already registered it is replaced.
   *
   * @param rule - The rule to register.
   */
  registerRule(rule: ComplianceRule): void {
    this._rules.set(rule.id, { ...rule, severity: rule.severity ?? "error" });
  }

  /**
   * Load all built-in rules into the framework.
   *
   * Existing rules with the same IDs are replaced.
   */
  loadBuiltInRules(): void {
    for (const rule of builtInRules()) {
      this.registerRule(rule);
    }
  }

  /**
   * Remove a rule by ID.
   *
   * @param ruleId - The rule to remove.
   */
  deregisterRule(ruleId: string): void {
    this._rules.delete(ruleId);
  }

  /**
   * Return a copy of all currently registered rules.
   */
  getRules(): ComplianceRule[] {
    return [...this._rules.values()];
  }

  // ---------------------------------------------------------------------------
  // Compliance checks
  // ---------------------------------------------------------------------------

  /**
   * Run all registered rules against each invoice in the collection.
   *
   * Registered `onViolation` callbacks are invoked synchronously for each
   * invoice that fails at least one rule. The resulting report is stored
   * internally and can be retrieved later with {@link getReport}.
   *
   * @param invoices - The invoices to check.
   * @returns A {@link ComplianceReport} covering all checked invoices.
   */
  runChecks(invoices: Invoice[]): ComplianceReport {
    const rules = [...this._rules.values()];
    const results: InvoiceComplianceResult[] = [];

    for (const invoice of invoices) {
      const violations: ComplianceViolation[] = [];

      for (const rule of rules) {
        let outcome: boolean | string;
        try {
          outcome = rule.check(invoice);
        } catch (err) {
          outcome = `rule threw: ${err instanceof Error ? err.message : String(err)}`;
        }

        if (outcome !== true) {
          violations.push({
            ruleId: rule.id,
            ruleName: rule.name,
            detail:
              typeof outcome === "string"
                ? outcome
                : rule.description,
            severity: rule.severity ?? "error",
          });
        }
      }

      const result: InvoiceComplianceResult = {
        invoiceId: invoice.id,
        passed: violations.length === 0,
        violations,
        checkedAt: Date.now(),
      };

      results.push(result);

      if (!result.passed) {
        for (const cb of this._callbacks) {
          cb(result);
        }
      }
    }

    const passedCount = results.filter((r) => r.passed).length;
    const failedCount = results.length - passedCount;
    const totalViolations = results.reduce((s, r) => s + r.violations.length, 0);

    const report: ComplianceReport = {
      results,
      totalInvoices: invoices.length,
      passedCount,
      failedCount,
      passRate: invoices.length > 0 ? passedCount / invoices.length : 1,
      totalViolations,
      generatedAt: Date.now(),
    };

    this._lastReport = report;
    return report;
  }

  /**
   * Return the last report produced by {@link runChecks}, or `null` if no
   * checks have been run yet.
   */
  getReport(): ComplianceReport | null {
    return this._lastReport;
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  /**
   * Export the last compliance report in JSON or CSV format.
   *
   * @param format - `"json"` for a formatted JSON string; `"csv"` for CSV.
   * @returns The serialized report string, or `""` when no report exists.
   */
  exportReport(format: "json" | "csv"): string {
    if (!this._lastReport) return "";

    if (format === "json") {
      return JSON.stringify(this._lastReport, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      , 2);
    }

    // CSV export
    const lines: string[] = [
      "invoiceId,passed,violationCount,ruleId,ruleName,detail,severity,checkedAt",
    ];

    for (const result of this._lastReport.results) {
      if (result.violations.length === 0) {
        lines.push(
          [
            result.invoiceId,
            "true",
            "0",
            "",
            "",
            "",
            "",
            String(result.checkedAt),
          ].join(",")
        );
      } else {
        for (const v of result.violations) {
          lines.push(
            [
              result.invoiceId,
              "false",
              String(result.violations.length),
              v.ruleId,
              csvEscape(v.ruleName),
              csvEscape(v.detail),
              v.severity,
              String(result.checkedAt),
            ].join(",")
          );
        }
      }
    }

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Event handling
  // ---------------------------------------------------------------------------

  /**
   * Register a callback invoked for each invoice that fails at least one rule.
   *
   * @param callback - Called synchronously with the failing {@link InvoiceComplianceResult}.
   * @returns An `unsubscribe` function.
   */
  onViolation(callback: ViolationCallback): () => void {
    this._callbacks.push(callback);
    return () => {
      const idx = this._callbacks.indexOf(callback);
      if (idx !== -1) this._callbacks.splice(idx, 1);
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
