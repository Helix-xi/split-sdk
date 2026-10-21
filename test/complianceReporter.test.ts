/**
 * Tests for #962 — SDK Compliance Reporting Module
 *
 * Verifies:
 * - Default rules are pre-registered
 * - Custom rule add/remove/set
 * - evaluate() produces correct RuleResult entries
 * - Events: rule:pass, rule:fail, report:generated
 * - Batch evaluation
 * - History management (get, clear, maxHistorySize cap)
 * - summary() statistics
 * - exportJSON() serialisation
 * - exportComplianceReportToCSV() helper
 * - computeSummary() standalone helper
 * - formatSummary() human-readable output
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ComplianceReporter,
  computeSummary,
  exportComplianceReportToCSV,
} from "../src/complianceReporter.js";
import type { ComplianceReportEntry } from "../src/complianceReporter.js";
import type { Invoice } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "1",
    creator: "GCREATOR000000000000000000000000000000000000000000000000",
    recipients: [
      {
        address: "GRECIPIENT0000000000000000000000000000000000000000000000",
        amount: 100n,
      },
    ],
    token: "USDC",
    deadline: Math.floor(Date.now() / 1000) + 86400 * 2, // 2 days from now
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule management
// ---------------------------------------------------------------------------

describe("ComplianceReporter — rule management", () => {
  it("pre-populates the default rules on construction", () => {
    const reporter = new ComplianceReporter();
    const rules = reporter.getRules();
    expect(rules.length).toBeGreaterThan(0);
  });

  it("addRule registers a custom rule", () => {
    const reporter = new ComplianceReporter();
    reporter.addRule({
      name: "custom_rule",
      message: "Custom rule failed",
      check: () => true,
    });
    expect(reporter.hasRule("custom_rule")).toBe(true);
  });

  it("addRule is chainable", () => {
    const reporter = new ComplianceReporter();
    const returned = reporter.addRule({ name: "r", message: "m", check: () => true });
    expect(returned).toBe(reporter);
  });

  it("removeRule removes an existing rule", () => {
    const reporter = new ComplianceReporter();
    reporter.addRule({ name: "to_remove", message: "Remove me", check: () => true });
    reporter.removeRule("to_remove");
    expect(reporter.hasRule("to_remove")).toBe(false);
  });

  it("removeRule is a no-op for unknown rule", () => {
    const reporter = new ComplianceReporter();
    expect(() => reporter.removeRule("nonexistent")).not.toThrow();
  });

  it("setRules replaces all rules", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([
      { name: "only_rule", message: "Only rule", check: () => true },
    ]);
    const rules = reporter.getRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe("only_rule");
  });

  it("hasRule returns false for unknown rules", () => {
    const reporter = new ComplianceReporter();
    expect(reporter.hasRule("does_not_exist")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluate()
// ---------------------------------------------------------------------------

describe("ComplianceReporter — evaluate()", () => {
  it("returns a ComplianceReportEntry with invoiceId matching the invoice", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([{ name: "always_pass", message: "", check: () => true }]);
    const entry = reporter.evaluate(makeInvoice({ id: "inv-42" }));
    expect(entry.invoiceId).toBe("inv-42");
  });

  it("marks the entry as passed when all rules pass", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([
      { name: "r1", message: "", check: () => true },
      { name: "r2", message: "", check: () => true },
    ]);
    const entry = reporter.evaluate(makeInvoice());
    expect(entry.passed).toBe(true);
    expect(entry.failureCount).toBe(0);
  });

  it("marks the entry as failed when any rule fails", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([
      { name: "pass", message: "", check: () => true },
      { name: "fail", message: "Deliberate failure", check: () => false },
    ]);
    const entry = reporter.evaluate(makeInvoice());
    expect(entry.passed).toBe(false);
    expect(entry.failureCount).toBe(1);
  });

  it("records durationMs for each rule (≥ 0)", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([{ name: "r", message: "", check: () => true }]);
    const entry = reporter.evaluate(makeInvoice());
    expect(entry.rules[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records evaluatedAt as a recent Unix ms timestamp", () => {
    const before = Date.now();
    const reporter = new ComplianceReporter();
    reporter.setRules([{ name: "r", message: "", check: () => true }]);
    const entry = reporter.evaluate(makeInvoice());
    const after = Date.now();
    expect(entry.evaluatedAt).toBeGreaterThanOrEqual(before);
    expect(entry.evaluatedAt).toBeLessThanOrEqual(after);
  });

  it("counts totalDurationMs as the sum of rule durations", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([
      { name: "r1", message: "", check: () => true },
      { name: "r2", message: "", check: () => false },
    ]);
    const entry = reporter.evaluate(makeInvoice());
    const expected = entry.rules.reduce((s, r) => s + r.durationMs, 0);
    expect(entry.totalDurationMs).toBeCloseTo(expected, 5);
  });

  it("treats a throwing rule as a failure", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([
      {
        name: "throws",
        message: "Error in rule",
        check: () => {
          throw new Error("boom");
        },
      },
    ]);
    const entry = reporter.evaluate(makeInvoice());
    expect(entry.passed).toBe(false);
    expect(entry.failureCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("ComplianceReporter — events", () => {
  it("emits rule:pass for passing rules", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([{ name: "pass_rule", message: "", check: () => true }]);
    const handler = vi.fn();
    reporter.on("rule:pass", handler);
    reporter.evaluate(makeInvoice({ id: "ev-inv" }));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "ev-inv", ruleName: "pass_rule" }),
    );
  });

  it("emits rule:fail for failing rules with the failure message", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([
      { name: "fail_rule", message: "Custom fail msg", check: () => false },
    ]);
    const handler = vi.fn();
    reporter.on("rule:fail", handler);
    reporter.evaluate(makeInvoice({ id: "fail-inv" }));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: "fail-inv",
        ruleName: "fail_rule",
        message: "Custom fail msg",
      }),
    );
  });

  it("emits report:generated after each evaluate() call", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([{ name: "r", message: "", check: () => true }]);
    const handler = vi.fn();
    reporter.on("report:generated", handler);
    reporter.evaluate(makeInvoice());
    expect(handler).toHaveBeenCalledOnce();
  });

  it("report:generated payload matches the returned entry", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([{ name: "r", message: "", check: () => true }]);
    let emittedEntry: ComplianceReportEntry | undefined;
    reporter.on("report:generated", (e) => { emittedEntry = e; });
    const returnedEntry = reporter.evaluate(makeInvoice());
    expect(emittedEntry).toEqual(returnedEntry);
  });
});

// ---------------------------------------------------------------------------
// Batch evaluation
// ---------------------------------------------------------------------------

describe("ComplianceReporter — evaluateBatch()", () => {
  it("returns one entry per invoice", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([{ name: "r", message: "", check: () => true }]);
    const invoices = [makeInvoice({ id: "a" }), makeInvoice({ id: "b" })];
    const entries = reporter.evaluateBatch(invoices);
    expect(entries).toHaveLength(2);
    expect(entries[0].invoiceId).toBe("a");
    expect(entries[1].invoiceId).toBe("b");
  });

  it("returns empty array for empty input", () => {
    const reporter = new ComplianceReporter();
    expect(reporter.evaluateBatch([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe("ComplianceReporter — history", () => {
  it("stores evaluated entries in history", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([{ name: "r", message: "", check: () => true }]);
    reporter.evaluate(makeInvoice({ id: "h1" }));
    reporter.evaluate(makeInvoice({ id: "h2" }));
    expect(reporter.getHistory()).toHaveLength(2);
  });

  it("getHistory returns a copy, not the internal array", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([{ name: "r", message: "", check: () => true }]);
    reporter.evaluate(makeInvoice());
    const h = reporter.getHistory();
    h.splice(0);
    expect(reporter.getHistory()).toHaveLength(1);
  });

  it("clearHistory empties the history", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([{ name: "r", message: "", check: () => true }]);
    reporter.evaluate(makeInvoice());
    reporter.clearHistory();
    expect(reporter.getHistory()).toHaveLength(0);
  });

  it("respects maxHistorySize by evicting oldest entries", () => {
    const reporter = new ComplianceReporter({ maxHistorySize: 2 });
    reporter.setRules([{ name: "r", message: "", check: () => true }]);
    reporter.evaluate(makeInvoice({ id: "1" }));
    reporter.evaluate(makeInvoice({ id: "2" }));
    reporter.evaluate(makeInvoice({ id: "3" }));
    const history = reporter.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].invoiceId).toBe("2");
    expect(history[1].invoiceId).toBe("3");
  });
});

// ---------------------------------------------------------------------------
// summary()
// ---------------------------------------------------------------------------

describe("ComplianceReporter — summary()", () => {
  it("returns zero stats for empty history", () => {
    const reporter = new ComplianceReporter();
    const s = reporter.summary();
    expect(s.total).toBe(0);
    expect(s.passRate).toBe(0);
  });

  it("calculates pass rate correctly", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([
      { name: "always_fail", message: "fail", check: () => false },
    ]);
    reporter.evaluate(makeInvoice({ id: "fail1" }));
    reporter.evaluate(makeInvoice({ id: "fail2" }));

    reporter.setRules([
      { name: "always_pass", message: "", check: () => true },
    ]);
    reporter.evaluate(makeInvoice({ id: "pass1" }));

    const s = reporter.summary();
    expect(s.total).toBe(3);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(2);
    expect(s.passRate).toBeCloseTo(33.33, 1);
  });

  it("lists top failing rules ordered by failure count", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([
      { name: "rule_a", message: "A", check: () => false },
      { name: "rule_b", message: "B", check: () => false },
    ]);
    reporter.evaluate(makeInvoice({ id: "1" }));
    reporter.evaluate(makeInvoice({ id: "2" }));
    reporter.setRules([{ name: "rule_b", message: "B", check: () => false }]);
    reporter.evaluate(makeInvoice({ id: "3" }));

    const s = reporter.summary();
    // rule_b failed 3 times, rule_a 2 times
    expect(s.topFailingRules[0].name).toBe("rule_b");
    expect(s.topFailingRules[0].failures).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// exportJSON() and exportComplianceReportToCSV()
// ---------------------------------------------------------------------------

describe("ComplianceReporter — exportJSON()", () => {
  it("produces valid JSON", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([{ name: "r", message: "", check: () => true }]);
    reporter.evaluate(makeInvoice());
    const json = reporter.exportJSON();
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("pretty-prints when pretty=true", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([{ name: "r", message: "", check: () => true }]);
    reporter.evaluate(makeInvoice());
    const pretty = reporter.exportJSON(true);
    expect(pretty).toContain("\n");
  });
});

describe("exportComplianceReportToCSV()", () => {
  it("includes CSV header row", () => {
    const csv = exportComplianceReportToCSV([]);
    expect(csv.startsWith("invoiceId,evaluatedAt,ruleName,passed,message,durationMs")).toBe(true);
  });

  it("produces one row per rule result per entry", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([
      { name: "r1", message: "", check: () => true },
      { name: "r2", message: "F", check: () => false },
    ]);
    const entry = reporter.evaluate(makeInvoice({ id: "csv-inv" }));
    const csv = exportComplianceReportToCSV([entry]);
    const lines = csv.split("\n");
    // header + 2 data rows
    expect(lines).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// computeSummary() standalone
// ---------------------------------------------------------------------------

describe("computeSummary()", () => {
  it("handles empty array", () => {
    const s = computeSummary([]);
    expect(s.total).toBe(0);
    expect(s.topFailingRules).toEqual([]);
  });

  it("handles all-passing entries", () => {
    const entries: ComplianceReportEntry[] = [
      {
        invoiceId: "a",
        evaluatedAt: Date.now(),
        rules: [{ name: "r", passed: true, message: "", durationMs: 0 }],
        passed: true,
        failureCount: 0,
        totalDurationMs: 0,
      },
    ];
    const s = computeSummary(entries);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(0);
    expect(s.passRate).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// formatSummary()
// ---------------------------------------------------------------------------

describe("ComplianceReporter — formatSummary()", () => {
  it("returns a helpful message for empty history", () => {
    const reporter = new ComplianceReporter();
    expect(reporter.formatSummary()).toContain("No compliance evaluations");
  });

  it("returns a summary containing pass rate", () => {
    const reporter = new ComplianceReporter();
    reporter.setRules([{ name: "r", message: "", check: () => true }]);
    reporter.evaluate(makeInvoice());
    const summary = reporter.formatSummary();
    expect(summary).toContain("100.0%");
  });
});
