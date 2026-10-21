import { describe, it, expect, vi } from "vitest";
import {
  groupByRecipient,
  deduplicateOps,
  prioritizeOps,
  executeInParallel,
  BatchOptimizer,
  type BatchOp,
} from "../src/batchOptimizationEnhancements.js";

const makeOp = (id: string, dest: string, amount: number, currency = "XLM"): BatchOp => ({
  id, destination: dest, amount, currency,
});

describe("batchOptimizationEnhancements", () => {
  it("groupByRecipient groups ops by destination", () => {
    const ops = [makeOp("1", "GABC", 100), makeOp("2", "GABC", 200), makeOp("3", "GDEF", 50)];
    const groups = groupByRecipient(ops);
    expect(groups.get("GABC")).toHaveLength(2);
    expect(groups.get("GDEF")).toHaveLength(1);
  });

  it("deduplicateOps merges same dest+currency", () => {
    const ops = [makeOp("1", "GABC", 100), makeOp("2", "GABC", 200), makeOp("3", "GDEF", 50)];
    const result = deduplicateOps(ops);
    expect(result).toHaveLength(2);
    const abc = result.find((o) => o.destination === "GABC")!;
    expect(abc.amount).toBe(300);
  });

  it("prioritizeOps sorts by amount descending by default", () => {
    const ops = [makeOp("1", "G1", 50), makeOp("2", "G2", 200), makeOp("3", "G3", 100)];
    const sorted = prioritizeOps(ops);
    expect(sorted[0].amount).toBe(200);
    expect(sorted[2].amount).toBe(50);
  });

  it("prioritizeOps sorts ascending when specified", () => {
    const ops = [makeOp("1", "G1", 50), makeOp("2", "G2", 200)];
    const sorted = prioritizeOps(ops, "asc");
    expect(sorted[0].amount).toBe(50);
  });

  it("executeInParallel executes all ops and returns results", async () => {
    const ops = [makeOp("1", "G1", 100), makeOp("2", "G2", 200)];
    const executor = vi.fn(async (op: BatchOp) => op.amount * 2);
    const results = await executeInParallel(ops, executor);
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("fulfilled");
    expect(results[0].value).toBe(200);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("BatchOptimizer.optimize runs full pipeline", async () => {
    const optimizer = new BatchOptimizer({ concurrency: 5 });
    const ops = [makeOp("1", "GABC", 100), makeOp("2", "GABC", 50), makeOp("3", "GDEF", 200)];
    const executor = async (op: BatchOp) => `sent:${op.amount}`;
    const results = await optimizer.optimize(ops, executor);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });
});
