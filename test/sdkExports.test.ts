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

  it("exports parseAmount, InvoiceStateSubscriber, WebhookClient, and AnalyticsTracker (#1034, #1035, #1036, #1037)", () => {
    expect(typeof sdk.parseAmount).toBe("function");
    expect(typeof sdk.InvoiceStateSubscriber).toBe("function");
    expect(typeof sdk.matchesFilter).toBe("function");
    expect(typeof sdk.WebhookClient).toBe("function");
    expect(typeof sdk.WebhookVerificationError).toBe("function");
    expect(typeof sdk.AnalyticsTracker).toBe("function");
    expect(typeof sdk.AnalyticsCollector).toBe("function");
    expect(typeof sdk.PrivacyController).toBe("function");
    expect(typeof sdk.wrapClientWithAnalytics).toBe("function");
  });
});

