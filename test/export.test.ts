import { describe, it, expect } from "vitest";
import { exportInvoice, ExportFormat, exportAsCsv, exportAsText, exportAsJson, renderInvoiceTable, registerExportBuilder, listExportBuilders } from "../src/export.js";
import type { Invoice } from "../src/types.js";

const invoice: Invoice = {
  id: "inv-123",
  creator: "GCreator",
  recipients: [{ address: "GR1", amount: 10000000n }, { address: "GR2", amount: 5000000n }],
  token: "GArtbit",
  deadline: 1700000000,
  funded: 15000000n,
  status: "Pending",
  payments: [{ payer: "GPayer", amount: 15000000n, ledger: 100, timestamp: 1700000000 }],
  memo: "Test memo",
  scheduledReleaseDate: 1700000000,
  createdAt: 1699999999,
  clonedFrom: "inv-clone",
  groupId: "grp-1",
};

describe("exportInvoice (Issue #1048)", () => {
  it("returns valid PDF (starts with PDF header, ends with EOF)", () => {
    const pdf = exportInvoice(invoice, "pdf");
    expect(pdf).toMatch(/^%PDF-1\.4/);
    expect(pdf).toContain("%%EOF");
    expect(pdf).toContain("StellarSplit Invoice");
    expect(pdf).toContain("GR1");
  });

  it("returns valid CSV with quoted fields", () => {
    const csv = exportAsCsv(invoice);
    expect(csv).toContain("ID");
    expect(csv).toContain("GR1");
    expect(csv).toContain("inv-123");
    const lines = csv.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain("Funded");
  });

  it("returns JSON with BigInt fields as strings", () => {
    const json = exportAsJson(invoice);
    const data = JSON.parse(json);
    expect(data.id).toBe("inv-123");
    expect(data.funded).toBe("15000000");
    expect(data.recipients).toEqual([
      { address: "GR1", amount: "10000000" },
      { address: "GR2", amount: "5000000" },
    ]);
  });

  it("returns human-readable text", () => {
    const text = exportAsText(invoice);
    expect(text).toContain("=== StellarSplit Invoice ===");
    expect(text).toContain("GR1: 1.0000000");
  });

  it("throws for unknown format", () => {
    expect(() => exportInvoice(invoice, "html" as any)).toThrow();
  });
});

describe("renderInvoiceTable (reusable template)", () => {
  it("builds standard table rows", () => {
    const rows = renderInvoiceTable(invoice);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows[0]).toMatchObject({ bold: true, text: "StellarSplit Invoice" });
    const recipientsIdx = rows.findIndex((r) => r.text === "Recipients");
    const paymentsIdx = rows.findIndex((r) => r.text === "Payments");
    expect(recipientsIdx).toBeGreaterThan(0);
    expect(paymentsIdx).toBeGreaterThan(recipientsIdx);
    const recipientRow = rows.find((r) => r.text.startsWith("GR1"));
    expect(recipientRow?.text).toContain("1.0000000");
  });
});

describe("custom export builders", () => {
  it("registers and lists a custom format", () => {
    const htmlBuilder: any = (inv: any) => `<html>${inv.id}</html>`;
    htmlBuilder.format = "html";
    registerExportBuilder("html", htmlBuilder);
    expect(listExportBuilders()).toContain("html");
  });
});
