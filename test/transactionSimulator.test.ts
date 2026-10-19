import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TransactionSimulator,
  type SimulationReport,
} from "../src/transactionSimulator.js";

const VALID_XDR = "AAAAAgAAAADe...";
const AUTH_FAIL_XDR = "AAAAAgAAAADe...fail_auth";
const BALANCE_FAIL_XDR = "AAAAAgAAAADe...fail_balance";
const BUDGET_FAIL_XDR = "AAAAAgAAAADe...fail_budget";
const SEQ_FAIL_XDR = "AAAAAgAAAADe...fail_sequence";
const CONTRACT_FAIL_XDR = "AAAAAgAAAADe...fail_contract";

describe("TransactionSimulator", () => {
  let simulator: TransactionSimulator;

  beforeEach(() => {
    simulator = new TransactionSimulator();
  });

  describe("Simulation works", () => {
    it("simulates a valid transaction and returns successful report", async () => {
      const report = await simulator.simulate(VALID_XDR);

      expect(report.status).toBe("success");
      expect(report.errors).toHaveLength(0);
      expect(report.resourceUsage.minResourceFee).toBe(150n);
      expect(report.resourceUsage.cpuInstructions).toBe(125000n);
      expect(report.resourceUsage.memoryBytes).toBe(45000n);
      expect(report.events).toHaveLength(1);
      expect(report.summary).toContain("Simulation succeeded");
      expect(report.executionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("accepts SimulationRequest object with metadata", async () => {
      const report = await simulator.simulate({
        txXdr: VALID_XDR,
        id: "tx-custom-id",
        sourceAccount: "GABC...",
      });

      expect(report.simulationId).toBe("tx-custom-id");
      expect(report.status).toBe("success");
    });

    it("uses injected custom simulateFn", async () => {
      const customSimulate = vi.fn().mockResolvedValue({
        minResourceFee: "500",
        cost: { cpuInsns: "99999", memBytes: "11111" },
      });

      const customSim = new TransactionSimulator({ simulateFn: customSimulate });
      const report = await customSim.simulate("custom-tx");

      expect(customSimulate).toHaveBeenCalledWith("custom-tx");
      expect(report.resourceUsage.minResourceFee).toBe(500n);
      expect(report.resourceUsage.cpuInstructions).toBe(99999n);
    });
  });

  describe("Errors detected", () => {
    it("detects authorization failure (AUTH_FAILED)", async () => {
      const report = await simulator.simulate(AUTH_FAIL_XDR);

      expect(report.status).toBe("failed");
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0].code).toBe("AUTH_FAILED");
      expect(report.errors[0].suggestion).toContain("required signers");
      expect(report.recommendations).toContain(report.errors[0].suggestion);
    });

    it("detects insufficient funds error (INSUFFICIENT_FUNDS)", async () => {
      const report = await simulator.simulate(BALANCE_FAIL_XDR);

      expect(report.status).toBe("failed");
      expect(report.errors[0].code).toBe("INSUFFICIENT_FUNDS");
      expect(report.errors[0].suggestion).toContain("sufficient funds");
    });

    it("detects resource budget exhaustion (RESOURCE_EXHAUSTED)", async () => {
      const report = await simulator.simulate(BUDGET_FAIL_XDR);

      expect(report.status).toBe("failed");
      expect(report.errors[0].code).toBe("RESOURCE_EXHAUSTED");
      expect(report.errors[0].suggestion).toContain("CPU or memory");
    });

    it("detects sequence number mismatch (SEQUENCE_ERROR)", async () => {
      const report = await simulator.simulate(SEQ_FAIL_XDR);

      expect(report.status).toBe("failed");
      expect(report.errors[0].code).toBe("SEQUENCE_ERROR");
      expect(report.errors[0].suggestion).toContain("sequence number");
    });

    it("detects contract execution panic (CONTRACT_ERROR)", async () => {
      const report = await simulator.simulate(CONTRACT_FAIL_XDR);

      expect(report.status).toBe("failed");
      expect(report.errors[0].code).toBe("CONTRACT_ERROR");
      expect(report.errors[0].suggestion).toContain("Contract invocation");
    });

    it("detects storage footprint errors", async () => {
      const sim = new TransactionSimulator({
        simulateFn: vi.fn().mockResolvedValue({ error: "Storage error: entry expired or missing footprint" }),
      });
      const report = await sim.simulate("xdr-storage");

      expect(report.errors[0].code).toBe("STORAGE_ERROR");
    });

    it("detects expired deadline errors", async () => {
      const sim = new TransactionSimulator({
        simulateFn: vi.fn().mockResolvedValue({ error: "tx_too_late: timebounds expired" }),
      });
      const report = await sim.simulate("xdr-deadline");

      expect(report.errors[0].code).toBe("DEADLINE_EXPIRED");
    });

    it("handles RPC network/fetch rejection gracefully", async () => {
      const sim = new TransactionSimulator({
        simulateFn: vi.fn().mockRejectedValue(new Error("RPC Connection refused")),
      });
      const report = await sim.simulate("xdr-rpc-fail");

      expect(report.status).toBe("error");
      expect(report.errors).toHaveLength(1);
      expect(report.summary).toContain("RPC Connection refused");
    });

    it("rejects empty or invalid txXdr input", async () => {
      const report = await simulator.simulate("");
      expect(report.status).toBe("error");
      expect(report.errors[0].code).toBe("INVALID_TRANSACTION");
    });
  });

  describe("Reports clear", () => {
    it("formats markdown report with clear sections", async () => {
      const report = await simulator.simulate(VALID_XDR);
      const markdown = simulator.formatReport(report, "markdown");

      expect(markdown).toContain("## Transaction Simulation Report");
      expect(markdown).toContain("**Status**: SUCCESS");
      expect(markdown).toContain("**Estimated Resource Fee**:");
      expect(markdown).toContain("**CPU Instructions**:");
    });

    it("formats text report clearly", async () => {
      const report = await simulator.simulate(AUTH_FAIL_XDR);
      const text = simulator.formatReport(report, "text");

      expect(text).toContain("TRANSACTION SIMULATION REPORT");
      expect(text).toContain("Status: FAILED");
      expect(text).toContain("[AUTH_FAILED]");
    });

    it("formats JSON report correctly", async () => {
      const report = await simulator.simulate(VALID_XDR);
      const json = simulator.formatReport(report, "json");

      const parsed = JSON.parse(json);
      expect(parsed.status).toBe("success");
      expect(parsed.resourceUsage.minResourceFee).toBe("150");
    });

    it("emits warnings when resource usage exceeds warning threshold", async () => {
      const customSim = new TransactionSimulator({
        simulateFn: vi.fn().mockResolvedValue({
          cost: { cpuInsns: "95000000", memBytes: "25000000" },
        }),
        cpuInstructionWarningThreshold: 80_000_000n,
        memoryByteWarningThreshold: 20_000_000n,
      });

      const report = await customSim.simulate("high-res-tx");
      expect(report.warnings.length).toBeGreaterThanOrEqual(2);
      expect(report.warnings[0]).toContain("High CPU instruction count");
      expect(report.warnings[1]).toContain("High memory usage");
    });
  });

  describe("Performance good", () => {
    it("caches simulation reports for identical transactions", async () => {
      const mockFn = vi.fn().mockResolvedValue({
        minResourceFee: "200",
        cost: { cpuInsns: "50000", memBytes: "10000" },
      });
      const sim = new TransactionSimulator({ simulateFn: mockFn, enableCache: true });

      const report1 = await sim.simulate("cached-xdr");
      const report2 = await sim.simulate("cached-xdr");

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(report1).toBe(report2);
    });

    it("bypasses cache after clearCache()", async () => {
      const mockFn = vi.fn().mockResolvedValue({ minResourceFee: "100" });
      const sim = new TransactionSimulator({ simulateFn: mockFn, enableCache: true });

      await sim.simulate("cached-xdr");
      sim.clearCache();
      await sim.simulate("cached-xdr");

      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it("simulateBatch handles multiple transactions concurrently", async () => {
      const reports = await simulator.simulateBatch([
        VALID_XDR,
        AUTH_FAIL_XDR,
        BALANCE_FAIL_XDR,
      ]);

      expect(reports).toHaveLength(3);
      expect(reports[0].status).toBe("success");
      expect(reports[1].status).toBe("failed");
      expect(reports[2].status).toBe("failed");
    });
  });
});
