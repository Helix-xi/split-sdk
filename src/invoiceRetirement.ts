/**
 * InvoiceRetirementManager — issue #981
 *
 * Provides lifecycle management for retiring and archiving invoices that
 * have reached a terminal state (Released, Refunded, or Cancelled).
 * Retired invoices are moved to an immutable archive with metadata,
 * supporting bulk operations, event callbacks, and configurable retention.
 */

import type { Invoice, InvoiceStatus } from "./types.js";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Statuses that are eligible for retirement. */
export const RETIRABLE_STATUSES: ReadonlySet<InvoiceStatus> = new Set<InvoiceStatus>([
  "Released",
  "Refunded",
  "Cancelled",
]);

/** A fully archived invoice record. */
export interface ArchivedInvoiceRecord {
  /** The original invoice. */
  invoice: Invoice;
  /** Unix timestamp in seconds when the invoice was archived. */
  archivedAt: number;
  /** Optional free-form note attached at retirement time. */
  note?: string;
  /** The reason category supplied by the caller. */
  reason: RetirementReason;
}

/** Reason categories for retiring an invoice. */
export type RetirementReason =
  | "completed"   // invoice was released/paid out
  | "refunded"    // invoice was refunded
  | "cancelled"   // invoice was explicitly cancelled
  | "expired"     // deadline passed with no action
  | "manual";     // operator-initiated manual retirement

/** Options for a single retirement operation. */
export interface RetireOptions {
  /** Reason category for the retirement. @default "manual" */
  reason?: RetirementReason;
  /** Optional human-readable note to store with the archive record. */
  note?: string;
  /**
   * When true, skip the status eligibility check and retire the invoice
   * regardless of its current status. Use with caution.
   * @default false
   */
  force?: boolean;
}

/** Result of a bulk retirement operation. */
export interface BulkRetirementResult {
  /** IDs of invoices that were successfully retired. */
  retired: string[];
  /** IDs of invoices that were skipped (already archived or ineligible). */
  skipped: string[];
  /** Errors encountered per invoice ID. */
  errors: Array<{ invoiceId: string; error: string }>;
}

/** Options for configuring the retirement manager. */
export interface RetirementManagerOptions {
  /**
   * Maximum number of records to keep in the in-memory archive.
   * Oldest entries are evicted first when the limit is exceeded.
   * Set to 0 for unlimited.
   * @default 0
   */
  maxArchiveSize?: number;
  /**
   * Retention duration in seconds. Records older than this value are
   * automatically pruned on the next archive access.
   * Set to 0 to disable automatic pruning.
   * @default 0
   */
  retentionSeconds?: number;
}

/** Events emitted by the retirement manager. */
export type RetirementEventMap = {
  /** Fired when an invoice is successfully archived. */
  retired: ArchivedInvoiceRecord;
  /** Fired when an archived record is evicted due to size or retention limits. */
  evicted: ArchivedInvoiceRecord;
  /** Fired when a retirement attempt is rejected (e.g. ineligible status). */
  rejected: { invoice: Invoice; reason: string };
};

type RetirementEventHandler<K extends keyof RetirementEventMap> = (
  payload: RetirementEventMap[K]
) => void;

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * InvoiceRetirementManager handles the archival of terminal invoices.
 *
 * @example
 * ```ts
 * const manager = new InvoiceRetirementManager();
 * manager.on("retired", (rec) => console.log("archived:", rec.invoice.id));
 *
 * manager.retire(invoice);
 * const archive = manager.getArchive();
 * ```
 */
export class InvoiceRetirementManager {
  private archive: Map<string, ArchivedInvoiceRecord> = new Map();
  private readonly options: Required<RetirementManagerOptions>;
  private readonly listeners = new Map<
    keyof RetirementEventMap,
    Array<RetirementEventHandler<keyof RetirementEventMap>>
  >();

  constructor(options: RetirementManagerOptions = {}) {
    this.options = {
      maxArchiveSize: options.maxArchiveSize ?? 0,
      retentionSeconds: options.retentionSeconds ?? 0,
    };

    if (this.options.maxArchiveSize < 0) {
      throw new ValidationError("maxArchiveSize must be >= 0");
    }
    if (this.options.retentionSeconds < 0) {
      throw new ValidationError("retentionSeconds must be >= 0");
    }
  }

  // ---- Event handling -----------------------------------------------------

  on<K extends keyof RetirementEventMap>(
    event: K,
    handler: RetirementEventHandler<K>
  ): this {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners
      .get(event)!
      .push(handler as RetirementEventHandler<keyof RetirementEventMap>);
    return this;
  }

  off<K extends keyof RetirementEventMap>(
    event: K,
    handler: RetirementEventHandler<K>
  ): this {
    const handlers = this.listeners.get(event);
    if (!handlers) return this;
    const idx = handlers.indexOf(
      handler as RetirementEventHandler<keyof RetirementEventMap>
    );
    if (idx >= 0) handlers.splice(idx, 1);
    return this;
  }

  private emit<K extends keyof RetirementEventMap>(
    event: K,
    payload: RetirementEventMap[K]
  ): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      (h as RetirementEventHandler<K>)(payload);
    }
  }

  // ---- Retirement ---------------------------------------------------------

  /**
   * Retire a single invoice, moving it into the archive.
   *
   * @throws {ValidationError} if the invoice is already archived or is in a
   *   non-terminal status (unless `force: true` is passed).
   */
  retire(invoice: Invoice, opts: RetireOptions = {}): ArchivedInvoiceRecord {
    const invoiceId = String(invoice.id);
    const { reason = "manual", note, force = false } = opts;

    if (this.archive.has(invoiceId)) {
      throw new ValidationError(`Invoice ${invoiceId} is already archived`);
    }

    if (!force && !RETIRABLE_STATUSES.has(invoice.status)) {
      const msg = `Invoice ${invoiceId} has status "${invoice.status}" which is not eligible for retirement`;
      this.emit("rejected", { invoice, reason: msg });
      throw new ValidationError(msg);
    }

    const record: ArchivedInvoiceRecord = {
      invoice,
      archivedAt: Math.floor(Date.now() / 1000),
      reason,
      ...(note !== undefined ? { note } : {}),
    };

    this.archive.set(invoiceId, record);
    this._enforceMaxSize();
    this.emit("retired", record);
    return record;
  }

  /**
   * Retire multiple invoices in a single call.
   * Failures are collected rather than thrown so the batch continues.
   */
  retireMany(
    invoices: Invoice[],
    opts: RetireOptions = {}
  ): BulkRetirementResult {
    const result: BulkRetirementResult = {
      retired: [],
      skipped: [],
      errors: [],
    };

    for (const invoice of invoices) {
      const invoiceId = String(invoice.id);
      try {
        if (this.archive.has(invoiceId)) {
          result.skipped.push(invoiceId);
          continue;
        }
        this.retire(invoice, opts);
        result.retired.push(invoiceId);
      } catch (err) {
        result.errors.push({
          invoiceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  // ---- Querying the archive -----------------------------------------------

  /**
   * Check whether an invoice has been archived.
   */
  isRetired(invoiceId: string): boolean {
    this._pruneExpired();
    return this.archive.has(invoiceId);
  }

  /**
   * Retrieve a single archived record by invoice ID.
   * Returns `undefined` if not found.
   */
  getRecord(invoiceId: string): ArchivedInvoiceRecord | undefined {
    this._pruneExpired();
    return this.archive.get(invoiceId);
  }

  /**
   * Return all archived records, optionally filtered by retirement reason.
   * Results are sorted by `archivedAt` ascending (oldest first).
   */
  getArchive(filter?: { reason?: RetirementReason }): ArchivedInvoiceRecord[] {
    this._pruneExpired();
    let records = [...this.archive.values()];
    if (filter?.reason !== undefined) {
      records = records.filter((r) => r.reason === filter.reason);
    }
    return records.sort((a, b) => a.archivedAt - b.archivedAt);
  }

  /** Total number of records currently in the archive. */
  get size(): number {
    this._pruneExpired();
    return this.archive.size;
  }

  // ---- Archive management -------------------------------------------------

  /**
   * Manually remove a record from the archive.
   * Returns `true` if the record existed and was removed.
   */
  unretire(invoiceId: string): boolean {
    return this.archive.delete(invoiceId);
  }

  /** Clear the entire archive. */
  clearArchive(): void {
    this.archive.clear();
  }

  // ---- Internals ----------------------------------------------------------

  /**
   * Evict the oldest record when the archive exceeds `maxArchiveSize`.
   */
  private _enforceMaxSize(): void {
    const max = this.options.maxArchiveSize;
    if (max === 0) return;

    while (this.archive.size > max) {
      // Map preserves insertion order — first key is the oldest entry.
      const oldestKey = this.archive.keys().next().value as string;
      const evicted = this.archive.get(oldestKey)!;
      this.archive.delete(oldestKey);
      this.emit("evicted", evicted);
    }
  }

  /**
   * Remove records whose `archivedAt` age exceeds `retentionSeconds`.
   */
  private _pruneExpired(): void {
    const retention = this.options.retentionSeconds;
    if (retention === 0) return;

    const cutoff = Math.floor(Date.now() / 1000) - retention;
    for (const [key, record] of this.archive) {
      if (record.archivedAt < cutoff) {
        this.archive.delete(key);
        this.emit("evicted", record);
      }
    }
  }
}
