import type { Invoice } from "./types.js";
import { formatAmount, truncateAddress } from "./utils.js";
import { UnknownExportFormatError } from "./errors.js";
import { buildInvoicePdf } from "./exportPdf.js";

/** Export format for invoices. */
export type ExportFormat = "json" | "csv" | "text" | "pdf";

/** Reusable invoice table rows. */
export interface InvoiceTableRow {
  text: string;
  bold?: boolean;
  indent?: number;
  title?: string;
}

/**
 * Build a standard invoice table for PDF export (reusable across templates).
 */
export function renderInvoiceTable(invoice: Invoice): InvoiceTableRow[] {
  const rows: InvoiceTableRow[] = [
    { text: "StellarSplit Invoice", bold: true, indent: 0 },
    { text: `Invoice ID: ${invoice.id}`, indent: 16 },
    { text: `Creator: ${invoice.creator ?? ""}`, indent: 16 },
    { text: `Token: ${invoice.token ?? ""}`, indent: 16 },
    { text: `Status: ${invoice.status ?? ""}`, indent: 16 },
    { text: `Deadline: ${new Date((invoice.deadline ?? 0) * 1000).toISOString()}`, indent: 16 },
    { text: `Funded: ${formatAmount(invoice.funded ?? 0n)}`, indent: 16 },
    { text: "", indent: 0 },
    { text: "Recipients", bold: true, indent: 0 },
  ];
  for (const r of invoice.recipients ?? []) {
    rows.push({ text: `${r.address}: ${formatAmount(r.amount)}`, indent: 32 });
  }
  rows.push({ text: "", indent: 0 });
  rows.push({ text: "Payments", bold: true, indent: 0 });
  for (const p of invoice.payments ?? []) {
    rows.push({ text: `${p.payer}: ${formatAmount(p.amount)}`, indent: 32 });
  }
  return rows;
}

/**
 * Export an invoice as PDF (A4, branded, reusable template).
 */
export function exportAsPdf(invoice: Invoice): string {
  const rows = renderInvoiceTable(invoice);
  return buildInvoicePdf("StellarSplit Invoice", rows, { title: "StellarSplit Invoice" });
}

/**
 * Export an invoice in the specified format.
 *
 * @param invoice - The invoice to export
 * @param format - Export format (json, csv, text, or pdf)
 * @returns Formatted invoice data as string
 */
export function exportInvoice(invoice: Invoice, format: ExportFormat): string {
  switch (format) {
    case "json": return exportAsJson(invoice);
    case "csv": return exportAsCsv(invoice);
    case "text": return exportAsText(invoice);
    case "pdf": return exportAsPdf(invoice);
    default:
      throw new UnknownExportFormatError(format as string);
  }
}

/** Export invoice as JSON with BigInt fields as strings. */
export function exportAsJson(invoice: Invoice): string {
  const data = {
    id: invoice.id,
    creator: invoice.creator,
    recipients: (invoice.recipients ?? []).map((r) => ({
      address: r.address,
      amount: r.amount.toString(),
    })),
    token: invoice.token,
    deadline: invoice.deadline,
    funded: invoice.funded.toString(),
    status: invoice.status,
    payments: (invoice.payments ?? []).map((p) => ({
      payer: p.payer,
      amount: p.amount.toString(),
    })),
    memo: invoice.memo ?? null,
    scheduledReleaseDate: invoice.scheduledReleaseDate ?? null,
    clonedFrom: invoice.clonedFrom ?? null,
    groupId: invoice.groupId ?? null,
  };
  return JSON.stringify(data, null, 2);
}

/** Export invoice as CSV. */
export function exportAsCsv(invoice: Invoice): string {
  const headers = [
    "ID", "Creator", "Recipients", "Token", "Deadline",
    "Funded", "Status", "Payments",
  ];
  const recipients = (invoice.recipients ?? [])
    .map((r) => `${r.address}:${r.amount}`)
    .join("|");
  const payments = (invoice.payments ?? [])
    .map((p) => `${p.payer}:${p.amount}`)
    .join("|");

  const row = [
    invoice.id,
    invoice.creator ?? "",
    recipients,
    invoice.token ?? "",
    String(invoice.deadline ?? ""),
    invoice.funded?.toString() ?? "0",
    invoice.status ?? "",
    payments,
  ];

  return [headers.join(","), row.join(",")].join("\n");
}

/** Export invoice as human-readable text. */
export function exportAsText(invoice: Invoice): string {
  const lines: string[] = [];
  lines.push("=== StellarSplit Invoice ===");
  lines.push(`ID: ${invoice.id}`);
  lines.push(`Creator: ${truncateAddress(invoice.creator ?? "")}`);
  lines.push(`Status: ${invoice.status ?? ""}`);
  lines.push(`Token: ${truncateAddress(invoice.token ?? "")}`);
  lines.push(`Deadline: ${new Date((invoice.deadline ?? 0) * 1000).toISOString()}`);
  lines.push(`Funded: ${formatAmount(invoice.funded ?? 0n)} USDC`);
  lines.push("");
  lines.push("Recipients:");
  for (const recipient of invoice.recipients ?? []) {
    lines.push(
      `  - ${truncateAddress(recipient.address)}: ${formatAmount(recipient.amount)} USDC`
    );
  }
  if ((invoice.payments ?? []).length > 0) {
    lines.push("");
    lines.push("Payments:");
    for (const payment of invoice.payments ?? []) {
      lines.push(
        `  - ${truncateAddress(payment.payer)}: ${formatAmount(payment.amount)} USDC`
      );
    }
  }
  return lines.join("\n");
}

/**
 * Register a custom export format via a builder function.
 * Enables plugins to add formats (e.g. HTML, Markdown) without forking.
 */
export interface ExportBuilder {
  (invoice: Invoice): string;
  format: string;
}
const builders = new Map<string, ExportBuilder>();

export function registerExportBuilder(format: string, builder: ExportBuilder): void {
  builders.set(format, builder);
}

export function listExportBuilders(): string[] {
  return Array.from(builders.keys());
}
