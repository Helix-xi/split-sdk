import { describe, it, expect } from "vitest";
import {
  ok,
  err,
  isOk,
  isErr,
  unwrapResult,
  mapResult,
  mapErr,
  matchResult,
  createPaginatedResponse,
  isInvoiceStatus,
  isPendingInvoice,
  isReleasedInvoice,
  isRefundedInvoice,
  isCancelledInvoice,
  toStroops,
  toStellarAddress,
  toInvoiceId,
  type Result,
  type PaginatedResponse,
  type PendingInvoice,
  type ReleasedInvoice,
  type Invoice,
  type DeepPartial,
  type DeepReadonly,
  type RequireKeys,
  type OptionalKeys,
  type StrictOmit,
  type ValueOf,
  type StroopAmount,
  type StellarAddress,
  type InvoiceId,
} from "../src/types.js";

describe("Type Definitions Improvements (#1080)", () => {
  describe("Result<T, E> Pattern", () => {
    it("creates ok result and narrows with isOk", () => {
      const res: Result<{ id: string }> = ok({ id: "inv-123" });
      expect(isOk(res)).toBe(true);
      expect(isErr(res)).toBe(false);
      if (isOk(res)) {
        expect(res.data.id).toBe("inv-123");
      }
    });

    it("creates err result and narrows with isErr", () => {
      const customErr = new Error("Failed to submit");
      const res: Result<string, Error> = err(customErr);
      expect(isErr(res)).toBe(true);
      expect(isOk(res)).toBe(false);
      if (isErr(res)) {
        expect(res.error.message).toBe("Failed to submit");
      }
    });

    it("unwraps ok result or throws err result", () => {
      const success = ok(42);
      expect(unwrapResult(success)).toBe(42);

      const failure = err(new Error("Boom"));
      expect(() => unwrapResult(failure)).toThrow("Boom");
    });

    it("maps ok and err results", () => {
      const r1 = ok(10);
      const mapped1 = mapResult(r1, (x) => x * 2);
      expect(unwrapResult(mapped1)).toBe(20);

      const r2 = err("network error");
      const mapped2 = mapResult(r2, (x: number) => x * 2);
      expect(isErr(mapped2)).toBe(true);

      const mappedErr = mapErr(r2, (e) => `Encountered: ${e}`);
      if (isErr(mappedErr)) {
        expect(mappedErr.error).toBe("Encountered: network error");
      }
    });

    it("matches result with patterns", () => {
      const success = ok("data");
      const matchedSuccess = matchResult(success, {
        ok: (d) => `Got ${d}`,
        err: (e) => `Error: ${e}`,
      });
      expect(matchedSuccess).toBe("Got data");

      const failure = err("timeout");
      const matchedFailure = matchResult(failure, {
        ok: (d) => `Got ${d}`,
        err: (e) => `Error: ${e}`,
      });
      expect(matchedFailure).toBe("Error: timeout");
    });
  });

  describe("PaginatedResponse<T>", () => {
    it("creates pagination metadata correctly", () => {
      const page1 = createPaginatedResponse(["a", "b", "c"], 10, 1, 3);
      expect(page1.items).toEqual(["a", "b", "c"]);
      expect(page1.total).toBe(10);
      expect(page1.page).toBe(1);
      expect(page1.pageSize).toBe(3);
      expect(page1.totalPages).toBe(4);
      expect(page1.hasNext).toBe(true);
      expect(page1.hasPrev).toBe(false);

      const page4 = createPaginatedResponse(["j"], 10, 4, 3);
      expect(page4.hasNext).toBe(false);
      expect(page4.hasPrev).toBe(true);
    });

    it("handles zero items", () => {
      const empty = createPaginatedResponse([], 0, 1, 10);
      expect(empty.total).toBe(0);
      expect(empty.totalPages).toBe(0);
      expect(empty.hasNext).toBe(false);
      expect(empty.hasPrev).toBe(false);
    });
  });

  describe("Status-Narrowed Invoices & Guards", () => {
    const baseInvoice: Invoice = {
      id: "inv-1",
      creator: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      recipients: [{ address: "GABC", amount: 1000n }],
      token: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      deadline: Math.floor(Date.now() / 1000) + 3600,
      funded: 0n,
      status: "Pending",
      payments: [],
    };

    it("narrows pending invoice", () => {
      expect(isPendingInvoice(baseInvoice)).toBe(true);
      expect(isReleasedInvoice(baseInvoice)).toBe(false);
      expect(isInvoiceStatus(baseInvoice, "Pending")).toBe(true);
    });

    it("narrows released invoice", () => {
      const released: Invoice = { ...baseInvoice, status: "Released", funded: 1000n };
      expect(isReleasedInvoice(released)).toBe(true);
      expect(isPendingInvoice(released)).toBe(false);
      expect(isInvoiceStatus(released, "Released")).toBe(true);
    });

    it("narrows refunded invoice", () => {
      const refunded: Invoice = { ...baseInvoice, status: "Refunded" };
      expect(isRefundedInvoice(refunded)).toBe(true);
      expect(isInvoiceStatus(refunded, "Refunded")).toBe(true);
    });

    it("narrows cancelled invoice", () => {
      const cancelled: Invoice = { ...baseInvoice, status: "Cancelled" };
      expect(isCancelledInvoice(cancelled)).toBe(true);
      expect(isInvoiceStatus(cancelled, "Cancelled")).toBe(true);
    });

    it("supports generic custom metadata", () => {
      interface CustomMeta {
        department: string;
        projectId: number;
      }
      const customInvoice: Invoice<CustomMeta> = {
        ...baseInvoice,
        metadata: {
          department: "Engineering",
          projectId: 42,
        },
      };
      expect(customInvoice.metadata?.department).toBe("Engineering");
      expect(customInvoice.metadata?.projectId).toBe(42);
    });
  });

  describe("Branded Types", () => {
    it("brands stroop amounts and rejects negative values", () => {
      const amt1: StroopAmount = toStroops(10_000_000n);
      expect(amt1).toBe(10_000_000n);

      const amt2 = toStroops("5000000");
      expect(amt2).toBe(5_000_000n);

      expect(() => toStroops(-1n)).toThrow(TypeError);
    });

    it("brands stellar addresses and validates string input", () => {
      const addr: StellarAddress = toStellarAddress("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H");
      expect(addr).toBe("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H");

      expect(() => toStellarAddress("")).toThrow(TypeError);
      expect(() => toStellarAddress("   ")).toThrow(TypeError);
    });

    it("brands invoice identifiers", () => {
      const id1: InvoiceId = toInvoiceId("inv-999");
      expect(id1).toBe("inv-999");

      const id2 = toInvoiceId(42n);
      expect(id2).toBe("42");

      expect(() => toInvoiceId("")).toThrow(TypeError);
    });
  });

  describe("Type Utilities Compilation Tests", () => {
    it("exercises DeepPartial, DeepReadonly, and RequireKeys", () => {
      interface Config {
        network: {
          rpcUrl: string;
          passphrase: string;
        };
        timeout?: number;
      }

      type PartialConfig = DeepPartial<Config>;
      const partial: PartialConfig = { network: { rpcUrl: "http://localhost" } };
      expect(partial.network?.rpcUrl).toBe("http://localhost");

      type ReadonlyConfig = DeepReadonly<Config>;
      const ro: ReadonlyConfig = {
        network: { rpcUrl: "http://localhost", passphrase: "Test" },
      };
      expect(ro.network.rpcUrl).toBe("http://localhost");

      type RequiredTimeout = RequireKeys<Config, "timeout">;
      const req: RequiredTimeout = {
        network: { rpcUrl: "http://localhost", passphrase: "Test" },
        timeout: 5000,
      };
      expect(req.timeout).toBe(5000);
    });
  });
});
