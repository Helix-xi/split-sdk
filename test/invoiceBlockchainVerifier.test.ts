/**
 * Tests for InvoiceBlockchainVerifier
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  InvoiceBlockchainVerifier,
  isValidStellarAddress,
} from "../src/invoiceBlockchainVerifier.js";
import type { VerificationResult, VerificationProof } from "../src/invoiceBlockchainVerifier.js";
import type { Invoice } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures — all exactly 56-character Stellar G addresses
// ---------------------------------------------------------------------------

// Each address is "G" followed by exactly 55 Base-32 characters (A-Z2-7)
const ADDR_CREATOR   = "GCREATORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 56 chars
const ADDR_RECIPIENT1 = "GRECIPIENT2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 56 chars
const ADDR_RECIPIENT2 = "GRECIPIENT3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 56 chars
const ADDR_TOKEN     = "GUSDCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 56 chars
const ADDR_PAYER     = "GPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 56 chars

const FUTURE_DEADLINE = Math.floor(Date.now() / 1000) + 86_400 * 30; // 30 days out
const PAST_DEADLINE   = Math.floor(Date.now() / 1000) - 86_400;       // 1 day ago

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "42",
    creator: ADDR_CREATOR,
    recipients: [
      { address: ADDR_RECIPIENT1, amount: 6_000_000n },
      { address: ADDR_RECIPIENT2, amount: 4_000_000n },
    ],
    token: ADDR_TOKEN,
    deadline: FUTURE_DEADLINE,
    funded: 10_000_000n,
    status: "Pending",
    payments: [{ payer: ADDR_PAYER, amount: 10_000_000n }],
    createdAt: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isValidStellarAddress
// ---------------------------------------------------------------------------

describe("isValidStellarAddress", () => {
  it("accepts valid 56-char G addresses", () => {
    expect(isValidStellarAddress(ADDR_CREATOR)).toBe(true);
    expect(isValidStellarAddress(ADDR_RECIPIENT1)).toBe(true);
    expect(isValidStellarAddress(ADDR_RECIPIENT2)).toBe(true);
  });

  it("rejects addresses that don't start with G", () => {
    // Replace the leading G with X / S
    const xAddr = "X" + ADDR_CREATOR.slice(1);
    const sAddr = "S" + ADDR_CREATOR.slice(1);
    expect(isValidStellarAddress(xAddr)).toBe(false);
    expect(isValidStellarAddress(sAddr)).toBe(false);
  });

  it("rejects addresses that are too short or too long", () => {
    expect(isValidStellarAddress("GSHORT")).toBe(false);
    expect(isValidStellarAddress("G" + "A".repeat(56))).toBe(false); // 57 chars total
    expect(isValidStellarAddress("G" + "A".repeat(54))).toBe(false); // 55 chars total
  });

  it("rejects addresses with invalid base32 characters (0, 1, 8, 9)", () => {
    const bad0 = "G0" + "A".repeat(54); // 56 chars but contains '0'
    const bad1 = "G1" + "A".repeat(54);
    const bad8 = "G8" + "A".repeat(54);
    const bad9 = "G9" + "A".repeat(54);
    expect(isValidStellarAddress(bad0)).toBe(false);
    expect(isValidStellarAddress(bad1)).toBe(false);
    expect(isValidStellarAddress(bad8)).toBe(false);
    expect(isValidStellarAddress(bad9)).toBe(false);
  });

  it("rejects empty string and non-string", () => {
    expect(isValidStellarAddress("")).toBe(false);
    expect(isValidStellarAddress(null as unknown as string)).toBe(false);
  });

  it("accepts addresses using digits 2-7", () => {
    const with2 = "G2" + "A".repeat(54);
    const with7 = "G7" + "A".repeat(54);
    expect(isValidStellarAddress(with2)).toBe(true);
    expect(isValidStellarAddress(with7)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verify — happy path
// ---------------------------------------------------------------------------

describe("InvoiceBlockchainVerifier.verify — happy path", () => {
  it("returns verified=true for a well-formed invoice", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice();
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(true);
    expect(result.invoiceId).toBe("42");
    expect(result.errors).toBeUndefined();
    expect(typeof result.proofHash).toBe("string");
    expect(result.proofHash).toHaveLength(64);
    expect(typeof result.timestamp).toBe("number");
  });

  it("produces a 64-char hex proof hash", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const result = await verifier.verify(42n, makeInvoice());
    expect(/^[0-9a-f]{64}$/.test(result.proofHash)).toBe(true);
  });

  it("includes a numeric timestamp close to now", async () => {
    const before = Math.floor(Date.now() / 1000);
    const verifier = new InvoiceBlockchainVerifier();
    const result = await verifier.verify(42n, makeInvoice());
    const after = Math.floor(Date.now() / 1000);
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after + 1);
  });
});

// ---------------------------------------------------------------------------
// verify — ID mismatch
// ---------------------------------------------------------------------------

describe("InvoiceBlockchainVerifier.verify — ID mismatch", () => {
  it("returns verified=false when the invoice id doesn't match invoiceId param", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({ id: "99" });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some((e) => e.includes("ID mismatch"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verify — timestamp checks
// ---------------------------------------------------------------------------

describe("InvoiceBlockchainVerifier.verify — timestamp checks", () => {
  it("returns verified=false for a Pending invoice with an expired deadline", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({ deadline: PAST_DEADLINE, status: "Pending" });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
    expect(result.errors!.some((e) => e.includes("expired"))).toBe(true);
  });

  it("allows a past deadline for a Released invoice", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({ deadline: PAST_DEADLINE, status: "Released" });
    const result = await verifier.verify(42n, invoice);

    const deadlineErrors = (result.errors ?? []).filter((e) => e.includes("expired"));
    expect(deadlineErrors).toHaveLength(0);
  });

  it("allows a past deadline for a Refunded invoice", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({ deadline: PAST_DEADLINE, status: "Refunded" });
    const result = await verifier.verify(42n, invoice);

    const deadlineErrors = (result.errors ?? []).filter((e) => e.includes("expired"));
    expect(deadlineErrors).toHaveLength(0);
  });

  it("rejects non-finite deadline", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({ deadline: NaN });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
    expect(result.errors!.some((e) => e.includes("deadline"))).toBe(true);
  });

  it("rejects zero/negative deadline", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({ deadline: 0 });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
    expect(result.errors!.some((e) => e.includes("deadline"))).toBe(true);
  });

  it("rejects a createdAt that is in the future (beyond 60s clock skew)", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const futureCAt = Math.floor(Date.now() / 1000) + 9999;
    const invoice = makeInvoice({ createdAt: futureCAt });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
    expect(result.errors!.some((e) => e.includes("createdAt"))).toBe(true);
  });

  it("accepts a createdAt in milliseconds", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const createdAtMs = (Math.floor(Date.now() / 1000) - 3600) * 1000; // 1h ago in ms
    const invoice = makeInvoice({ createdAt: createdAtMs });
    const result = await verifier.verify(42n, invoice);

    const createdAtErrors = (result.errors ?? []).filter((e) =>
      e.includes("createdAt"),
    );
    expect(createdAtErrors).toHaveLength(0);
  });

  it("respects deadlineGraceSeconds option", async () => {
    // Invoice expired 10 seconds ago — with 30s grace it should still pass
    const now = Math.floor(Date.now() / 1000);
    const verifier = new InvoiceBlockchainVerifier({ deadlineGraceSeconds: 30 });
    const invoice = makeInvoice({ deadline: now - 10, status: "Pending" });
    const result = await verifier.verify(42n, invoice);

    const deadlineErrors = (result.errors ?? []).filter((e) => e.includes("expired"));
    expect(deadlineErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// verify — recipient address checks
// ---------------------------------------------------------------------------

describe("InvoiceBlockchainVerifier.verify — recipient address checks", () => {
  it("rejects an invoice with no recipients", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({ recipients: [] });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
    expect(result.errors!.some((e) => e.includes("recipient"))).toBe(true);
  });

  it("rejects a recipient with an invalid address", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({
      recipients: [{ address: "NOT_A_VALID_ADDRESS", amount: 10_000_000n }],
      funded: 10_000_000n,
    });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
    expect(result.errors!.some((e) => e.includes("invalid Stellar address"))).toBe(true);
  });

  it("rejects a recipient with zero amount", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({
      recipients: [{ address: ADDR_RECIPIENT1, amount: 0n }],
      funded: 0n,
    });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
    expect(result.errors!.some((e) => e.includes("amount"))).toBe(true);
  });

  it("rejects a recipient with a negative amount", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({
      recipients: [{ address: ADDR_RECIPIENT1, amount: -1n }],
      funded: 0n,
    });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
  });

  it("reports the correct recipient index in the error message", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({
      recipients: [
        { address: ADDR_RECIPIENT1, amount: 5_000_000n },
        { address: "BAD_ADDR", amount: 5_000_000n },
      ],
      funded: 10_000_000n,
    });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
    expect(result.errors!.some((e) => e.includes("Recipient[1]"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verify — amount checks
// ---------------------------------------------------------------------------

describe("InvoiceBlockchainVerifier.verify — amount checks", () => {
  it("rejects when funded exceeds total recipient amounts", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({ funded: 99_000_000n }); // recipients total 10_000_000n
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
    expect(result.errors!.some((e) => e.includes("exceeds"))).toBe(true);
  });

  it("rejects a negative funded amount", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({ funded: -1n });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
    expect(result.errors!.some((e) => e.includes("negative"))).toBe(true);
  });

  it("accepts funded=0 (not yet funded)", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({ funded: 0n });
    const result = await verifier.verify(42n, invoice);

    const amountErrors = (result.errors ?? []).filter(
      (e) => e.includes("negative") || e.includes("exceeds"),
    );
    expect(amountErrors).toHaveLength(0);
  });

  it("accepts funded equal to total recipient amounts", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    // recipients total 6_000_000n + 4_000_000n = 10_000_000n
    const invoice = makeInvoice({ funded: 10_000_000n });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

describe("InvoiceBlockchainVerifier — events", () => {
  it("emits verification:started before result", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const startedPayloads: Array<{ invoiceId: string; timestamp: number }> = [];
    verifier.on("verification:started", (p) => startedPayloads.push(p));

    await verifier.verify(42n, makeInvoice());

    expect(startedPayloads).toHaveLength(1);
    expect(startedPayloads[0].invoiceId).toBe("42");
    expect(typeof startedPayloads[0].timestamp).toBe("number");
  });

  it("emits verification:passed for a valid invoice", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const passed: VerificationResult[] = [];
    const failed: VerificationResult[] = [];

    verifier.on("verification:passed", (r) => passed.push(r));
    verifier.on("verification:failed", (r) => failed.push(r));

    await verifier.verify(42n, makeInvoice());

    expect(passed).toHaveLength(1);
    expect(failed).toHaveLength(0);
    expect(passed[0].verified).toBe(true);
  });

  it("emits verification:failed for an invalid invoice", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const passed: VerificationResult[] = [];
    const failed: VerificationResult[] = [];

    verifier.on("verification:passed", (r) => passed.push(r));
    verifier.on("verification:failed", (r) => failed.push(r));

    // ID mismatch will cause failure
    await verifier.verify(42n, makeInvoice({ id: "99" }));

    expect(passed).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0].verified).toBe(false);
  });

  it("emits verification:started even when verification fails", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const started: string[] = [];
    verifier.on("verification:started", ({ invoiceId }) => started.push(invoiceId));

    await verifier.verify(42n, makeInvoice({ recipients: [] }));

    expect(started).toHaveLength(1);
  });

  it("can remove event listeners via returned unsubscribe", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const events: VerificationResult[] = [];
    const unsub = verifier.on("verification:passed", (r) => events.push(r));

    await verifier.verify(42n, makeInvoice());
    unsub(); // remove listener
    await verifier.verify(42n, makeInvoice());

    expect(events).toHaveLength(1); // only first call captured
  });
});

// ---------------------------------------------------------------------------
// verifyBatch
// ---------------------------------------------------------------------------

describe("InvoiceBlockchainVerifier.verifyBatch", () => {
  it("returns one result per invoice in order", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoices = [
      { invoiceId: 1n, invoiceData: makeInvoice({ id: "1" }) },
      { invoiceId: 2n, invoiceData: makeInvoice({ id: "2" }) },
      { invoiceId: 3n, invoiceData: makeInvoice({ id: "3" }) },
    ];
    const results = await verifier.verifyBatch(invoices);

    expect(results).toHaveLength(3);
    expect(results[0].invoiceId).toBe("1");
    expect(results[1].invoiceId).toBe("2");
    expect(results[2].invoiceId).toBe("3");
  });

  it("returns verified=true for all valid invoices", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoices = [1n, 2n, 3n].map((id) => ({
      invoiceId: id,
      invoiceData: makeInvoice({ id: String(id) }),
    }));
    const results = await verifier.verifyBatch(invoices);
    expect(results.every((r) => r.verified)).toBe(true);
  });

  it("correctly marks only invalid invoices as failed", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoices = [
      { invoiceId: 1n, invoiceData: makeInvoice({ id: "1" }) }, // valid
      { invoiceId: 2n, invoiceData: makeInvoice({ id: "99" }) }, // id mismatch → invalid
      { invoiceId: 3n, invoiceData: makeInvoice({ id: "3" }) }, // valid
    ];
    const results = await verifier.verifyBatch(invoices);

    expect(results[0].verified).toBe(true);
    expect(results[1].verified).toBe(false);
    expect(results[2].verified).toBe(true);
  });

  it("returns an empty array for an empty input", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const results = await verifier.verifyBatch([]);
    expect(results).toHaveLength(0);
  });

  it("emits events for every invoice in the batch", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const started: string[] = [];
    verifier.on("verification:started", ({ invoiceId }) => started.push(invoiceId));

    const invoices = [1n, 2n, 3n].map((id) => ({
      invoiceId: id,
      invoiceData: makeInvoice({ id: String(id) }),
    }));
    await verifier.verifyBatch(invoices);

    expect(started).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// getVerificationProof
// ---------------------------------------------------------------------------

describe("InvoiceBlockchainVerifier.getVerificationProof", () => {
  it("returns a proof with the expected shape", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const proof = await verifier.getVerificationProof(42n, makeInvoice());

    expect(proof.invoiceId).toBe("42");
    expect(/^[0-9a-f]{64}$/.test(proof.proofHash)).toBe(true);
    expect(proof.algorithm).toBe("SHA-256-canonical-v1");
    expect(typeof proof.generatedAt).toBe("number");
  });

  it("produces the same proofHash as verify() for the same invoice", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice();

    const result = await verifier.verify(42n, invoice);
    const proof = await verifier.getVerificationProof(42n, invoice);

    expect(proof.proofHash).toBe(result.proofHash);
  });

  it("produces a different hash for a different invoice", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const proof1 = await verifier.getVerificationProof(1n, makeInvoice({ id: "1" }));
    const proof2 = await verifier.getVerificationProof(2n, makeInvoice({ id: "2" }));

    expect(proof1.proofHash).not.toBe(proof2.proofHash);
  });

  it("is deterministic — same invoice yields same proofHash across calls", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice();
    const proof1 = await verifier.getVerificationProof(42n, invoice);
    const proof2 = await verifier.getVerificationProof(42n, invoice);

    expect(proof1.proofHash).toBe(proof2.proofHash);
  });

  it("generatedAt is approximately now", async () => {
    const before = Math.floor(Date.now() / 1000);
    const verifier = new InvoiceBlockchainVerifier();
    const proof = await verifier.getVerificationProof(42n, makeInvoice());
    const after = Math.floor(Date.now() / 1000);

    expect(proof.generatedAt).toBeGreaterThanOrEqual(before);
    expect(proof.generatedAt).toBeLessThanOrEqual(after + 1);
  });
});

// ---------------------------------------------------------------------------
// Proof hash consistency with field changes
// ---------------------------------------------------------------------------

describe("Proof hash sensitivity to invoice mutations", () => {
  it("changes hash when funded amount changes", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const p1 = await verifier.getVerificationProof(42n, makeInvoice({ funded: 0n }));
    const p2 = await verifier.getVerificationProof(42n, makeInvoice({ funded: 10_000_000n }));
    expect(p1.proofHash).not.toBe(p2.proofHash);
  });

  it("changes hash when a recipient address changes", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const p1 = await verifier.getVerificationProof(
      42n,
      makeInvoice({
        recipients: [{ address: ADDR_RECIPIENT1, amount: 10_000_000n }],
        funded: 10_000_000n,
      }),
    );
    const p2 = await verifier.getVerificationProof(
      42n,
      makeInvoice({
        recipients: [{ address: ADDR_RECIPIENT2, amount: 10_000_000n }],
        funded: 10_000_000n,
      }),
    );
    expect(p1.proofHash).not.toBe(p2.proofHash);
  });

  it("same hash for identical invoices regardless of key insertion order", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const base = makeInvoice();

    const inv1: Invoice = { ...base };
    const inv2: Invoice = {
      status: base.status,
      id: base.id,
      funded: base.funded,
      creator: base.creator,
      recipients: base.recipients,
      token: base.token,
      deadline: base.deadline,
      payments: base.payments,
      createdAt: base.createdAt,
    };

    const p1 = await verifier.getVerificationProof(42n, inv1);
    const p2 = await verifier.getVerificationProof(42n, inv2);
    expect(p1.proofHash).toBe(p2.proofHash);
  });
});

// ---------------------------------------------------------------------------
// VerifierOptions
// ---------------------------------------------------------------------------

describe("InvoiceBlockchainVerifier — options", () => {
  it("invoice without createdAt still passes when allowMissingCreatedAt=true", async () => {
    const verifier = new InvoiceBlockchainVerifier({ allowMissingCreatedAt: true });
    const invoice = makeInvoice();
    // Remove createdAt
    const { createdAt, ...invoiceWithout } = invoice;
    const result = await verifier.verify(42n, invoiceWithout as Invoice);
    expect(result.verified).toBe(true);
  });

  it("invoice without createdAt also passes with default options (soft check only)", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice();
    const { createdAt, ...invoiceWithout } = invoice;
    const result = await verifier.verify(42n, invoiceWithout as Invoice);
    // createdAt absence is a soft check — should not fail hard validation
    expect(result.verified).toBe(true);
  });

  it("deadlineGraceSeconds=0 (default) rejects just-expired deadlines", async () => {
    const verifier = new InvoiceBlockchainVerifier({ deadlineGraceSeconds: 0 });
    const now = Math.floor(Date.now() / 1000);
    const invoice = makeInvoice({ deadline: now - 5, status: "Pending" });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
  });

  it("deadlineGraceSeconds covers a recently-expired deadline", async () => {
    const verifier = new InvoiceBlockchainVerifier({ deadlineGraceSeconds: 60 });
    const now = Math.floor(Date.now() / 1000);
    // Expired 30s ago, within 60s grace
    const invoice = makeInvoice({ deadline: now - 30, status: "Pending" });
    const result = await verifier.verify(42n, invoice);

    const deadlineErrors = (result.errors ?? []).filter((e) => e.includes("expired"));
    expect(deadlineErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple errors in a single result
// ---------------------------------------------------------------------------

describe("Multiple errors accumulate in one result", () => {
  it("reports both address and amount errors together", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({
      id: "42",
      recipients: [{ address: "BAD_ADDR", amount: -1n }],
      funded: 99_999_999n,
    });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
    expect(result.errors!.length).toBeGreaterThan(1);
  });

  it("accumulates ID mismatch + deadline errors together", async () => {
    const verifier = new InvoiceBlockchainVerifier();
    const invoice = makeInvoice({ id: "99", deadline: PAST_DEADLINE, status: "Pending" });
    const result = await verifier.verify(42n, invoice);

    expect(result.verified).toBe(false);
    expect(result.errors!.length).toBeGreaterThanOrEqual(2);
    expect(result.errors!.some((e) => e.includes("ID mismatch"))).toBe(true);
    expect(result.errors!.some((e) => e.includes("expired"))).toBe(true);
  });
});
