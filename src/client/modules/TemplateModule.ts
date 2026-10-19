import { BaseClientModule } from "./BaseModule.js";
import type { TxResult } from "../../client.js";
import type {
  Invoice,
  CreateInvoiceParams,
} from "../../types.js";
import type { InvoiceTemplate } from "../../templateManager.js";

/**
 * Module dedicated to Invoice Templates and Recurring Invoice operations.
 */
export class TemplateModule extends BaseClientModule {
  /**
   * Saves an invoice template.
   */
  async save(template: InvoiceTemplate): Promise<TxResult> {
    return this.client.saveTemplate(template);
  }

  /** Alias for `save`. */
  async saveTemplate(template: InvoiceTemplate): Promise<TxResult> {
    return this.save(template);
  }

  /**
   * Creates a new invoice from a saved template.
   */
  async createFromTemplate(
    templateName: string,
    overrides?: Partial<CreateInvoiceParams>
  ): Promise<string> {
    return this.client.createFromTemplate(templateName, overrides);
  }

  /**
   * Lists all templates saved by a creator address.
   */
  async list(creator: string): Promise<string[]> {
    return this.client.listTemplates(creator);
  }

  /** Alias for `list`. */
  async listTemplates(creator: string): Promise<string[]> {
    return this.list(creator);
  }

  /**
   * Retrieves recurring invoices created by an address.
   */
  async getRecurring(creator: string): Promise<Invoice[]> {
    return this.client.getRecurringInvoices(creator);
  }

  /** Alias for `getRecurring`. */
  async getRecurringInvoices(creator: string): Promise<Invoice[]> {
    return this.getRecurring(creator);
  }

  /**
   * Cancels a recurring invoice.
   */
  async cancelRecurring(invoiceId: string, creator: string): Promise<TxResult> {
    return this.client.cancelRecurring(invoiceId, creator);
  }

  /**
   * Updates the recurring amount on an invoice.
   */
  async updateRecurringAmount(
    invoiceId: string,
    creator: string,
    newAmount: bigint
  ): Promise<TxResult> {
    return this.client.updateRecurringAmount(invoiceId, creator, newAmount);
  }
}
