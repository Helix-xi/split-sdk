/**
 * SDK Compliance Reporting Module
 *
 * Provides a self-contained SDK-level compliance reporter that aggregates rule
 * evaluations, tracks rule execution history, supports custom rule registries,
 * emits lifecycle events, and produces structured JSON / CSV reports.
 *
 * This builds on the lightweight `evaluateInvoice` helper in `compliance.ts`
 * and the `exportComplianceReport` utility in `complianceExporter.ts`,
 * adding:
 *
 * - A `ComplianceReporter` class with add/remove rule lifecycle
 * - Event emission for `rule:pass`, `rule:fail`, `report:generated`
 * - Historical report storage with optional max-size cap
 * - Structured JSON report output
 * - Convenience `formatSummary` helper
 *
 * Issue #962
 */

import type { Invoice } from "./types.js";
import type { ComplianceRule } from "./compliance.js";
import { defaultRules } from "./compliance.js";
import { TypedEventEmitter } from "./events/TypedEventEmitter.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Individual rule result within a report entry. */
export interface RuleResult {
  /** Rule identifier. */
  name: string;
  /** Whether the rule passed. */
  passed: boolean;
  /** Descriptive message (populated for failures). */
  message: string;
  /** Wall-clock time taken to evaluate this rule, in milliseconds. */
  durationMs: number;
}

/** A full compliance evaluation report for a single invoice. */
export interface ComplianceReportEntry {
  /** Invoice that was evaluated. */
  invoiceId: string;
  /** Unix timestamp (ms) when the evaluation ran. */
  evaluatedAt: number;
  /** Ordered list of rule evaluation results. */
  rules: RuleResult[];
  /** `true` when all rules passed. */
  passed: boolean;
  /** Number of rules that failed. */
  failureCount: number;
  /** Total evaluation time in milliseconds (sum of all rule durations). */
  totalDurationMs: number;
}

/** Summary statistics computed across a batch of report entries. */
export interface ComplianceSummary {
  /** Total number of invoices evaluated. */
  total: number;
  /** Invoices where all rules passed. */
  passed: number;
  /** Invoices with at least one failing rule. */
  failed: number;
  /** Pass rate expressed as a percentage (0–100). */
  passRate: number;
  /** Most frequently failing rule names, ordered by failure count descending. */
  topFailingRules: Array<{ name: string; failures: number }>;
}

/** Events emitted by {@link ComplianceReporter}. */
export interface ComplianceReporterEvents {
  /** Emitted each time a rule passes for an invoice. */
  "rule:pass": { invoiceId: string; ruleName: string };
  /** Emitted each time a rule fails for an invoice. */
  "rule:fail": { invoiceId: string; ruleName: string; message: string };
  /** Emitted after a full report entry is generated. */
  "report:generated": ComplianceReportEntry;
}

/** Options for {@link ComplianceReporter}. */
export interface ComplianceReporterOptions {
  /**
   * Maximum number of entries to keep in history.
   * Oldest entries are evicted when the cap is exceeded.
   * Defaults to `Infinity` (unlimited).
   */
  maxHistorySize?: number;
}

// ---------------------------------------------------------------------------
// ComplianceReporter
// ---------------------------------------------------------------------------

/**
 * Stateful SDK compliance reporter.
 *
 * Register custom rules (or rely on the built-in defaults), evaluate invoices,
 * observe per-rule events, and produce structured reports.
 *
 * @example
 * ```ts
 * const reporter = new ComplianceReporter();
 *
 * reporter.on("rule:fail", ({ invoiceId, ruleName, message }) => {
 *   console.warn(`Invoice ${invoiceId} failed rule ${ruleName}: ${message}`);
 * });
 *
 * const entry = reporter.evaluate(invoice);
 * console.log(entry.passed, entry.failureCount);
 *
 * const summary = reporter.summary();
 * console.log(summary.passRate);
 * ```
 */
export class ComplianceReporter extends TypedEventEmitter<ComplianceReporterEvents> {
  private _rules: Map<string, ComplianceRule> = new Map();
  private _history: ComplianceReportEntry[] = [];
  private readonly _maxHistorySize: number;

  constructor(options: ComplianceReporterOptions = {}) {
    super();
    this._maxHistorySize = options.maxHistorySize ?? Infinity;

    // Pre-populate with default rules
    for (const rule of defaultRules()) {
      this._rules.set(rule.name, rule);
    }
  }

  // -------------------------------------------------------------------------
  // Rule management
  // -------------------------------------------------------------------------

  /**
   * Register a custom compliance rule (or overwrite an existing one by name).
   *
   * @param rule - A {@link ComplianceRule} to add to this reporter.
   */
  addRule(rule: ComplianceRule): this {
    this._rules.set(rule.name, rule);
    return this;
  }

  /**
   * Remove a rule by name. No-op if the rule is not registered.
   *
   * @param name - The `ComplianceRule.name` to remove.
   */
  removeRule(name: string): this {
    this._rules.delete(name);
    return this;
  }

  /**
   * Return all currently registered rules (insertion order).
   */
  getRules(): ComplianceRule[] {
    return [...this._rules.values()];
  }

  /**
   * Check whether a rule with the given name is registered.
   */
  hasRule(name: string): boolean {
    return this._rules.has(name);
  }

  /**
   * Replace all registered rules with the provided list.
   *
   * @param rules - New set of rules.
   */
  setRules(rules: ComplianceRule[]): this {
    this._rules.clear();
    for (const rule of rules) {
      this._rules.set(rule.name, rule);
    }
    return this;
  }

  // -------------------------------------------------------------------------
  // Evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluate all registered rules against `invoice`, emit per-rule events,
   * store the entry in history, and return the full report entry.
   *
   * @param invoice - The invoice to evaluate.
   */
  evaluate(invoice: Invoice): ComplianceReportEntry {
    const invoiceId = invoice.id;
    const evaluatedAt = Date.now();
    const results: RuleResult[] = [];

    for (const rule of this._rules.values()) {
      const start = performance.now();
      let passed = false;
      try {
        passed = rule.check(invoice);
      } catch {
        passed = false;
      }
      const durationMs = performance.now() - start;

      results.push({
        name: rule.name,
        passed,
        message: passed ? "" : rule.message,
        durationMs,
      });

      if (passed) {
        this.emit("rule:pass", { invoiceId, ruleName: rule.name });
      } else {
        this.emit("rule:fail", {
          invoiceId,
          ruleName: rule.name,
          message: rule.message,
        });
      }
    }

    const failureCount = results.filter((r) => !r.passed).length;
    const totalDurationMs = results.reduce((acc, r) => acc + r.durationMs, 0);

    const entry: ComplianceReportEntry = {
      invoiceId,
      evaluatedAt,
      rules: results,
      passed: failureCount === 0,
      failureCount,
      totalDurationMs,
    };

    this._addToHistory(entry);
    this.emit("report:generated", entry);

    return entry;
  }

  /**
   * Evaluate all rules against each invoice in the batch.
   *
   * @param invoices - Invoices to evaluate.
   * @returns One {@link ComplianceReportEntry} per invoice.
   */
  evaluateBatch(invoices: Invoice[]): ComplianceReportEntry[] {
    return invoices.map((inv) => this.evaluate(inv));
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  /**
   * Return a copy of the stored evaluation history.
   */
  getHistory(): ComplianceReportEntry[] {
    return [...this._history];
  }

  /**
   * Clear the stored evaluation history.
   */
  clearHistory(): void {
    this._history = [];
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  /**
   * Compute aggregate statistics across all stored history entries.
   *
   * @returns {@link ComplianceSummary} covering the full history.
   */
  summary(): ComplianceSummary {
    return computeSummary(this._history);
  }

  /**
   * Export the history as a JSON string suitable for persistence or API responses.
   *
   * @param pretty - If `true`, output is pretty-printed (2-space indent).
   */
  exportJSON(pretty = false): string {
    return JSON.stringify(
      this._history.map((entry) => ({
        ...entry,
        // bigint isn't JSON-serialisable — convert via toString()
        rules: entry.rules,
      })),
      null,
      pretty ? 2 : undefined,
    );
  }

  /**
   * Return a human-readable one-paragraph summary of the most recent history.
   */
  formatSummary(): string {
    const s = this.summary();
    if (s.total === 0) return "No compliance evaluations recorded.";

    const lines: string[] = [
      `Compliance Summary: ${s.passed}/${s.total} invoices passed (${s.passRate.toFixed(1)}%).`,
    ];

    if (s.topFailingRules.length > 0) {
      const ruleList = s.topFailingRules
        .map((r) => `  • ${r.name} (${r.failures} failure${r.failures !== 1 ? "s" : ""})`)
        .join("\n");
      lines.push(`Top failing rules:\n${ruleList}`);
    }

    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _addToHistory(entry: ComplianceReportEntry): void {
    this._history.push(entry);
    while (
      isFinite(this._maxHistorySize) &&
      this._history.length > this._maxHistorySize
    ) {
      this._history.shift();
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers
// ---------------------------------------------------------------------------

/**
 * Compute aggregate summary statistics from an array of compliance report entries.
 * Can be used independently of {@link ComplianceReporter}.
 *
 * @param entries - Report entries to summarise.
 */
export function computeSummary(
  entries: ComplianceReportEntry[],
): ComplianceSummary {
  const total = entries.length;
  if (total === 0) {
    return { total: 0, passed: 0, failed: 0, passRate: 0, topFailingRules: [] };
  }

  let passed = 0;
  const failureCounts = new Map<string, number>();

  for (const entry of entries) {
    if (entry.passed) {
      passed++;
    }
    for (const rule of entry.rules) {
      if (!rule.passed) {
        failureCounts.set(rule.name, (failureCounts.get(rule.name) ?? 0) + 1);
      }
    }
  }

  const topFailingRules = [...failureCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, failures]) => ({ name, failures }));

  return {
    total,
    passed,
    failed: total - passed,
    passRate: (passed / total) * 100,
    topFailingRules,
  };
}

/**
 * Produce a flat CSV string from an array of compliance report entries.
 * One row per rule result per entry.
 *
 * @param entries - Report entries to export.
 */
export function exportComplianceReportToCSV(
  entries: ComplianceReportEntry[],
): string {
  const header = "invoiceId,evaluatedAt,ruleName,passed,message,durationMs";
  const rows = entries.flatMap((entry) =>
    entry.rules.map(
      (rule) =>
        `${entry.invoiceId},${entry.evaluatedAt},${rule.name},${rule.passed},${csvEscape(rule.message)},${rule.durationMs.toFixed(3)}`,
    ),
  );
  return [header, ...rows].join("\n");
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
