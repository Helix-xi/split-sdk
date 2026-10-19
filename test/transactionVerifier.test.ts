/**
 * Tests for issue #1066 — Transaction verification
 *
 * Builds real (offline) Stellar transactions and verifies each check:
 * structure, fee, sequence, time bounds, signatures, and hash integrity.
 */
import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import {
  verifyTransaction,
  verifyTransactionSignatures,
  assertTransactionVerified,
} from "../src/transactionVerifier.js";
import {
  StellarSplitError,
  TransactionVerificationError,
  isTransactionVerificationError,
} from "../src/errors.js";

const NETWORK = Networks.TESTNET;
const FEE = "100";

function buildTx(opts: {
  fee?: string;
  timeout?: number;
  source?: Keypair;
  sequence?: string;
}): Transaction {
  const source = opts.source ?? Keypair.random();
  const account = new Account(source.publicKey(), opts.sequence ?? "100");
  const builder = new TransactionBuilder(account, {
    fee: opts.fee ?? FEE,
    networkPassphrase: NETWORK,
  }).addOperation(
    Operation.payment({
      destination: Keypair.random().publicKey(),
      asset: Asset.native(),
      amount: "10",
    }),
  );
  if (opts.timeout !== 0) {
    builder.setTimeout(opts.timeout ?? 300);
  } else {
    builder.setTimeout(0); // no time bounds
  }
  return builder.build();
}

describe("verifyTransaction — happy path (#1066)", () => {
  it("passes every check for a properly signed transaction", () => {
    const source = Keypair.random();
    const tx = buildTx({ source });
    tx.sign(source);

    const result = verifyTransaction(tx, {
      signers: [source.publicKey()],
      maxFee: 1_000,
      expectedSequence: "101",
      now: Math.floor(Date.now() / 1000),
    });

    expect(result.valid).toBe(true);
    expect(result.failedChecks).toEqual([]);
    for (const check of result.checks) {
      expect(check.passed, `${check.name}: ${check.detail}`).toBe(true);
    }
  });

  it("accepts a transaction with no explicit options beyond defaults", () => {
    const source = Keypair.random();
    const tx = buildTx({ source });
    tx.sign(source);

    // Default signature policy: at least one signature entry must be present.
    const result = verifyTransaction(tx);
    expect(result.valid).toBe(true);
  });
});

describe("verifyTransaction — fee check (#1066)", () => {
  it("fails when the fee exceeds maxFee", () => {
    const source = Keypair.random();
    const tx = buildTx({ source, fee: "5000" });
    tx.sign(source);

    const result = verifyTransaction(tx, { maxFee: 1_000 });
    expect(result.valid).toBe(false);
    expect(result.failedChecks).toContain("fee");
    expect(result.checks.find((c) => c.name === "fee")?.detail).toContain("exceeds maximum");
  });

  it("passes when the fee is exactly maxFee", () => {
    const source = Keypair.random();
    const tx = buildTx({ source, fee: "1000" });
    tx.sign(source);

    const result = verifyTransaction(tx, { maxFee: 1000 });
    expect(result.failedChecks).not.toContain("fee");
  });

  it("skips the fee check when maxFee is omitted", () => {
    const source = Keypair.random();
    const tx = buildTx({ source, fee: "999999" });
    tx.sign(source);

    const result = verifyTransaction(tx);
    expect(result.checks.some((c) => c.name === "fee")).toBe(false);
  });
});

describe("verifyTransaction — sequence check (#1066)", () => {
  it("fails when the sequence number does not match", () => {
    const source = Keypair.random();
    const tx = buildTx({ source });
    tx.sign(source);

    const result = verifyTransaction(tx, { expectedSequence: "999" });
    expect(result.valid).toBe(false);
    expect(result.failedChecks).toContain("sequence");
  });

  it("passes when the sequence number matches", () => {
    const source = Keypair.random();
    const tx = buildTx({ source });
    tx.sign(source);

    const result = verifyTransaction(tx, { expectedSequence: tx.sequence });
    expect(result.failedChecks).not.toContain("sequence");
  });
});

describe("verifyTransaction — time bounds check (#1066)", () => {
  it("passes when now is inside the bounds", () => {
    const source = Keypair.random();
    const tx = buildTx({ source });
    tx.sign(source);

    const result = verifyTransaction(tx, { now: Math.floor(Date.now() / 1000) });
    expect(result.failedChecks).not.toContain("timebounds");
  });

  it("fails when now is after the max time", () => {
    const source = Keypair.random();
    const tx = buildTx({ source });
    tx.sign(source);

    const maxTime = Number(tx.timeBounds!.maxTime);
    const result = verifyTransaction(tx, { now: maxTime + 10 });
    expect(result.valid).toBe(false);
    expect(result.failedChecks).toContain("timebounds");
  });

  it("fails when now is before the min time", () => {
    const source = Keypair.random();
    const account = new Account(source.publicKey(), "100");
    const tx = new TransactionBuilder(account, {
      fee: FEE,
      networkPassphrase: NETWORK,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "200" }))
      .setTimebounds(2_000_000_000, 3_000_000_000)
      .build();
    tx.sign(source);

    const result = verifyTransaction(tx, { now: 1_000_000_000 });
    expect(result.failedChecks).toContain("timebounds");
  });

  it("treats zero/absent time bounds as unbounded", () => {
    const source = Keypair.random();
    const tx = buildTx({ source, timeout: 0 });
    tx.sign(source);

    // setTimeout(0) yields { minTime: "0", maxTime: "0" } — "no upper bound".
    const result = verifyTransaction(tx, { now: 2_000_000_000 });
    const boundsCheck = result.checks.find((c) => c.name === "timebounds");
    expect(boundsCheck?.passed).toBe(true);
  });
});

describe("verifyTransactionSignatures (#1066)", () => {
  it("classifies valid, missing, and invalid signers", () => {
    const signer = Keypair.random();
    const missing = Keypair.random();
    const forger = Keypair.random();
    const tx = buildTx({ source: signer });
    tx.sign(signer);
    // Forge a signature entry with forger's hint but garbage bytes.
    tx.signatures.push(
      new xdr.DecoratedSignature({ hint: forger.signatureHint(), signature: Buffer.alloc(64) }),
    );

    const result = verifyTransactionSignatures(tx, [
      signer.publicKey(),
      missing.publicKey(),
      forger.publicKey(),
    ]);

    expect(result.valid).toEqual([signer.publicKey()]);
    expect(result.missing).toEqual([missing.publicKey()]);
    expect(result.invalid).toEqual([forger.publicKey()]);
  });

  it("returns an empty result for an empty key list", () => {
    const tx = buildTx({});
    expect(verifyTransactionSignatures(tx, [])).toEqual({ valid: [], missing: [], invalid: [] });
  });

  it("treats an unparseable key as invalid", () => {
    const tx = buildTx({});
    const result = verifyTransactionSignatures(tx, ["not-a-public-key"]);
    expect(result.invalid).toEqual(["not-a-public-key"]);
  });
});

describe("verifyTransaction — signatures check (#1066)", () => {
  it("fails for an unsigned transaction (default minSignatures=1)", () => {
    const tx = buildTx({});
    const result = verifyTransaction(tx);
    expect(result.failedChecks).toContain("signatures");
  });

  it("fails when a required signer has not signed", () => {
    const source = Keypair.random();
    const other = Keypair.random();
    const tx = buildTx({ source });
    tx.sign(source);

    const result = verifyTransaction(tx, { signers: [source.publicKey(), other.publicKey()] });
    expect(result.failedChecks).toContain("signatures");
    expect(result.checks.find((c) => c.name === "signatures")?.detail).toContain("missing");
  });

  it("fails when minSignatures is not met", () => {
    const source = Keypair.random();
    const tx = buildTx({ source });
    tx.sign(source);

    const result = verifyTransaction(tx, { minSignatures: 2 });
    expect(result.failedChecks).toContain("signatures");
  });
});

describe("verifyTransaction — hash integrity check (#1066)", () => {
  it("passes when expectedHash matches (hex, case-insensitive)", () => {
    const source = Keypair.random();
    const tx = buildTx({ source });
    tx.sign(source);

    const hex = tx.hash().toString("hex");
    const result = verifyTransaction(tx, { expectedHash: hex.toUpperCase() });
    expect(result.failedChecks).not.toContain("hash");
  });

  it("passes when expectedHash matches (base64)", () => {
    const source = Keypair.random();
    const tx = buildTx({ source });
    tx.sign(source);

    const result = verifyTransaction(tx, { expectedHash: tx.hash().toString("base64") });
    expect(result.failedChecks).not.toContain("hash");
  });

  it("fails when expectedHash does not match", () => {
    const source = Keypair.random();
    const tx = buildTx({ source });
    tx.sign(source);

    const other = buildTx({ source });
    const result = verifyTransaction(tx, {
      expectedHash: other.hash().toString("hex"),
    });
    expect(result.failedChecks).toContain("hash");
  });
});

describe("assertTransactionVerified (#1066)", () => {
  it("returns the result when all checks pass", () => {
    const source = Keypair.random();
    const tx = buildTx({ source });
    tx.sign(source);

    const result = assertTransactionVerified(tx, { signers: [source.publicKey()] });
    expect(result.valid).toBe(true);
  });

  it("throws TransactionVerificationError listing the failed checks", () => {
    const source = Keypair.random();
    const tx = buildTx({ source }); // signed by nobody
    tx.sign(source);
    const other = Keypair.random();

    let thrown: unknown;
    try {
      assertTransactionVerified(tx, {
        signers: [other.publicKey()],
        expectedSequence: "999",
        maxFee: 1,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TransactionVerificationError);
    expect(thrown).toBeInstanceOf(StellarSplitError);
    const err = thrown as TransactionVerificationError;
    expect(err.code).toBe("VERIFICATION_FAILED");
    expect(err.failedChecks).toContain("sequence");
    expect(err.failedChecks).toContain("fee");
    expect(err.failedChecks).toContain("signatures");
    expect(isTransactionVerificationError(err)).toBe(true);
  });
});


