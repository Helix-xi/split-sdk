import { describe, expect, it } from "vitest";
import { searchByMemo } from "../src/search.js";
import type { Invoice } from "../src/types.js";

function makeInvoice(id: string, memo?: string): Invoice {
  return {
    id,
    creator: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGXDECKXOWBLNL2WSRB",
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    totalAmount: 1000n,
    fundedAmount: 0n,
    status: "Active",
    deadline: Math.floor(Date.now() / 1000) + 3600,
    recipients: [],
    memo,
  };
}

describe("searchByMemo", () => {
  const invoices: Invoice[] = [
    makeInvoice("1", "split:INV-001 monthly rent"),
    makeInvoice("2", "DINNER with Friends"),
    makeInvoice("3", "Project Milestone #2"),
    makeInvoice("4", undefined),
    { ...makeInvoice("5"), memo: undefined as unknown as string },
  ];

  it("finds invoices matching substring with default case-insensitivity", () => {
    const results = searchByMemo(invoices, "dinner");
    expect(results.map((i) => i.id)).toEqual(["2"]);

    const splitResults = searchByMemo(invoices, "inv-001");
    expect(splitResults.map((i) => i.id)).toEqual(["1"]);
  });

  it("respects caseSensitive: true override", () => {
    const caseInsensitive = searchByMemo(invoices, "dinner", { caseSensitive: false });
    expect(caseInsensitive.map((i) => i.id)).toEqual(["2"]);

    const caseSensitiveMismatch = searchByMemo(invoices, "dinner", { caseSensitive: true });
    expect(caseSensitiveMismatch).toEqual([]);

    const caseSensitiveMatch = searchByMemo(invoices, "DINNER", { caseSensitive: true });
    expect(caseSensitiveMatch.map((i) => i.id)).toEqual(["2"]);
  });

  it("returns all invoices unchanged when query is empty string", () => {
    const results = searchByMemo(invoices, "");
    expect(results).toBe(invoices);
  });

  it("skips undefined and null memo without throwing error", () => {
    const invoicesWithNull: Invoice[] = [
      makeInvoice("10", "valid memo"),
      { ...makeInvoice("11"), memo: null as unknown as string },
      { ...makeInvoice("12"), memo: undefined },
    ];

    expect(() => searchByMemo(invoicesWithNull, "valid")).not.toThrow();
    const matches = searchByMemo(invoicesWithNull, "valid");
    expect(matches.map((i) => i.id)).toEqual(["10"]);
  });

  it("returns empty array when query does not match any invoice memo", () => {
    const results = searchByMemo(invoices, "nonexistent-query-string");
    expect(results).toEqual([]);
  });
});
