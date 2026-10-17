import { describe, it, expect, beforeEach } from "vitest";
import {
  ErrorAggregator,
  normalizeErrorMessage,
  getDefaultErrorAggregator,
  setDefaultErrorAggregator,
  resetDefaultErrorAggregator,
  aggregateError,
} from "../src/errorAggregator.js";
import {
  StellarSplitError,
  InvoiceNotFoundError,
  DeadlinePassedError,
} from "../src/errors.js";

describe("Issue #1072 — Error Aggregation", () => {
  beforeEach(() => {
    resetDefaultErrorAggregator();
  });

  describe("Message Normalization", () => {
    it("normalizes dynamic identifiers in error messages", () => {
      const msg = "Invoice inv-abc12345 payment of 500.50 failed for account GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 tx 0xabcdef1234567890";
      const normalized = normalizeErrorMessage(msg);

      expect(normalized).toContain("<INVOICE_ID>");
      expect(normalized).toContain("<STELLAR_ADDRESS>");
      expect(normalized).toContain("<HEX_HASH>");
      expect(normalized).toContain("<N>");
      expect(normalized).not.toContain("inv-abc12345");
      expect(normalized).not.toContain("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    });
  });

  describe("Aggregation & Grouping Logic", () => {
    it("groups related errors logically by code", () => {
      const aggregator = new ErrorAggregator({ strategy: "code" });

      aggregator.record(new InvoiceNotFoundError("inv-1"));
      aggregator.record(new InvoiceNotFoundError("inv-2"));
      aggregator.record(new DeadlinePassedError("inv-3"));

      const groups = aggregator.getGroups();
      expect(groups).toHaveLength(2);

      const notFoundGroup = groups.find((g) => g.groupKey === "INVOICE_NOT_FOUND");
      expect(notFoundGroup).toBeDefined();
      expect(notFoundGroup?.count).toBe(2);
      expect(notFoundGroup?.affectedInvoices).toEqual(expect.arrayContaining(["inv-1", "inv-2"]));

      const deadlineGroup = groups.find((g) => g.groupKey === "DEADLINE_PASSED");
      expect(deadlineGroup).toBeDefined();
      expect(deadlineGroup?.count).toBe(1);
    });

    it("groups related errors by normalized message", () => {
      const aggregator = new ErrorAggregator({ strategy: "message" });

      aggregator.record(new Error("Payment of 100 stroops to GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 failed"));
      aggregator.record(new Error("Payment of 500 stroops to GCFE57IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 failed"));

      const groups = aggregator.getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].count).toBe(2);
      expect(groups[0].groupKey).toContain("<STELLAR_ADDRESS>");
    });

    it("supports custom grouping functions", () => {
      const aggregator = new ErrorAggregator({
        strategy: (_err, context) => `component:${context?.component || "unknown"}`,
      });

      aggregator.record(new Error("Err 1"), { component: "indexer" });
      aggregator.record(new Error("Err 2"), { component: "indexer" });
      aggregator.record(new Error("Err 3"), { component: "relayer" });

      const groups = aggregator.getGroups();
      expect(groups).toHaveLength(2);
      expect(groups.find((g) => g.groupKey === "component:indexer")?.count).toBe(2);
      expect(groups.find((g) => g.groupKey === "component:relayer")?.count).toBe(1);
    });

    it("computes common context across all errors in a group", () => {
      const aggregator = new ErrorAggregator({ strategy: "code" });

      aggregator.record(new StellarSplitError("Fail 1", "RPC_ERROR"), {
        network: "testnet",
        endpoint: "https://rpc1.stellar.org",
        attempt: 1,
      });

      aggregator.record(new StellarSplitError("Fail 2", "RPC_ERROR"), {
        network: "testnet",
        endpoint: "https://rpc1.stellar.org",
        attempt: 2,
      });

      const groups = aggregator.getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].commonContext).toEqual({
        network: "testnet",
        endpoint: "https://rpc1.stellar.org",
      });
      // attempt varied between 1 and 2, so it must not be in commonContext
      expect(groups[0].commonContext.attempt).toBeUndefined();
    });

    it("ingests batch errors efficiently", () => {
      const aggregator = new ErrorAggregator({ strategy: "code" });
      const batch = [
        new InvoiceNotFoundError("inv-1"),
        new InvoiceNotFoundError("inv-2"),
        new DeadlinePassedError("inv-3"),
      ];

      aggregator.recordBatch(batch);
      expect(aggregator.totalCount()).toBe(3);
      expect(aggregator.getGroups()).toHaveLength(2);
    });
  });

  describe("Pattern Detection & Visibility", () => {
    it("detects error spike patterns", () => {
      const aggregator = new ErrorAggregator({ strategy: "code" });

      // Record 6 rapid errors within the current window
      for (let i = 0; i < 6; i++) {
        aggregator.record(new StellarSplitError("RPC timeout", "RPC_TIMEOUT"));
      }

      const patterns = aggregator.detectPatterns();
      const spike = patterns.find((p) => p.type === "spike");

      expect(spike).toBeDefined();
      expect(spike?.groupKey).toBe("RPC_TIMEOUT");
      expect(spike?.severity).toBe("high");
      expect(spike?.description).toContain("Spike detected");
    });

    it("detects high frequency dominant error patterns", () => {
      const aggregator = new ErrorAggregator({ strategy: "code" });

      // 10 total errors: 8 are RATE_LIMITED (80%), 2 are NOT_FOUND (20%)
      for (let i = 0; i < 8; i++) {
        aggregator.record(new StellarSplitError("Rate limit", "RATE_LIMITED"));
      }
      for (let i = 0; i < 2; i++) {
        aggregator.record(new StellarSplitError("Not found", "NOT_FOUND"));
      }

      const patterns = aggregator.detectPatterns();
      const highFreq = patterns.find((p) => p.type === "high_frequency");

      expect(highFreq).toBeDefined();
      expect(highFreq?.groupKey).toBe("RATE_LIMITED");
      expect(highFreq?.description).toContain("Dominant error pattern");
    });

    it("detects recurring entity failures on the same invoice", () => {
      const aggregator = new ErrorAggregator({ strategy: "code" });

      aggregator.record(new StellarSplitError("Err A", "CODE_A"), { invoiceId: "inv-repeat-1" });
      aggregator.record(new StellarSplitError("Err B", "CODE_B"), { invoiceId: "inv-repeat-1" });
      aggregator.record(new StellarSplitError("Err C", "CODE_C"), { invoiceId: "inv-repeat-1" });

      const patterns = aggregator.detectPatterns();
      const entityPattern = patterns.find((p) => p.type === "recurring_entity" && p.entityId === "inv-repeat-1");

      expect(entityPattern).toBeDefined();
      expect(entityPattern?.description).toContain("Invoice \"inv-repeat-1\" has failed 3 times");
    });

    it("detects cascading failures across multiple distinct error groups", () => {
      const aggregator = new ErrorAggregator({ strategy: "code" });

      aggregator.record(new StellarSplitError("Fail 1", "RPC_ERROR"));
      aggregator.record(new StellarSplitError("Fail 2", "DB_ERROR"));
      aggregator.record(new StellarSplitError("Fail 3", "AUTH_ERROR"));

      const patterns = aggregator.detectPatterns();
      const cascading = patterns.find((p) => p.type === "cascading_failure");

      expect(cascading).toBeDefined();
      expect(cascading?.severity).toBe("critical");
      expect(cascading?.description).toContain("Cascading system failure");
    });
  });

  describe("Clear Reporting (Text, Markdown, JSON)", () => {
    it("generates a comprehensive report with clear text and markdown output", () => {
      const aggregator = new ErrorAggregator({ strategy: "code" });

      for (let i = 0; i < 3; i++) {
        aggregator.record(new InvoiceNotFoundError(`inv-${i}`), { accountId: "GA123" });
      }
      aggregator.record(new DeadlinePassedError("inv-99"));

      const report = aggregator.generateReport();

      expect(report.totalErrors).toBe(4);
      expect(report.uniqueGroups).toBe(2);
      expect(report.topErrors).toHaveLength(2);
      expect(report.topErrors[0].groupKey).toBe("INVOICE_NOT_FOUND");
      expect(report.topErrors[0].percentage).toBe(75);

      // Check text format
      const text = report.formatAsText();
      expect(text).toContain("STELLARSPLIT ERROR REPORT");
      expect(text).toContain("Total Errors: 4 across 2 distinct group(s)");
      expect(text).toContain("INVOICE_NOT_FOUND");
      expect(text).toContain("GA123");

      // Check markdown format
      const md = report.formatAsMarkdown();
      expect(md).toContain("# StellarSplit Error Aggregation Report");
      expect(md).toContain("| Rank | Group | Count | Percentage |");
      expect(md).toContain("`INVOICE_NOT_FOUND`");

      // Check JSON format
      const json = report.toJSON();
      const parsed = JSON.parse(json);
      expect(parsed.totalErrors).toBe(4);
      expect(parsed.uniqueGroups).toBe(2);
    });

    it("clears aggregator and resets state", () => {
      const aggregator = new ErrorAggregator();
      aggregator.record(new Error("Test error"));
      expect(aggregator.totalCount()).toBe(1);

      aggregator.clear();
      expect(aggregator.totalCount()).toBe(0);
      expect(aggregator.getGroups()).toHaveLength(0);
    });

    it("works with default global aggregator and aggregateError helper", () => {
      const grp = aggregateError(new Error("Default helper error"));
      expect(grp).toBeDefined();
      expect(getDefaultErrorAggregator().totalCount()).toBe(1);
    });
  });
});
