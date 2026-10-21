import { describe, expect, it, vi } from "vitest";
import {
  ComplianceFramework,
  builtInRules,
} from "../src/complianceFramework.js";
import type { ComplianceRule, Invoice } from "../src/complianceFramework.js";
// Invoice type comes from types.ts
import type { Invoice as SdkInvoice } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUTURE_DEADLINE = Math.floor(Date.now() / 1000) + 86_400 * 30; // 30 days out
const PAST_DEADLINE = Math.floor(Date.now() / 1000) - 1;

function makeInvoice(overrides: Partial<SdkInvoice> = {}): SdkInvoice {
  return {
    id: "inv-1",
    creator: "GCREATOR",
    recipients: [{ address: "GRECIP", amount: 1_000n }],
    token: "USDC",
    deadline: FUTURE_DEADLINE,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

describe("builtInRules()", () => {
  it("returns four built-in rules", () => {
    expect(builtInRules()).toHaveLength(4);
  });

  it("rule IDs are stable", () => {
    const ids = builtInRules().map((r) => r.id);
    expect(ids).toContain("deadline.valid");
    expect(ids).toContain("amount.positive");
    expect(ids).toContain("recipients.nonEmpty");
    expect(ids).toContain("payments.noDuplicates");
  });

  describe("deadline.valid", () => {
    const rule = builtInRules().find((r) => r.id === "deadline.valid")!;

    it("passes when deadline is in the future", () => {
      expect(rule.check(makeInvoice())).toBe(true);
    });

    it("fails when deadline is in the past", () => {
      const result = rule.check(makeInvoice({ deadline: PAST_DEADLINE }));
      expect(result).not.toBe(true);
    });
  });

  describe("amount.positive", () => {
    const rule = builtInRules().find((r) => r.id === "amount.positive")!;

    it("passes when total amount > 0", () => {
      expect(rule.check(makeInvoice())).toBe(true);
    });

    it("fails when total amount is 0", () => {
      const result = rule.check(
        makeInvoice({ recipients: [{ address: "R", amount: 0n }] })
      );
      expect(result).not.toBe(true);
    });
  });

  describe("recipients.nonEmpty", () => {
    const rule = builtInRules().find((r) => r.id === "recipients.nonEmpty")!;

    it("passes when at least one recipient exists", () => {
      expect(rule.check(makeInvoice())).toBe(true);
    });

    it("fails when recipients array is empty", () => {
      expect(rule.check(makeInvoice({ recipients: [] }))).not.toBe(true);
    });
  });

  describe("payments.noDuplicates", () => {
    const rule = builtInRules().find((r) => r.id === "payments.noDuplicates")!;

    it("passes when no duplicate (payer, ledger) pairs", () => {
      const invoice = makeInvoice({
        payments: [
          { payer: "P1", amount: 100n, ledger: 1 },
          { payer: "P1", amount: 100n, ledger: 2 },
        ],
      });
      expect(rule.check(invoice)).toBe(true);
    });

    it("fails when the same payer has two payments in the same ledger", () => {
      const invoice = makeInvoice({
        payments: [
          { payer: "P1", amount: 100n, ledger: 5 },
          { payer: "P1", amount: 200n, ledger: 5 },
        ],
      });
      expect(rule.check(invoice)).not.toBe(true);
    });

    it("ignores payments without a ledger", () => {
      const invoice = makeInvoice({
        payments: [
          { payer: "P1", amount: 100n },
          { payer: "P1", amount: 100n },
        ],
      });
      expect(rule.check(invoice)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// ComplianceFramework
// ---------------------------------------------------------------------------

describe("ComplianceFramework", () => {
  // ── registerRule / loadBuiltInRules ───────────────────────────────────────

  describe("registerRule()", () => {
    it("registers a custom rule", () => {
      const fw = new ComplianceFramework();
      const rule: ComplianceRule = {
        id: "custom.rule",
        name: "Custom",
        description: "Always passes",
        check: () => true,
      };
      fw.registerRule(rule);
      expect(fw.getRules().find((r) => r.id === "custom.rule")).toBeDefined();
    });

    it("replaces an existing rule with the same id", () => {
      const fw = new ComplianceFramework();
      fw.registerRule({ id: "r", name: "Old", description: "", check: () => false });
      fw.registerRule({ id: "r", name: "New", description: "", check: () => true });

      const results = fw.runChecks([makeInvoice()]);
      expect(results.results[0]!.passed).toBe(true);
    });

    it("defaults severity to error when omitted", () => {
      const fw = new ComplianceFramework();
      fw.registerRule({ id: "r", name: "R", description: "", check: () => false });
      fw.runChecks([makeInvoice()]);
      const v = fw.getReport()!.results[0]!.violations[0]!;
      expect(v.severity).toBe("error");
    });
  });

  describe("loadBuiltInRules()", () => {
    it("registers all four built-in rules", () => {
      const fw = new ComplianceFramework();
      fw.loadBuiltInRules();
      expect(fw.getRules()).toHaveLength(4);
    });
  });

  describe("deregisterRule()", () => {
    it("removes the rule", () => {
      const fw = new ComplianceFramework();
      fw.loadBuiltInRules();
      fw.deregisterRule("deadline.valid");
      expect(fw.getRules().find((r) => r.id === "deadline.valid")).toBeUndefined();
    });
  });

  // ── runChecks() ───────────────────────────────────────────────────────────

  describe("runChecks()", () => {
    it("returns a zeroed report for empty invoice list", () => {
      const fw = new ComplianceFramework();
      fw.loadBuiltInRules();
      const report = fw.runChecks([]);

      expect(report.totalInvoices).toBe(0);
      expect(report.passedCount).toBe(0);
      expect(report.failedCount).toBe(0);
      expect(report.passRate).toBe(1);
      expect(report.totalViolations).toBe(0);
    });

    it("passes a compliant invoice", () => {
      const fw = new ComplianceFramework();
      fw.loadBuiltInRules();
      const report = fw.runChecks([makeInvoice()]);

      expect(report.passedCount).toBe(1);
      expect(report.failedCount).toBe(0);
      expect(report.passRate).toBe(1);
    });

    it("fails an invoice with expired deadline", () => {
      const fw = new ComplianceFramework();
      fw.loadBuiltInRules();
      const report = fw.runChecks([makeInvoice({ deadline: PAST_DEADLINE })]);

      expect(report.failedCount).toBe(1);
      const violations = report.results[0]!.violations;
      expect(violations.some((v) => v.ruleId === "deadline.valid")).toBe(true);
    });

    it("fails an invoice with no recipients", () => {
      const fw = new ComplianceFramework();
      fw.loadBuiltInRules();
      const report = fw.runChecks([makeInvoice({ recipients: [] })]);

      const violations = report.results[0]!.violations;
      expect(violations.some((v) => v.ruleId === "recipients.nonEmpty")).toBe(true);
      // amount.positive also fires because sum of [] = 0
      expect(violations.some((v) => v.ruleId === "amount.positive")).toBe(true);
    });

    it("counts totalViolations correctly", () => {
      const fw = new ComplianceFramework();
      fw.loadBuiltInRules();
      // Both deadline (past) and recipients (empty) will fail
      const report = fw.runChecks([
        makeInvoice({ deadline: PAST_DEADLINE, recipients: [] }),
      ]);
      expect(report.totalViolations).toBeGreaterThanOrEqual(2);
    });

    it("captures rule check errors as violations", () => {
      const fw = new ComplianceFramework();
      fw.registerRule({
        id: "throws.rule",
        name: "Throwing rule",
        description: "Always throws",
        check(): boolean {
          throw new Error("boom");
        },
      });

      const report = fw.runChecks([makeInvoice()]);
      const v = report.results[0]!.violations[0]!;
      expect(v.ruleId).toBe("throws.rule");
      expect(v.detail).toContain("boom");
    });

    it("sets checkedAt timestamp on each result", () => {
      const fw = new ComplianceFramework();
      const before = Date.now();
      const report = fw.runChecks([makeInvoice()]);
      const after = Date.now();

      expect(report.results[0]!.checkedAt).toBeGreaterThanOrEqual(before);
      expect(report.results[0]!.checkedAt).toBeLessThanOrEqual(after);
    });
  });

  // ── getReport() ───────────────────────────────────────────────────────────

  describe("getReport()", () => {
    it("returns null before any checks", () => {
      expect(new ComplianceFramework().getReport()).toBeNull();
    });

    it("returns the last report after runChecks", () => {
      const fw = new ComplianceFramework();
      const report = fw.runChecks([makeInvoice()]);
      expect(fw.getReport()).toBe(report);
    });
  });

  // ── onViolation() ─────────────────────────────────────────────────────────

  describe("onViolation()", () => {
    it("fires callback when an invoice fails a rule", () => {
      const fw = new ComplianceFramework();
      fw.registerRule({ id: "r", name: "R", description: "", check: () => false });
      const cb = vi.fn();
      fw.onViolation(cb);

      fw.runChecks([makeInvoice()]);

      expect(cb).toHaveBeenCalledOnce();
    });

    it("does NOT fire callback for passing invoices", () => {
      const fw = new ComplianceFramework();
      fw.registerRule({ id: "r", name: "R", description: "", check: () => true });
      const cb = vi.fn();
      fw.onViolation(cb);

      fw.runChecks([makeInvoice()]);
      expect(cb).not.toHaveBeenCalled();
    });

    it("unsubscribe prevents future calls", () => {
      const fw = new ComplianceFramework();
      fw.registerRule({ id: "r", name: "R", description: "", check: () => false });
      const cb = vi.fn();
      const unsub = fw.onViolation(cb);
      unsub();

      fw.runChecks([makeInvoice()]);
      expect(cb).not.toHaveBeenCalled();
    });

    it("fires once per failing invoice", () => {
      const fw = new ComplianceFramework();
      fw.registerRule({ id: "r", name: "R", description: "", check: () => false });
      const cb = vi.fn();
      fw.onViolation(cb);

      fw.runChecks([makeInvoice({ id: "a" }), makeInvoice({ id: "b" })]);
      expect(cb).toHaveBeenCalledTimes(2);
    });
  });

  // ── exportReport() ────────────────────────────────────────────────────────

  describe("exportReport()", () => {
    it("returns empty string when no report exists", () => {
      expect(new ComplianceFramework().exportReport("json")).toBe("");
      expect(new ComplianceFramework().exportReport("csv")).toBe("");
    });

    it("exports valid JSON", () => {
      const fw = new ComplianceFramework();
      fw.loadBuiltInRules();
      fw.runChecks([makeInvoice()]);

      const json = fw.exportReport("json");
      expect(() => JSON.parse(json)).not.toThrow();
      const parsed = JSON.parse(json);
      expect(parsed).toHaveProperty("totalInvoices");
      expect(parsed).toHaveProperty("results");
    });

    it("JSON handles bigint fields without throwing", () => {
      const fw = new ComplianceFramework();
      fw.runChecks([makeInvoice()]);
      expect(() => fw.exportReport("json")).not.toThrow();
    });

    it("exports CSV with header row", () => {
      const fw = new ComplianceFramework();
      fw.loadBuiltInRules();
      fw.runChecks([makeInvoice()]);

      const csv = fw.exportReport("csv");
      expect(csv.startsWith("invoiceId,passed")).toBe(true);
    });

    it("CSV has one data row for a passing invoice", () => {
      const fw = new ComplianceFramework();
      fw.loadBuiltInRules();
      fw.runChecks([makeInvoice()]);

      const csv = fw.exportReport("csv");
      const lines = csv.split("\n");
      expect(lines).toHaveLength(2); // header + 1 data row
      expect(lines[1]).toContain("true");
    });

    it("CSV has one row per violation for a failing invoice", () => {
      const fw = new ComplianceFramework();
      fw.registerRule({ id: "r1", name: "R1", description: "", check: () => false });
      fw.registerRule({ id: "r2", name: "R2", description: "", check: () => false });
      fw.runChecks([makeInvoice()]);

      const csv = fw.exportReport("csv");
      const lines = csv.split("\n");
      expect(lines).toHaveLength(3); // header + 2 violation rows
    });
  });
});
