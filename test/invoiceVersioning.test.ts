import { describe, it, expect, beforeEach } from "vitest";
import {
  InvoiceVersionManager,
  InvoiceVersionTracker,
  InMemoryVersionStore,
  computeChecksum,
} from "../src/invoiceVersioning.js";
import {
  InvoiceVersionNotFoundError,
  UnsafeRollbackError,
  InvalidVersionError,
} from "../src/errors.js";
import type { Invoice } from "../src/types.js";

const CREATOR = "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2";
const RECIPIENT1 = "GBRPYHIL2CI3WHSCULNJJMA3CJBYWR5LK662LFXISKW3P7UKDXTX5AGE";
const RECIPIENT2 = "GDQJUTQYK2MQX2CBBFKVZBNE4RG4H3ZVJJJX5RFHPB4DXX6IQHTHYKF";

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv-101",
    creator: CREATOR,
    recipients: [{ address: RECIPIENT1, amount: 100_000_000n }],
    token: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    deadline: Math.floor(Date.now() / 1000) + 86_400,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

describe("Invoice Versioning System (#1056)", () => {
  let manager: InvoiceVersionManager;

  beforeEach(() => {
    manager = new InvoiceVersionManager();
  });

  describe("Versioning works", () => {
    it("creates initial version with snapshot and checksum", async () => {
      const invoice = makeInvoice();
      const v1 = await manager.record(invoice.id, invoice, CREATOR);

      expect(v1.version).toBe(1);
      expect(v1.changedBy).toBe(CREATOR);
      expect(v1.snapshot.id).toBe(invoice.id);
      expect(v1.checksum).toBeDefined();
      expect(v1.checksum).toBe(computeChecksum(invoice));
    });

    it("retrieves specific versions by number", async () => {
      const invoice = makeInvoice();
      await manager.record(invoice.id, invoice, CREATOR);
      await manager.record(invoice.id, { ...invoice, memo: "v2" }, CREATOR);

      const v1 = await manager.getVersion(invoice.id, 1);
      const v2 = await manager.getVersion(invoice.id, 2);
      const v3 = await manager.getVersion(invoice.id, 3);

      expect(v1?.version).toBe(1);
      expect(v1?.snapshot.memo).toBeUndefined();
      expect(v2?.version).toBe(2);
      expect(v2?.snapshot.memo).toBe("v2");
      expect(v3).toBeNull();
    });
  });

  describe("Changes tracked", () => {
    it("tracks incremental field changes between versions", async () => {
      const invoice = makeInvoice();
      await manager.record(invoice.id, invoice, CREATOR);

      const updated = {
        ...invoice,
        memo: "New memo",
        recipients: [
          { address: RECIPIENT1, amount: 50_000_000n },
          { address: RECIPIENT2, amount: 50_000_000n },
        ],
      };
      const v2 = await manager.record(invoice.id, updated, CREATOR);

      expect(v2.changeSummary).toContain("memo");
      expect(v2.changeSummary).toContain("recipients");

      const diff = await manager.diff(invoice.id, 1, 2);
      expect(diff.hasChanges).toBe(true);
      expect(diff.changes.some((c) => c.field === "memo")).toBe(true);
      expect(diff.changes.some((c) => c.field === "recipients")).toBe(true);
    });
  });

  describe("Rollback safe", () => {
    it("rolls back configuration to target version while preserving payments and funded amount by default", async () => {
      const base = makeInvoice({ memo: "Version 1 memo" });
      await manager.record(base.id, base, CREATOR);

      const v2Invoice: Invoice = {
        ...base,
        memo: "Version 2 memo",
        funded: 50_000_000n,
        payments: [{ payer: "GPAYER", amount: 50_000_000n, ledger: 100 }],
      };
      await manager.record(base.id, v2Invoice, CREATOR);

      const isSafe = await manager.isRollbackSafe(base.id, 1);
      expect(isSafe.safe).toBe(true);

      const rollbackResult = await manager.rollback(base.id, 1, {
        changedBy: CREATOR,
        reason: "Reverting memo changes",
      });

      expect(rollbackResult.newVersionNumber).toBe(3);
      expect(rollbackResult.targetVersion).toBe(1);
      expect(rollbackResult.restoredInvoice.memo).toBe("Version 1 memo");
      // Preserved payments and funded
      expect(rollbackResult.restoredInvoice.funded).toBe(50_000_000n);
      expect(rollbackResult.restoredInvoice.payments).toHaveLength(1);

      expect(rollbackResult.version.isRollback).toBe(true);
      expect(rollbackResult.version.rolledBackFromVersion).toBe(1);
    });

    it("rejects rollback when target version is invalid or out of range", async () => {
      const base = makeInvoice();
      await manager.record(base.id, base, CREATOR);

      await expect(manager.rollback(base.id, 0)).rejects.toThrow(InvalidVersionError);
      await expect(manager.rollback(base.id, 1)).rejects.toThrow(UnsafeRollbackError);
      await expect(manager.rollback(base.id, 5)).rejects.toThrow(InvalidVersionError);
    });

    it("rejects rollback of finalized invoices unless allowTerminalStateRollback is explicitly granted", async () => {
      const base = makeInvoice();
      await manager.record(base.id, base, CREATOR);

      const finalized: Invoice = { ...base, status: "Released" };
      await manager.record(base.id, finalized, CREATOR);

      const safety = await manager.isRollbackSafe(base.id, 1);
      expect(safety.safe).toBe(false);
      expect(safety.reason).toContain("terminal state");

      await expect(manager.rollback(base.id, 1)).rejects.toThrow(UnsafeRollbackError);

      // Allowed when explicit flag is passed
      const forcedRollback = await manager.rollback(base.id, 1, {
        allowTerminalStateRollback: true,
      });
      expect(forcedRollback.newVersionNumber).toBe(3);
    });

    it("allows option to not preserve payments if explicitly set", async () => {
      const base = makeInvoice({ funded: 0n, payments: [] });
      await manager.record(base.id, base, CREATOR);

      const fundedInv = {
        ...base,
        funded: 100_000n,
        payments: [{ payer: "P1", amount: 100_000n }],
      };
      await manager.record(base.id, fundedInv, CREATOR);

      const res = await manager.rollback(base.id, 1, { preservePayments: false });
      expect(res.restoredInvoice.funded).toBe(0n);
      expect(res.restoredInvoice.payments).toHaveLength(0);
    });
  });

  describe("History clear", () => {
    it("generates a clear human-readable changelog", async () => {
      const invoice = makeInvoice();
      await manager.record(invoice.id, invoice, CREATOR);
      await manager.record(invoice.id, { ...invoice, memo: "Updated memo" }, CREATOR);

      const changelog = await manager.getChangeLog(invoice.id);
      expect(changelog).toHaveLength(2);
      expect(changelog[0]!.version).toBe(1);
      expect(changelog[0]!.changeSummary).toBe("Initial version.");
      expect(changelog[1]!.version).toBe(2);
      expect(changelog[1]!.changedFields).toContain("memo");
    });

    it("exports and imports history cleanly via JSON", async () => {
      const invoice = makeInvoice();
      await manager.record(invoice.id, invoice, CREATOR);
      await manager.record(invoice.id, { ...invoice, memo: "v2" }, CREATOR);

      const json = await manager.exportHistoryJson(invoice.id);
      expect(json).toContain('"version": 1');
      expect(json).toContain('"version": 2');

      const newManager = new InvoiceVersionManager();
      const count = await newManager.importHistoryJson(invoice.id, json);
      expect(count).toBe(2);

      const importedHistory = await newManager.getHistory(invoice.id);
      expect(importedHistory).toHaveLength(2);
      expect(importedHistory[1]!.snapshot.memo).toBe("v2");
    });
  });
});
