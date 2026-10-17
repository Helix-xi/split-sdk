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

  it("exports invoice versioning components (#1056)", () => {
    expect(typeof sdk.InvoiceVersionTracker).toBe("function");
    expect(typeof sdk.InvoiceVersionManager).toBe("function");
    expect(typeof sdk.InMemoryVersionStore).toBe("function");
    expect(typeof sdk.computeChecksum).toBe("function");
    expect(typeof sdk.InvoiceVersionNotFoundError).toBe("function");
    expect(typeof sdk.UnsafeRollbackError).toBe("function");
    expect(typeof sdk.InvalidVersionError).toBe("function");
  });

  it("exports payment analytics components (#1055)", () => {
    expect(typeof sdk.PaymentAnalyticsEngine).toBe("function");
  });

  it("exports smart contract ABI caching components (#1054)", () => {
    expect(typeof sdk.ContractAbiCache).toBe("function");
    expect(typeof sdk.MemoryAbiStorage).toBe("function");
    expect(typeof sdk.AdapterAbiStorage).toBe("function");
    expect(typeof sdk.StaticContractAbiFetcher).toBe("function");
    expect(typeof sdk.RpcContractAbiFetcher).toBe("function");
    expect(typeof sdk.AbiFetchError).toBe("function");
    expect(typeof sdk.AbiNotFoundError).toBe("function");
  });

  it("exports invoice collaboration components (#1053)", () => {
    expect(typeof sdk.InvoiceCollaborationManager).toBe("function");
    expect(typeof sdk.CollaborationError).toBe("function");
    expect(typeof sdk.CommentNotFoundError).toBe("function");
    expect(typeof sdk.ApprovalRequestNotFoundError).toBe("function");
    expect(typeof sdk.UnauthorizedCollaborationError).toBe("function");
  });
});
