/**
 * @smoke
 *
 * SDK API Surface Smoke Test
 *
 * Calls every public method on MockStellarSplitClient at least once with valid
 * inputs. Serves as living documentation of the full client API surface and
 * guarantees no method is silently broken by a refactor.
 *
 * Run with:
 *   npm run test:smoke
 *
 * Uses MockStellarSplitClient — no RPC endpoint or deployed contract required.
 *
 * Closes #890
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockStellarSplitClient } from "../src/mock/index.js";
import type { CallRecord } from "../src/mock/index.js";
import type {
  Invoice,
  Payment,
  InvoiceEvent,
  Subscription,
  PaginatedResult,
} from "../src/types.js";
import { InvoiceNotFoundError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CREATOR = "GCREATOR0000000000000000000000000000000000000000000000000000";
const RECIPIENT = "GREC1PIENT000000000000000000000000000000000000000000000000";
const TOKEN = "USDC_CONTRACT_ADDRESS";
const AMOUNT = 1_000_000n; // 0.1 USDC in stroops
const DEADLINE = Math.floor(Date.now() / 1000) + 86_400 * 7; // 7 days from now

/** Reusable createInvoice params. */
function makeCreateParams(overrides: Partial<Parameters<MockStellarSplitClient["createInvoice"]>[0]> = {}) {
  return {
    creator: CREATOR,
    recipients: [{ address: RECIPIENT, amount: AMOUNT }],
    token: TOKEN,
    deadline: DEADLINE,
    ...overrides,
  };
}

/** Pre-built invoice for setInvoice helpers. */
function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "1",
    creator: CREATOR,
    recipients: [{ address: RECIPIENT, amount: AMOUNT }],
    token: TOKEN,
    deadline: DEADLINE,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("@smoke MockStellarSplitClient — full API surface", () => {
  let client: MockStellarSplitClient;

  beforeEach(() => {
    client = new MockStellarSplitClient();
  });

  // -----------------------------------------------------------------------
  // createInvoice — creates an invoice and returns { invoiceId, txHash }
  // -----------------------------------------------------------------------
  it("createInvoice: creates an invoice and returns invoiceId + txHash", async () => {
    const result = await client.createInvoice(makeCreateParams());

    expect(typeof result.invoiceId).toBe("string");
    expect(result.invoiceId.length).toBeGreaterThan(0);
    expect(typeof result.txHash).toBe("string");
    expect(result.txHash.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // getInvoice — retrieves a previously created invoice by ID
  // -----------------------------------------------------------------------
  it("getInvoice: returns the invoice that was created", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());

    const invoice: Invoice = await client.getInvoice(invoiceId);

    expect(invoice.id).toBe(invoiceId);
    expect(invoice.creator).toBe(CREATOR);
    expect(invoice.status).toBe("Pending");
    expect(Array.isArray(invoice.recipients)).toBe(true);
    expect(Array.isArray(invoice.payments)).toBe(true);
    expect(typeof invoice.funded).toBe("bigint");
  });

  // -----------------------------------------------------------------------
  // getInvoice (not found) — throws InvoiceNotFoundError for unknown IDs
  // -----------------------------------------------------------------------
  it("getInvoice (not found): throws InvoiceNotFoundError for unknown ID", async () => {
    await expect(client.getInvoice("nonexistent-id")).rejects.toBeInstanceOf(
      InvoiceNotFoundError,
    );
  });

  // -----------------------------------------------------------------------
  // pay — submits a payment and returns { txHash }
  // -----------------------------------------------------------------------
  it("pay: submits a payment and returns txHash", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());

    const result = await client.pay({
      payer: CREATOR,
      invoiceId,
      amount: AMOUNT,
    });

    expect(typeof result.txHash).toBe("string");
    expect(result.txHash.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // pay — funded amount is updated on the invoice after payment
  // -----------------------------------------------------------------------
  it("pay: funded amount is updated on the invoice after payment", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    await client.pay({ payer: CREATOR, invoiceId, amount: AMOUNT });

    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.funded).toBe(AMOUNT);
  });

  // -----------------------------------------------------------------------
  // getPayments — returns the payment list for an invoice
  // -----------------------------------------------------------------------
  it("getPayments: returns payments array for an invoice", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    await client.pay({ payer: CREATOR, invoiceId, amount: AMOUNT });

    const payments: Payment[] = await client.getPayments(invoiceId);

    expect(Array.isArray(payments)).toBe(true);
    expect(payments).toHaveLength(1);
    expect(payments[0].payer).toBe(CREATOR);
    expect(payments[0].amount).toBe(AMOUNT);
  });

  // -----------------------------------------------------------------------
  // getPayments — returns empty array for an invoice with no payments
  // -----------------------------------------------------------------------
  it("getPayments: returns empty array when no payments exist", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    const payments = await client.getPayments(invoiceId);
    expect(payments).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // getInvoicesByCreator — paginates invoices belonging to a creator
  // -----------------------------------------------------------------------
  it("getInvoicesByCreator: returns paginated invoices for creator", async () => {
    await client.createInvoice(makeCreateParams());
    await client.createInvoice(makeCreateParams());

    const page: PaginatedResult<string> = await client.getInvoicesByCreator(CREATOR);

    expect(Array.isArray(page.items)).toBe(true);
    expect(page.items.length).toBeGreaterThanOrEqual(2);
    expect(typeof page.total).toBe("number");
    // nextCursor is either null or a string
    expect(page.nextCursor === null || typeof page.nextCursor === "string").toBe(true);
  });

  // -----------------------------------------------------------------------
  // getInvoicesByCreator — respects pagination limit option
  // -----------------------------------------------------------------------
  it("getInvoicesByCreator: respects limit pagination option", async () => {
    await client.createInvoice(makeCreateParams());
    await client.createInvoice(makeCreateParams());
    await client.createInvoice(makeCreateParams());

    const page = await client.getInvoicesByCreator(CREATOR, { limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // getInvoicesByCreator — returns empty for a creator with no invoices
  // -----------------------------------------------------------------------
  it("getInvoicesByCreator: returns empty items for unknown creator", async () => {
    const page = await client.getInvoicesByCreator("UNKNOWN_CREATOR");
    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(0);
  });

  // -----------------------------------------------------------------------
  // releaseInvoice — transitions invoice status to Released
  // -----------------------------------------------------------------------
  it("releaseInvoice: sets invoice status to Released", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    const result = await client.releaseInvoice(invoiceId, CREATOR);

    expect(typeof result.txHash).toBe("string");
    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.status).toBe("Released");
  });

  // -----------------------------------------------------------------------
  // refundInvoice — transitions invoice status to Refunded
  // -----------------------------------------------------------------------
  it("refundInvoice: sets invoice status to Refunded", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    const result = await client.refundInvoice(invoiceId, CREATOR);

    expect(typeof result.txHash).toBe("string");
    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.status).toBe("Refunded");
  });

  // -----------------------------------------------------------------------
  // cancelInvoice — transitions invoice status to Cancelled
  // -----------------------------------------------------------------------
  it("cancelInvoice: sets invoice status to Cancelled", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    const result = await client.cancelInvoice(invoiceId, CREATOR);

    expect(typeof result.txHash).toBe("string");
    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.status).toBe("Cancelled");
  });

  // -----------------------------------------------------------------------
  // subscribeInvoice — returns a Subscription object with all expected methods
  // -----------------------------------------------------------------------
  it("subscribeInvoice: returns Subscription with lifecycle methods", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());

    const subscription: Subscription = client.subscribeInvoice(
      invoiceId,
      () => {},
    );

    // Verify the Subscription interface is fully implemented
    expect(typeof subscription.unsubscribe).toBe("function");
    expect(typeof subscription.pause).toBe("function");
    expect(typeof subscription.resume).toBe("function");
    expect(typeof subscription.getInvoiceId).toBe("function");
    expect(typeof subscription.isActive).toBe("function");
    expect(typeof subscription.isPaused).toBe("function");
  });

  // -----------------------------------------------------------------------
  // subscribeInvoice — isActive/isPaused/pause/resume lifecycle
  // -----------------------------------------------------------------------
  it("subscribeInvoice: isActive, isPaused, pause, resume lifecycle", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    const sub = client.subscribeInvoice(invoiceId, () => {});

    expect(sub.isActive()).toBe(true);
    expect(sub.isPaused()).toBe(false);

    sub.pause();
    expect(sub.isPaused()).toBe(true);

    sub.resume();
    expect(sub.isPaused()).toBe(false);

    sub.unsubscribe();
    expect(sub.isActive()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // subscribeInvoice — getInvoiceId returns the correct invoice ID
  // -----------------------------------------------------------------------
  it("subscribeInvoice: getInvoiceId returns the subscribed invoice ID", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    const sub = client.subscribeInvoice(invoiceId, () => {});

    expect(sub.getInvoiceId()).toBe(invoiceId);
    sub.unsubscribe();
  });

  // -----------------------------------------------------------------------
  // subscribeToInvoice — alternative subscribe API returning unsubscribe fn
  // -----------------------------------------------------------------------
  it("subscribeToInvoice: returns an unsubscribe function", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());

    const unsubscribe = client.subscribeToInvoice(invoiceId, () => {});

    expect(typeof unsubscribe).toBe("function");
    // Calling it should not throw
    expect(() => unsubscribe()).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // subscribeToInvoice — callback receives events dispatched via simulateEvent
  // -----------------------------------------------------------------------
  it("subscribeToInvoice: callback receives events from simulateEvent", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    const received: InvoiceEvent[] = [];

    const unsubscribe = client.subscribeToInvoice(invoiceId, (event) => {
      received.push(event);
    });

    const mockEvent: InvoiceEvent = {
      type: "payment",
      invoiceId,
      ledger: 100,
      timestamp: Date.now(),
      eventId: "evt-payment-1",
      payer: CREATOR,
      amount: AMOUNT,
    };
    client.simulateEvent(mockEvent);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("payment");
    unsubscribe();
  });

  // -----------------------------------------------------------------------
  // subscribeInvoice — callback receives events dispatched via simulateEvent
  // -----------------------------------------------------------------------
  it("subscribeInvoice: callback fires when simulateEvent dispatches an event", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    const received: InvoiceEvent[] = [];

    const sub = client.subscribeInvoice(invoiceId, (event) => {
      received.push(event);
    });

    client.simulateEvent({ type: "released", invoiceId, ledger: 200, timestamp: Date.now(), eventId: "evt-released-1", releasedBy: CREATOR, amount: AMOUNT });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("released");
    sub.unsubscribe();
  });

  // -----------------------------------------------------------------------
  // simulateEvent — does not dispatch to unsubscribed listeners
  // -----------------------------------------------------------------------
  it("simulateEvent: no dispatch after unsubscribe", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    const received: InvoiceEvent[] = [];
    const sub = client.subscribeInvoice(invoiceId, (e) => received.push(e));

    sub.unsubscribe();
    client.simulateEvent({ type: "payment", invoiceId, ledger: 300, timestamp: Date.now(), eventId: "evt-payment-3", payer: CREATOR, amount: AMOUNT });

    expect(received).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // setInvoice — pre-populates mock store for arrange-act-assert patterns
  // -----------------------------------------------------------------------
  it("setInvoice: pre-populates the store with a known invoice", async () => {
    client.setInvoice("custom-99", makeInvoice({ id: "custom-99", status: "Released" }));

    const invoice = await client.getInvoice("custom-99");
    expect(invoice.id).toBe("custom-99");
    expect(invoice.status).toBe("Released");
  });

  // -----------------------------------------------------------------------
  // getCallHistory — records every method call in order
  // -----------------------------------------------------------------------
  it("getCallHistory: records every method call", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    await client.getInvoice(invoiceId);
    await client.pay({ payer: CREATOR, invoiceId, amount: AMOUNT });

    const history: CallRecord[] = client.getCallHistory();

    expect(history.length).toBeGreaterThanOrEqual(3);
    expect(history[0].method).toBe("createInvoice");
    expect(history[1].method).toBe("getInvoice");
    expect(history[2].method).toBe("pay");
    // Each record has a numeric timestamp
    for (const record of history) {
      expect(typeof record.timestamp).toBe("number");
      expect(Array.isArray(record.args)).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // reset — clears invoices, call history and listeners atomically
  // -----------------------------------------------------------------------
  it("reset: clears invoices, call history and listeners", async () => {
    await client.createInvoice(makeCreateParams());
    client.subscribeInvoice("1", () => {});

    client.reset();

    // History cleared
    expect(client.getCallHistory()).toHaveLength(0);
    // Invoices cleared — ID counter also resets
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    expect(invoiceId).toBe("1");
  });

  // -----------------------------------------------------------------------
  // reset — ID counter restarts at 1 after reset
  // -----------------------------------------------------------------------
  it("reset: ID counter restarts at 1", async () => {
    await client.createInvoice(makeCreateParams()); // ID = 1
    await client.createInvoice(makeCreateParams()); // ID = 2

    client.reset();

    const { invoiceId } = await client.createInvoice(makeCreateParams());
    expect(invoiceId).toBe("1");
  });

  // -----------------------------------------------------------------------
  // pay (donateOnFailure) — optional field is persisted
  // -----------------------------------------------------------------------
  it("pay: donateOnFailure flag is persisted in payment record", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    await client.pay({ payer: CREATOR, invoiceId, amount: AMOUNT, donateOnFailure: true });

    const [payment] = await client.getPayments(invoiceId);
    expect(payment.donateOnFailure).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Multiple subscribers — all callbacks receive events
  // -----------------------------------------------------------------------
  it("multiple subscribers: all callbacks receive simulateEvent dispatch", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    const a: string[] = [];
    const b: string[] = [];

    const unsubA = client.subscribeToInvoice(invoiceId, (e) => a.push(e.type));
    const subB = client.subscribeInvoice(invoiceId, (e) => b.push(e.type));

    client.simulateEvent({ type: "payment", invoiceId, ledger: 1, timestamp: Date.now(), eventId: "evt-multi-1", payer: CREATOR, amount: AMOUNT });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    unsubA();
    subB.unsubscribe();
  });

  // -----------------------------------------------------------------------
  // createInvoice — memo is persisted on the invoice
  // -----------------------------------------------------------------------
  it("createInvoice: memo is persisted on the invoice", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams({ memo: "Test memo" }));
    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.memo).toBe("Test memo");
  });

  // -----------------------------------------------------------------------
  // Multiple payments — funded accumulates correctly
  // -----------------------------------------------------------------------
  it("pay: multiple payments accumulate funded amount", async () => {
    const { invoiceId } = await client.createInvoice(makeCreateParams());
    await client.pay({ payer: CREATOR, invoiceId, amount: 300_000n });
    await client.pay({ payer: CREATOR, invoiceId, amount: 700_000n });

    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.funded).toBe(1_000_000n);
    expect(invoice.payments).toHaveLength(2);
  });
});
