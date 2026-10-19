import { BaseClientModule } from "./BaseModule.js";
import type {
  Invoice,
  CreateInvoiceParams,
  SimulationResult,
  InvoiceStatus,
  InvoiceFilter,
  InvoicePage,
  InvoiceSnapshot,
} from "../../types.js";
import type { PerMethodRetryOptions } from "../../retryPolicy.js";

/**
 * Module dedicated to Invoice lifecycle operations: creation, querying,
 * updates, cloning, snapshots, and verification.
 */
export class InvoiceModule extends BaseClientModule {
  /**
   * Creates a new invoice on-chain, or simulates creation when `simulate: true`.
   */
  async create<TMetadata = Record<string, unknown>>(
    params: CreateInvoiceParams<TMetadata> & { simulate: true }
  ): Promise<SimulationResult>;
  async create<TMetadata = Record<string, unknown>>(
    params: CreateInvoiceParams<TMetadata>
  ): Promise<{ invoiceId: string; txHash: string }>;
  async create<TMetadata = Record<string, unknown>>(
    params: CreateInvoiceParams<TMetadata>
  ): Promise<{ invoiceId: string; txHash: string } | SimulationResult> {
    return this.client.createInvoice(params as any);
  }

  /** Alias for `create`. */
  async createInvoice<TMetadata = Record<string, unknown>>(
    params: CreateInvoiceParams<TMetadata> & { simulate: true }
  ): Promise<SimulationResult>;
  async createInvoice<TMetadata = Record<string, unknown>>(
    params: CreateInvoiceParams<TMetadata>
  ): Promise<{ invoiceId: string; txHash: string }>;
  async createInvoice<TMetadata = Record<string, unknown>>(
    params: CreateInvoiceParams<TMetadata>
  ): Promise<{ invoiceId: string; txHash: string } | SimulationResult> {
    return this.create(params as any);
  }

  /**
   * Retrieves an invoice by ID.
   */
  async get<TMetadata = Record<string, unknown>, TStatus extends InvoiceStatus = InvoiceStatus>(
    invoiceId: string,
    opts?: { retry?: PerMethodRetryOptions; dedupe?: boolean; traceId?: string; timeout?: number }
  ): Promise<Invoice<TMetadata, TStatus>> {
    return this.client.getInvoice(invoiceId, opts) as Promise<Invoice<TMetadata, TStatus>>;
  }

  /** Alias for `get`. */
  async getInvoice<TMetadata = Record<string, unknown>, TStatus extends InvoiceStatus = InvoiceStatus>(
    invoiceId: string,
    opts?: { retry?: PerMethodRetryOptions; dedupe?: boolean; traceId?: string; timeout?: number }
  ): Promise<Invoice<TMetadata, TStatus>> {
    return this.get(invoiceId, opts);
  }

  /**
   * Clones an existing invoice with optional parameter overrides.
   */
  async clone(
    invoiceId: string,
    overrides?: Partial<CreateInvoiceParams>
  ): Promise<string> {
    return this.client.cloneInvoice(invoiceId, overrides);
  }

  /** Alias for `clone`. */
  async cloneInvoice(
    invoiceId: string,
    overrides?: Partial<CreateInvoiceParams>
  ): Promise<string> {
    return this.clone(invoiceId, overrides);
  }

  /**
   * Updates an invoice with the provided changes.
   */
  async update(invoiceId: string, updates: Partial<Invoice>): Promise<Invoice> {
    return this.client.updateInvoice(invoiceId, updates);
  }

  /** Alias for `update`. */
  async updateInvoice(invoiceId: string, updates: Partial<Invoice>): Promise<Invoice> {
    return this.update(invoiceId, updates);
  }

  /**
   * Updates the lifecycle status of an invoice.
   */
  async updateStatus(invoiceId: string, to: InvoiceStatus): Promise<Invoice> {
    return this.client.updateInvoiceStatus(invoiceId, to);
  }

  /** Alias for `updateStatus`. */
  async updateInvoiceStatus(invoiceId: string, to: InvoiceStatus): Promise<Invoice> {
    return this.updateStatus(invoiceId, to);
  }

  /**
   * Queries invoices with filtering options.
   */
  async query<TMetadata = Record<string, unknown>>(filter: InvoiceFilter = {}): Promise<InvoicePage> {
    return this.client.queryInvoices(filter);
  }

  /** Alias for `query`. */
  async queryInvoices<TMetadata = Record<string, unknown>>(filter: InvoiceFilter = {}): Promise<InvoicePage> {
    return this.query(filter);
  }

  /**
   * Cancels an invoice.
   */
  async cancel(invoiceId: string) {
    return this.client.cancel(invoiceId);
  }

  /**
   * Finalizes an invoice on-chain.
   */
  async finalize(invoiceId: string, caller?: string) {
    return this.client.finalizeInvoice(invoiceId, caller);
  }

  /** Alias for `finalize`. */
  async finalizeInvoice(invoiceId: string, caller?: string) {
    return this.finalize(invoiceId, caller);
  }

  /**
   * Synchronizes an invoice's on-chain state with optimistic tracking.
   */
  async sync(invoiceId: string, options?: { traceId?: string; timeout?: number }) {
    return this.client.syncInvoice(invoiceId, options);
  }

  /** Alias for `sync`. */
  async syncInvoice(invoiceId: string, options?: { traceId?: string; timeout?: number }) {
    return this.sync(invoiceId, options);
  }

  /**
   * Takes a point-in-time snapshot of an invoice.
   */
  async snapshot(invoiceId: string): Promise<InvoiceSnapshot> {
    return this.client.snapshotInvoice(invoiceId);
  }

  /** Alias for `snapshot`. */
  async snapshotInvoice(invoiceId: string): Promise<InvoiceSnapshot> {
    return this.snapshot(invoiceId);
  }

  /**
   * Verifies the cryptographic hash of an invoice.
   */
  async verify(invoice: Invoice, expectedHash: string): Promise<boolean> {
    return this.client.verifyInvoice(invoice, expectedHash);
  }

  /** Alias for `verify`. */
  async verifyInvoice(invoice: Invoice, expectedHash: string): Promise<boolean> {
    return this.verify(invoice, expectedHash);
  }

  /**
   * Fetches invoices created by a specific creator address.
   */
  async getByCreator(
    creator: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<Invoice[]> {
    return this.client.getInvoicesByCreator(creator, opts);
  }

  /** Alias for `getByCreator`. */
  async getInvoicesByCreator(
    creator: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<Invoice[]> {
    return this.getByCreator(creator, opts);
  }

  /**
   * Fetches invoices where the specified address is a recipient.
   */
  async getByRecipient(
    recipient: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<Invoice[]> {
    return this.client.getInvoicesByRecipient(recipient, opts);
  }

  /** Alias for `getByRecipient`. */
  async getInvoicesByRecipient(
    recipient: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<Invoice[]> {
    return this.getByRecipient(recipient, opts);
  }

  /**
   * Resolves the full ancestor/descendant clone chain for an invoice.
   */
  async resolveCloneChain(invoiceId: string): Promise<Invoice[]> {
    return this.client.resolveCloneChain(invoiceId);
  }

  /**
   * Retrieves the lineage IDs for a cloned invoice.
   */
  async getLineage(invoiceId: string | bigint): Promise<bigint[]> {
    return this.client.getLineage(invoiceId);
  }
}
