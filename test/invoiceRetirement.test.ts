import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  InvoiceRetirementManager,
  RETIRABLE_STATUSES,
  type RetireOptions,
} from "../src/invoiceRetirement.js";
import type { Invoice } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvoice(overrides: Partial<Invoice> & { id: string }): Invoice {
  return {
    id: overrides.id,
    creator: overrides.creator ?? "GCREATOR",
    recipients: overrides.recipients ?? [{ address: "GRECIPIENT", amount: 100n }],
    token: overrides.token ?? "USDC",
    deadline: overrides.deadline ?? 9_999_999_999,
    funded: overrides.funded ?? 100n,
    status: overrides.status ?? "Released",
    payments: overrides.payments ?? [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RETIRABLE_STATUSES
// ---------------------------------------------------------------------------

describe("RETIRABLE_STATUSES", () => {
  it("contains Released, Refunded, Cancelled", () => {
    expect(RETIRABLE_STATUSES.has("Released")).toBe(true);
    expect(RETIRABLE_STATUSES.has("Refunded")).toBe(true);
    expect(RETIRABLE_STATUSES.has("Cancelled")).toBe(true);
  });

  it("does not contain Pending", () => {
    expect(RETIRABLE_STATUSES.has("Pending")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("InvoiceRetirementManager — constructor", () => {
  it("creates with defaults", () => {
    expect(() => new InvoiceRetirementManager()).not.toThrow();
  });

  it("throws when maxArchiveSize is negative", () => {
    expect(() => new InvoiceRetirementManager({ maxArchiveSize: -1 })).toThrow(
      "maxArchiveSize"
    );
  });

  it("throws when retentionSeconds is negative", () => {
    expect(() => new InvoiceRetirementManager({ retentionSeconds: -1 })).toThrow(
      "retentionSeconds"
    );
  });
});

// ---------------------------------------------------------------------------
// retire() — basic behaviour
// ---------------------------------------------------------------------------

describe("InvoiceRetirementManager — retire()", () => {
  let mgr: InvoiceRetirementManager;

  beforeEach(() => {
    mgr = new InvoiceRetirementManager();
  });

  it("archives a Released invoice", () => {
    const inv = makeInvoice({ id: "1", status: "Released" });
    const record = mgr.retire(inv);
    expect(record.invoice).toBe(inv);
    expect(record.reason).toBe("manual");
    expect(typeof record.archivedAt).toBe("number");
  });

  it("archives a Refunded invoice", () => {
    const inv = makeInvoice({ id: "2", status: "Refunded" });
    expect(() => mgr.retire(inv)).not.toThrow();
  });

  it("archives a Cancelled invoice", () => {
    const inv = makeInvoice({ id: "3", status: "Cancelled" });
    expect(() => mgr.retire(inv)).not.toThrow();
  });

  it("stores supplied reason and note", () => {
    const inv = makeInvoice({ id: "4", status: "Released" });
    const record = mgr.retire(inv, { reason: "completed", note: "paid in full" });
    expect(record.reason).toBe("completed");
    expect(record.note).toBe("paid in full");
  });

  it("throws when already archived", () => {
    const inv = makeInvoice({ id: "5", status: "Released" });
    mgr.retire(inv);
    expect(() => mgr.retire(inv)).toThrow("already archived");
  });

  it("throws for Pending invoice without force", () => {
    const inv = makeInvoice({ id: "6", status: "Pending" });
    expect(() => mgr.retire(inv)).toThrow("not eligible");
  });

  it("force-retires a Pending invoice", () => {
    const inv = makeInvoice({ id: "7", status: "Pending" });
    expect(() => mgr.retire(inv, { force: true })).not.toThrow();
    expect(mgr.isRetired("7")).toBe(true);
  });

  it("archivedAt is a reasonable Unix timestamp", () => {
    const before = Math.floor(Date.now() / 1000) - 1;
    const inv = makeInvoice({ id: "8", status: "Released" });
    const record = mgr.retire(inv);
    const after = Math.floor(Date.now() / 1000) + 1;
    expect(record.archivedAt).toBeGreaterThanOrEqual(before);
    expect(record.archivedAt).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// retireMany()
// ---------------------------------------------------------------------------

describe("InvoiceRetirementManager — retireMany()", () => {
  let mgr: InvoiceRetirementManager;

  beforeEach(() => {
    mgr = new InvoiceRetirementManager();
  });

  it("retires all eligible invoices", () => {
    const invoices = [
      makeInvoice({ id: "1", status: "Released" }),
      makeInvoice({ id: "2", status: "Refunded" }),
      makeInvoice({ id: "3", status: "Cancelled" }),
    ];
    const result = mgr.retireMany(invoices);
    expect(result.retired).toEqual(expect.arrayContaining(["1", "2", "3"]));
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("skips already-archived invoices", () => {
    const inv = makeInvoice({ id: "1", status: "Released" });
    mgr.retire(inv);
    const result = mgr.retireMany([inv]);
    expect(result.skipped).toContain("1");
    expect(result.retired).toHaveLength(0);
  });

  it("collects errors without throwing", () => {
    const invoices = [
      makeInvoice({ id: "1", status: "Released" }),
      makeInvoice({ id: "2", status: "Pending" }), // ineligible
    ];
    const result = mgr.retireMany(invoices);
    expect(result.retired).toContain("1");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].invoiceId).toBe("2");
  });

  it("passes opts to each retire call", () => {
    const invoices = [makeInvoice({ id: "1", status: "Released" })];
    const result = mgr.retireMany(invoices, { reason: "completed", note: "batch" });
    expect(result.retired).toContain("1");
    expect(mgr.getRecord("1")?.reason).toBe("completed");
    expect(mgr.getRecord("1")?.note).toBe("batch");
  });
});

// ---------------------------------------------------------------------------
// isRetired() / getRecord() / getArchive()
// ---------------------------------------------------------------------------

describe("InvoiceRetirementManager — query methods", () => {
  let mgr: InvoiceRetirementManager;

  beforeEach(() => {
    mgr = new InvoiceRetirementManager();
  });

  it("isRetired returns false for unknown invoice", () => {
    expect(mgr.isRetired("unknown")).toBe(false);
  });

  it("isRetired returns true after retirement", () => {
    mgr.retire(makeInvoice({ id: "1", status: "Released" }));
    expect(mgr.isRetired("1")).toBe(true);
  });

  it("getRecord returns undefined for unknown invoice", () => {
    expect(mgr.getRecord("unknown")).toBeUndefined();
  });

  it("getRecord returns the archived record", () => {
    const inv = makeInvoice({ id: "2", status: "Cancelled" });
    mgr.retire(inv, { reason: "cancelled" });
    const record = mgr.getRecord("2");
    expect(record?.invoice).toBe(inv);
    expect(record?.reason).toBe("cancelled");
  });

  it("getArchive returns all records sorted by archivedAt ascending", () => {
    // Use fake timers to ensure ordering
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000_000 * 1000);
      mgr.retire(makeInvoice({ id: "first", status: "Released" }));
      vi.setSystemTime(1_000_000_001 * 1000);
      mgr.retire(makeInvoice({ id: "second", status: "Released" }));
      const archive = mgr.getArchive();
      expect(archive.map((r) => r.invoice.id)).toEqual(["first", "second"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("getArchive filters by reason", () => {
    mgr.retire(makeInvoice({ id: "1", status: "Released" }), { reason: "completed" });
    mgr.retire(makeInvoice({ id: "2", status: "Refunded" }), { reason: "refunded" });
    const filtered = mgr.getArchive({ reason: "completed" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].invoice.id).toBe("1");
  });

  it("size reflects the current archive count", () => {
    expect(mgr.size).toBe(0);
    mgr.retire(makeInvoice({ id: "1", status: "Released" }));
    expect(mgr.size).toBe(1);
    mgr.retire(makeInvoice({ id: "2", status: "Cancelled" }));
    expect(mgr.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// unretire() and clearArchive()
// ---------------------------------------------------------------------------

describe("InvoiceRetirementManager — unretire() and clearArchive()", () => {
  let mgr: InvoiceRetirementManager;

  beforeEach(() => {
    mgr = new InvoiceRetirementManager();
  });

  it("unretire removes the record and returns true", () => {
    mgr.retire(makeInvoice({ id: "1", status: "Released" }));
    expect(mgr.unretire("1")).toBe(true);
    expect(mgr.isRetired("1")).toBe(false);
  });

  it("unretire returns false for unknown invoice", () => {
    expect(mgr.unretire("nope")).toBe(false);
  });

  it("clearArchive empties the archive", () => {
    mgr.retire(makeInvoice({ id: "1", status: "Released" }));
    mgr.retire(makeInvoice({ id: "2", status: "Refunded" }));
    mgr.clearArchive();
    expect(mgr.size).toBe(0);
    expect(mgr.getArchive()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// maxArchiveSize eviction
// ---------------------------------------------------------------------------

describe("InvoiceRetirementManager — maxArchiveSize", () => {
  it("evicts the oldest record when the limit is exceeded", () => {
    const mgr = new InvoiceRetirementManager({ maxArchiveSize: 2 });
    const evicted: string[] = [];
    mgr.on("evicted", (rec) => evicted.push(rec.invoice.id));

    mgr.retire(makeInvoice({ id: "1", status: "Released" }));
    mgr.retire(makeInvoice({ id: "2", status: "Released" }));
    mgr.retire(makeInvoice({ id: "3", status: "Released" })); // triggers eviction of "1"

    expect(evicted).toContain("1");
    expect(mgr.size).toBe(2);
    expect(mgr.isRetired("1")).toBe(false);
    expect(mgr.isRetired("2")).toBe(true);
    expect(mgr.isRetired("3")).toBe(true);
  });

  it("size 0 means unlimited", () => {
    const mgr = new InvoiceRetirementManager({ maxArchiveSize: 0 });
    for (let i = 0; i < 50; i++) {
      mgr.retire(makeInvoice({ id: String(i), status: "Released" }));
    }
    expect(mgr.size).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// retentionSeconds pruning
// ---------------------------------------------------------------------------

describe("InvoiceRetirementManager — retentionSeconds", () => {
  it("prunes records older than retentionSeconds on next access", () => {
    vi.useFakeTimers();
    try {
      const mgr = new InvoiceRetirementManager({ retentionSeconds: 60 });
      const evicted: string[] = [];
      mgr.on("evicted", (rec) => evicted.push(rec.invoice.id));

      vi.setSystemTime(0);
      mgr.retire(makeInvoice({ id: "old", status: "Released" }));

      vi.setSystemTime(120_000); // advance 120 seconds
      mgr.retire(makeInvoice({ id: "new", status: "Released" }));

      // Access triggers pruning
      const archive = mgr.getArchive();
      expect(archive.map((r) => r.invoice.id)).not.toContain("old");
      expect(archive.map((r) => r.invoice.id)).toContain("new");
      expect(evicted).toContain("old");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retentionSeconds 0 means no pruning", () => {
    vi.useFakeTimers();
    try {
      const mgr = new InvoiceRetirementManager({ retentionSeconds: 0 });
      vi.setSystemTime(0);
      mgr.retire(makeInvoice({ id: "1", status: "Released" }));
      vi.setSystemTime(999_999_999_000); // far future
      expect(mgr.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("InvoiceRetirementManager — events", () => {
  let mgr: InvoiceRetirementManager;

  beforeEach(() => {
    mgr = new InvoiceRetirementManager();
  });

  it("emits 'retired' on successful archival", () => {
    const handler = vi.fn();
    mgr.on("retired", handler);
    const inv = makeInvoice({ id: "1", status: "Released" });
    mgr.retire(inv);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].invoice).toBe(inv);
  });

  it("emits 'rejected' for ineligible status", () => {
    const handler = vi.fn();
    mgr.on("rejected", handler);
    const inv = makeInvoice({ id: "1", status: "Pending" });
    try {
      mgr.retire(inv);
    } catch {
      // expected
    }
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].invoice).toBe(inv);
  });

  it("does not emit 'rejected' when force:true", () => {
    const handler = vi.fn();
    mgr.on("rejected", handler);
    mgr.retire(makeInvoice({ id: "1", status: "Pending" }), { force: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("off() removes a listener", () => {
    const handler = vi.fn();
    mgr.on("retired", handler);
    mgr.off("retired", handler);
    mgr.retire(makeInvoice({ id: "1", status: "Released" }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("emits 'evicted' when maxArchiveSize is exceeded", () => {
    const mgr2 = new InvoiceRetirementManager({ maxArchiveSize: 1 });
    const handler = vi.fn();
    mgr2.on("evicted", handler);
    mgr2.retire(makeInvoice({ id: "1", status: "Released" }));
    mgr2.retire(makeInvoice({ id: "2", status: "Released" }));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].invoice.id).toBe("1");
  });
});
