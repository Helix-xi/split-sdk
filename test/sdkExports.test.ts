import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";

describe("public API surface (issues #586, #588, #589)", () => {
  it("exports the signing vault adapters", () => {
    expect(typeof sdk.KeypairSigner).toBe("function");
    expect(typeof sdk.InvalidKeypairError).toBe("function");
    expect(typeof sdk.isInvalidKeypairError).toBe("function");
    expect(typeof sdk.EncryptedFileSigner).toBe("function");
    expect(typeof sdk.CloudKmsSigner).toBe("function");
    expect(typeof sdk.isRegionError).toBe("function");
    expect(typeof sdk.encryptSigningKeyToPem).toBe("function");
    expect(typeof sdk.writeEncryptedSigningKeyFile).toBe("function");
  });

  it("exports the footprint optimizer utilities", () => {
    expect(typeof sdk.optimizeFootprint).toBe("function");
    expect(typeof sdk.footprintDiff).toBe("function");
    expect(typeof sdk.submitTransaction).toBe("function");
  });

  it("exports LobstrAdapter and WalletConnectionTimeoutError", () => {
    expect(typeof sdk.LobstrAdapter).toBe("function");
    expect(typeof sdk.WalletConnectionTimeoutError).toBe("function");
    expect(typeof sdk.isWalletConnectionTimeoutError).toBe("function");
  });

  it("exports the validation suite (issues #1061, #1062, #1063, #1064)", () => {
    // Errors
    expect(typeof sdk.DeadlineValidationError).toBe("function");
    expect(typeof sdk.isDeadlineValidationError).toBe("function");
    expect(typeof sdk.AmountValidationError).toBe("function");
    expect(typeof sdk.isAmountValidationError).toBe("function");
    expect(typeof sdk.AddressValidationError).toBe("function");
    expect(typeof sdk.isAddressValidationError).toBe("function");
    expect(typeof sdk.SignatureValidationError).toBe("function");
    expect(typeof sdk.isSignatureValidationError).toBe("function");

    // Deadline validator
    expect(typeof sdk.validateDeadline).toBe("function");
    expect(typeof sdk.validateDeadlineOrThrow).toBe("function");
    expect(typeof sdk.isFutureDeadline).toBe("function");
    expect(typeof sdk.parseDeadline).toBe("function");
    expect(typeof sdk.DeadlineValidator).toBe("function");

    // Amount validator
    expect(typeof sdk.validateAmount).toBe("function");
    expect(typeof sdk.validateAmountOrThrow).toBe("function");
    expect(typeof sdk.isValidAmount).toBe("function");
    expect(typeof sdk.parseToStroops).toBe("function");
    expect(typeof sdk.AmountValidator).toBe("function");

    // Address validator
    expect(typeof sdk.validateAddress).toBe("function");
    expect(typeof sdk.validateAddressOrThrow).toBe("function");
    expect(typeof sdk.isStellarAddress).toBe("function");
    expect(typeof sdk.detectAddressType).toBe("function");
    expect(typeof sdk.verifyAddressChecksum).toBe("function");
    expect(typeof sdk.AddressValidator).toBe("function");

    // Signature validator
    expect(typeof sdk.validateEd25519Signature).toBe("function");
    expect(typeof sdk.validateEd25519SignatureOrThrow).toBe("function");
    expect(typeof sdk.validateMultiSig).toBe("function");
    expect(typeof sdk.validateMultiSigOrThrow).toBe("function");
    expect(typeof sdk.validateWebhookSignaturePayload).toBe("function");
    expect(typeof sdk.isValidSignatureFormat).toBe("function");
    expect(typeof sdk.normalizeSignature).toBe("function");
    expect(typeof sdk.normalizePublicKey).toBe("function");
    expect(typeof sdk.SignatureValidator).toBe("function");
  });
});

