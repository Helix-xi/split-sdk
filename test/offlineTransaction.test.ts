import { describe, it, expect } from "vitest";
import { Keypair, Asset, Networks, Memo } from "@stellar/stellar-sdk";
import {
  OfflineTransactionBuilder,
} from "../src/offlineTransaction.js";
import { ValidationError } from "../src/errors.js";

describe("OfflineTransactionBuilder (#1033)", () => {
  const sourceKp = Keypair.random();
  const destKp = Keypair.random();

  it("builds an offline transaction without network access", () => {
    const builder = new OfflineTransactionBuilder({
      sourceAddress: sourceKp.publicKey(),
      sequenceNumber: "100",
      networkPassphrase: Networks.TESTNET,
      baseFee: 100,
    })
      .addPayment({
        destination: destKp.publicKey(),
        amount: "50",
      })
      .addManageData({
        name: "offline_ref",
        value: "ABC",
      });

    const tx = builder.build();
    expect(tx.source).toBe(sourceKp.publicKey());
    expect(tx.sequence).toBe("101"); // 100 + 1
    expect(tx.operations).toHaveLength(2);
    expect(Number(tx.fee)).toBe(200); // 100 baseFee * 2 ops
    expect(typeof tx.toXDR).toBe("function");
  });

  it("supports text, id, and hash memos", () => {
    const builder = new OfflineTransactionBuilder({
      sourceAddress: sourceKp.publicKey(),
      sequenceNumber: "1",
      networkPassphrase: Networks.TESTNET,
      memo: { type: "text", value: "Invoice Split 42" },
    }).addPayment({
      destination: destKp.publicKey(),
      amount: "1",
    });

    const tx = builder.build();
    expect(tx.memo.type).toBe("text");
    expect(tx.memo.value).toBe("Invoice Split 42");
  });

  it("signs transaction securely using Keypair", () => {
    const builder = new OfflineTransactionBuilder({
      sourceAddress: sourceKp.publicKey(),
      sequenceNumber: "5",
      networkPassphrase: Networks.TESTNET,
    }).addPayment({
      destination: destKp.publicKey(),
      amount: "10",
    });

    builder.sign(sourceKp);

    const tx = builder.build();
    expect(tx.signatures).toHaveLength(1);
    expect(builder.verifySignatures([sourceKp.publicKey()])).toBe(true);
    expect(builder.getSignatureHints()).toHaveLength(1);
  });

  it("signs transaction using secret seed string", () => {
    const builder = new OfflineTransactionBuilder({
      sourceAddress: sourceKp.publicKey(),
      sequenceNumber: "5",
      networkPassphrase: Networks.TESTNET,
    }).addPayment({
      destination: destKp.publicKey(),
      amount: "10",
    });

    builder.sign(sourceKp.secret());

    const tx = builder.build();
    expect(tx.signatures).toHaveLength(1);
    expect(builder.verifySignatures([sourceKp.publicKey()])).toBe(true);
  });

  it("supports multi-signature signing offline", () => {
    const coSigner = Keypair.random();

    const builder = new OfflineTransactionBuilder({
      sourceAddress: sourceKp.publicKey(),
      sequenceNumber: "10",
      networkPassphrase: Networks.TESTNET,
    }).addPayment({
      destination: destKp.publicKey(),
      amount: "100",
    });

    builder.sign(sourceKp);
    builder.sign(coSigner);

    const tx = builder.build();
    expect(tx.signatures).toHaveLength(2);
    expect(builder.verifySignatures([sourceKp.publicKey(), coSigner.publicKey()])).toBe(true);
  });

  it("fails verification when signature was signed by an unrelated key", () => {
    const otherKp = Keypair.random();
    const builder = new OfflineTransactionBuilder({
      sourceAddress: sourceKp.publicKey(),
      sequenceNumber: "10",
      networkPassphrase: Networks.TESTNET,
    }).addPayment({
      destination: destKp.publicKey(),
      amount: "100",
    });

    builder.sign(sourceKp);

    // Verifying against otherKp should fail
    expect(builder.verifySignatures([otherKp.publicKey()])).toBe(false);
  });

  describe("Serialization sound round-trip", () => {
    it("serializes to XDR and deserializes losslessly with intact hash and signature", () => {
      const builder = new OfflineTransactionBuilder({
        sourceAddress: sourceKp.publicKey(),
        sequenceNumber: "200",
        networkPassphrase: Networks.TESTNET,
        baseFee: 150,
      }).addPayment({
        destination: destKp.publicKey(),
        amount: "30",
      });

      builder.sign(sourceKp);

      const originalHash = builder.getTransactionHash();
      const xdrString = builder.toXDR();

      const restoredBuilder = OfflineTransactionBuilder.fromXDR(
        xdrString,
        Networks.TESTNET,
      );

      expect(restoredBuilder.getTransactionHash()).toBe(originalHash);
      expect(restoredBuilder.build().source).toBe(sourceKp.publicKey());
      expect(restoredBuilder.build().sequence).toBe("201");
      expect(restoredBuilder.verifySignatures([sourceKp.publicKey()])).toBe(true);
    });

    it("serializes to JSON transport package and deserializes accurately", () => {
      const builder = new OfflineTransactionBuilder({
        sourceAddress: sourceKp.publicKey(),
        sequenceNumber: "300",
        networkPassphrase: Networks.TESTNET,
      }).addPayment({
        destination: destKp.publicKey(),
        amount: "10",
      });

      builder.sign(sourceKp);

      const jsonString = builder.serialize();
      const restoredBuilder = OfflineTransactionBuilder.deserialize(jsonString);

      expect(restoredBuilder.getTransactionHash()).toBe(builder.getTransactionHash());
      expect(restoredBuilder.build().source).toBe(sourceKp.publicKey());
      expect(restoredBuilder.verifySignatures([sourceKp.publicKey()])).toBe(true);
    });
  });

  describe("Validation", () => {
    it("rejects building with 0 operations", () => {
      const builder = new OfflineTransactionBuilder({
        sourceAddress: sourceKp.publicKey(),
        sequenceNumber: "1",
        networkPassphrase: Networks.TESTNET,
      });

      expect(() => builder.build()).toThrow(ValidationError);
    });

    it("rejects invalid source address on construction", () => {
      expect(
        () =>
          new OfflineTransactionBuilder({
            sourceAddress: "NOT_A_VALID_KEY",
            sequenceNumber: "1",
            networkPassphrase: Networks.TESTNET,
          }),
      ).toThrow(ValidationError);
    });

    it("rejects invalid destination on addPayment", () => {
      const builder = new OfflineTransactionBuilder({
        sourceAddress: sourceKp.publicKey(),
        sequenceNumber: "1",
        networkPassphrase: Networks.TESTNET,
      });

      expect(() =>
        builder.addPayment({
          destination: "INVALID_DEST",
          amount: "10",
        }),
      ).toThrow(ValidationError);
    });

    it("rejects non-positive payment amount", () => {
      const builder = new OfflineTransactionBuilder({
        sourceAddress: sourceKp.publicKey(),
        sequenceNumber: "1",
        networkPassphrase: Networks.TESTNET,
      });

      expect(() =>
        builder.addPayment({
          destination: destKp.publicKey(),
          amount: "-5",
        }),
      ).toThrow(ValidationError);
    });

    it("rejects invalid secret seed on sign", () => {
      const builder = new OfflineTransactionBuilder({
        sourceAddress: sourceKp.publicKey(),
        sequenceNumber: "1",
        networkPassphrase: Networks.TESTNET,
      }).addPayment({
        destination: destKp.publicKey(),
        amount: "10",
      });

      expect(() => builder.sign("SBADSECRET")).toThrow(ValidationError);
    });
  });
});
