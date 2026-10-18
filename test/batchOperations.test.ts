import { describe, it, expect, vi } from "vitest";
import { Keypair, Asset, Networks } from "@stellar/stellar-sdk";
import {
  BatchOperationBuilder,
  BatchExecutor,
  validateBatchOperations,
  MAX_OPERATIONS_PER_BATCH,
} from "../src/batchOperations.js";
import { ValidationError, TransactionFailedError } from "../src/errors.js";

describe("BatchOperationBuilder (#1032)", () => {
  it("chains multiple operation types into a batch", () => {
    const kp1 = Keypair.random();
    const kp2 = Keypair.random();

    const builder = new BatchOperationBuilder()
      .addPayment({ destination: kp1.publicKey(), amount: "10" })
      .addCreateAccount({ destination: kp2.publicKey(), startingBalance: "2.5" })
      .addManageData({ name: "invoice_ref", value: "INV-123" });

    expect(builder.size()).toBe(3);
    const ops = builder.getOperations();
    expect(ops[0]?.type).toBe("payment");
    expect(ops[1]?.type).toBe("createAccount");
    expect(ops[2]?.type).toBe("manageData");
  });

  it("converts operations to valid XDR operations", () => {
    const kp = Keypair.random();
    const builder = new BatchOperationBuilder()
      .addPayment({ destination: kp.publicKey(), amount: "5.5" })
      .addManageData({ name: "test_key", value: "test_val" });

    const xdrOps = builder.toXdrOperations();
    expect(xdrOps).toHaveLength(2);
  });

  it("clears operations", () => {
    const builder = new BatchOperationBuilder()
      .addPayment({ destination: Keypair.random().publicKey(), amount: "1" });
    expect(builder.size()).toBe(1);
    builder.clear();
    expect(builder.size()).toBe(0);
  });
});

describe("Batch Validation (#1032)", () => {
  it("rejects an empty batch", () => {
    expect(() => validateBatchOperations([])).toThrow(ValidationError);
  });

  it("rejects batches exceeding maximum operations limit (100)", () => {
    const kp = Keypair.random();
    const ops = Array.from({ length: 101 }, () => ({
      type: "payment" as const,
      destination: kp.publicKey(),
      amount: "1",
    }));

    expect(() => validateBatchOperations(ops)).toThrow(ValidationError);
    expect(() => validateBatchOperations(ops)).toThrow(
      new RegExp(`exceeds maximum limit of ${MAX_OPERATIONS_PER_BATCH}`),
    );
  });

  it("rejects invalid destination public keys", () => {
    expect(() =>
      validateBatchOperations([
        { type: "payment", destination: "INVALID_G_KEY", amount: "10" },
      ]),
    ).toThrow(ValidationError);

    expect(() =>
      validateBatchOperations([
        { type: "createAccount", destination: "GNOTVALID", startingBalance: "10" },
      ]),
    ).toThrow(ValidationError);
  });

  it("rejects non-positive payment amounts", () => {
    const kp = Keypair.random();
    expect(() =>
      validateBatchOperations([
        { type: "payment", destination: kp.publicKey(), amount: "0" },
      ]),
    ).toThrow(ValidationError);

    expect(() =>
      validateBatchOperations([
        { type: "payment", destination: kp.publicKey(), amount: "-10" },
      ]),
    ).toThrow(ValidationError);
  });

  it("rejects manageData keys longer than 64 bytes", () => {
    const overlongName = "a".repeat(65);
    expect(() =>
      validateBatchOperations([
        { type: "manageData", name: overlongName, value: "valid" },
      ]),
    ).toThrow(ValidationError);
  });
});

describe("BatchExecutor (#1032)", () => {
  const sourceKp = Keypair.random();
  const destKp1 = Keypair.random();
  const destKp2 = Keypair.random();

  it("builds a single atomic transaction containing all batched operations", () => {
    const executor = new BatchExecutor({
      sourceAddress: sourceKp.publicKey(),
      networkPassphrase: Networks.TESTNET,
      baseFee: 100,
    });

    const builder = new BatchOperationBuilder()
      .addPayment({ destination: destKp1.publicKey(), amount: "10" })
      .addPayment({ destination: destKp2.publicKey(), amount: "20" })
      .addManageData({ name: "batch_id", value: "b-001" });

    const tx = executor.buildTransaction(builder, "10");

    // Stellar Transaction checks
    expect(tx.operations).toHaveLength(3);
    expect(tx.source).toBe(sourceKp.publicKey());
    expect(tx.sequence).toBe("11");
    // Fee = baseFee (100) * 3 operations = 300 stroops
    expect(Number(tx.fee)).toBe(300);
  });

  it("signs and executes batch atomically", async () => {
    const executor = new BatchExecutor({
      sourceAddress: sourceKp.publicKey(),
      networkPassphrase: Networks.TESTNET,
      signer: sourceKp,
    });

    const builder = new BatchOperationBuilder()
      .addPayment({ destination: destKp1.publicKey(), amount: "5" })
      .addPayment({ destination: destKp2.publicKey(), amount: "15" });

    const result = await executor.execute(builder, "42");

    expect(result.success).toBe(true);
    expect(result.atomic).toBe(true);
    expect(result.operationCount).toBe(2);
    expect(result.txHash).toBeDefined();
    expect(result.envelopeXdr).toBeDefined();
  });

  it("submits transaction to server and returns hash on success", async () => {
    const sendTransaction = vi.fn().mockResolvedValue({
      status: "PENDING",
      hash: "batch_tx_hash_12345",
    });

    const executor = new BatchExecutor({
      sourceAddress: sourceKp.publicKey(),
      networkPassphrase: Networks.TESTNET,
      signer: sourceKp.secret(),
      server: { sendTransaction },
    });

    const builder = new BatchOperationBuilder()
      .addPayment({ destination: destKp1.publicKey(), amount: "1" });

    const result = await executor.execute(builder, "1");

    expect(result.txHash).toBe("batch_tx_hash_12345");
    expect(result.atomic).toBe(true);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("throws TransactionFailedError atomically when server rejects submission", async () => {
    const sendTransaction = vi.fn().mockResolvedValue({
      status: "ERROR",
      errorResult: "tx_bad_seq",
    });

    const executor = new BatchExecutor({
      sourceAddress: sourceKp.publicKey(),
      networkPassphrase: Networks.TESTNET,
      signer: sourceKp,
      server: { sendTransaction },
    });

    const builder = new BatchOperationBuilder()
      .addPayment({ destination: destKp1.publicKey(), amount: "1" });

    await expect(executor.execute(builder, "1")).rejects.toThrow(TransactionFailedError);
  });
});
