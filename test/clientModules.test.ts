import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  StellarSplitClient,
  BaseClientModule,
  InvoiceModule,
  PaymentModule,
  DisputeModule,
  AdminModule,
  GroupModule,
  TemplateModule,
  MilestoneModule,
} from "../src/index.js";
import {
  InvoiceModule as ClientInvoiceModule,
  PaymentModule as ClientPaymentModule,
  DisputeModule as ClientDisputeModule,
  AdminModule as ClientAdminModule,
  GroupModule as ClientGroupModule,
  TemplateModule as ClientTemplateModule,
  MilestoneModule as ClientMilestoneModule,
} from "../src/client/index.js";

function makeClient(): StellarSplitClient {
  const kp = Keypair.random();
  const contractId = StrKey.encodeContract(kp.rawPublicKey());
  return new StellarSplitClient({
    rpcUrl: "https://example.com/rpc",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId,
  });
}

describe("Client Modular Architecture (#1079)", () => {
  let client: StellarSplitClient;

  beforeEach(() => {
    client = makeClient();
  });

  describe("Module initialization and structure", () => {
    it("initializes all logical sub-modules on the client instance", () => {
      expect(client.invoices).toBeInstanceOf(InvoiceModule);
      expect(client.invoices).toBeInstanceOf(BaseClientModule);
      expect(client.payments).toBeInstanceOf(PaymentModule);
      expect(client.payments).toBeInstanceOf(BaseClientModule);
      expect(client.disputes).toBeInstanceOf(DisputeModule);
      expect(client.disputes).toBeInstanceOf(BaseClientModule);
      expect(client.admin).toBeInstanceOf(AdminModule);
      expect(client.admin).toBeInstanceOf(BaseClientModule);
      expect(client.groups).toBeInstanceOf(GroupModule);
      expect(client.groups).toBeInstanceOf(BaseClientModule);
      expect(client.templates).toBeInstanceOf(TemplateModule);
      expect(client.templates).toBeInstanceOf(BaseClientModule);
      expect(client.milestones).toBeInstanceOf(MilestoneModule);
      expect(client.milestones).toBeInstanceOf(BaseClientModule);
    });

    it("exports modules from both src/index.ts and src/client/index.ts", () => {
      expect(InvoiceModule).toBe(ClientInvoiceModule);
      expect(PaymentModule).toBe(ClientPaymentModule);
      expect(DisputeModule).toBe(ClientDisputeModule);
      expect(AdminModule).toBe(ClientAdminModule);
      expect(GroupModule).toBe(ClientGroupModule);
      expect(TemplateModule).toBe(ClientTemplateModule);
      expect(MilestoneModule).toBe(ClientMilestoneModule);
    });
  });

  describe("InvoiceModule delegation", () => {
    it("delegates getInvoice to client.getInvoice", async () => {
      const mockInvoice = { id: "inv-100", creator: "GABC", status: "Pending" } as any;
      const spy = vi.spyOn(client, "getInvoice").mockResolvedValue(mockInvoice);

      const res1 = await client.invoices.get("inv-100");
      expect(res1).toBe(mockInvoice);
      expect(spy).toHaveBeenCalledWith("inv-100", undefined);

      const res2 = await client.invoices.getInvoice("inv-100");
      expect(res2).toBe(mockInvoice);
    });

    it("delegates createInvoice to client.createInvoice", async () => {
      const mockResult = { invoiceId: "inv-200", txHash: "tx-abc" };
      const spy = vi.spyOn(client, "createInvoice").mockResolvedValue(mockResult);

      const params = {
        creator: "GABC",
        recipients: [{ address: "GDEF", amount: 1000n }],
        token: "USDC",
        deadline: 1234567,
      };
      const res = await client.invoices.create(params);
      expect(res).toBe(mockResult);
      expect(spy).toHaveBeenCalledWith(params);
    });

    it("delegates cloneInvoice to client.cloneInvoice", async () => {
      const spy = vi.spyOn(client, "cloneInvoice").mockResolvedValue("inv-new");
      const res = await client.invoices.clone("inv-old", { deadline: 9999 });
      expect(res).toBe("inv-new");
      expect(spy).toHaveBeenCalledWith("inv-old", { deadline: 9999 });
    });
  });

  describe("PaymentModule delegation", () => {
    it("delegates pay to client.pay", async () => {
      const mockTx = { txHash: "tx-pay-123" } as any;
      const spy = vi.spyOn(client, "pay").mockResolvedValue(mockTx);

      const payParams = { invoiceId: "inv-1", amount: 500n, payer: "GABC" };
      const res = await client.payments.pay(payParams);
      expect(res).toBe(mockTx);
      expect(spy).toHaveBeenCalledWith(payParams);
    });

    it("delegates batchPay and verifyBatchPay", async () => {
      const batchSpy = vi.spyOn(client, "batchPay").mockResolvedValue({ txHash: "tx-batch" } as any);
      const payments = [{ invoiceId: "inv-1", amount: 100n }];
      const res = await client.payments.batchPay("GABC", payments);
      expect(res.txHash).toBe("tx-batch");
      expect(batchSpy).toHaveBeenCalledWith("GABC", payments);

      const verifyMock = { valid: true, invoices: [], commonToken: "USDC", errors: [] };
      const verifySpy = vi.spyOn(client, "verifyBatchPay").mockResolvedValue(verifyMock);
      const verifyRes = await client.payments.verifyBatchPay(payments);
      expect(verifyRes).toBe(verifyMock);
      expect(verifySpy).toHaveBeenCalledWith(payments);
    });
  });

  describe("DisputeModule delegation", () => {
    it("delegates raise and resolve to client dispute methods", async () => {
      const mockResult = { disputeId: "disp-1", txHash: "tx-disp" };
      const raiseSpy = vi.spyOn(client, "raiseDispute").mockResolvedValue(mockResult);
      const resolveSpy = vi.spyOn(client, "resolveDispute").mockResolvedValue(mockResult);

      const r1 = await client.disputes.raise("inv-1");
      expect(r1).toBe(mockResult);
      expect(raiseSpy).toHaveBeenCalledWith("inv-1");

      const r2 = await client.disputes.resolve({ invoiceId: "inv-1", action: "refund", caller: "GABC" });
      expect(r2).toBe(mockResult);
      expect(resolveSpy).toHaveBeenCalledWith({ invoiceId: "inv-1", action: "refund", caller: "GABC" });
    });
  });

  describe("AdminModule delegation", () => {
    it("delegates admin freeze and unfreeze", async () => {
      const mockTx = { txHash: "tx-admin" } as any;
      const freezeSpy = vi.spyOn(client, "adminFreeze").mockResolvedValue(mockTx);
      const unfreezeSpy = vi.spyOn(client, "adminUnfreeze").mockResolvedValue(mockTx);

      const f = await client.admin.freeze("inv-1", "GADMIN");
      expect(f).toBe(mockTx);
      expect(freezeSpy).toHaveBeenCalledWith("inv-1", "GADMIN");

      const u = await client.admin.unfreeze("inv-1", "GADMIN");
      expect(u).toBe(mockTx);
      expect(unfreezeSpy).toHaveBeenCalledWith("inv-1", "GADMIN");
    });
  });

  describe("GroupModule delegation", () => {
    it("delegates group creation and status retrieval", async () => {
      const createSpy = vi.spyOn(client, "createGroup").mockResolvedValue("grp-100");
      const statusMock = { id: "grp-100", name: "Alpha", invoices: [] } as any;
      const statusSpy = vi.spyOn(client, "getGroupStatus").mockResolvedValue(statusMock);

      const gid = await client.groups.create("Alpha", "Group Memo");
      expect(gid).toBe("grp-100");
      expect(createSpy).toHaveBeenCalledWith("Alpha", "Group Memo");

      const status = await client.groups.getStatus("grp-100");
      expect(status).toBe(statusMock);
      expect(statusSpy).toHaveBeenCalledWith("grp-100");
    });
  });

  describe("TemplateModule delegation", () => {
    it("delegates template listing and saving", async () => {
      const listSpy = vi.spyOn(client, "listTemplates").mockResolvedValue(["tmpl-1", "tmpl-2"]);
      const templates = await client.templates.list("GCREATOR");
      expect(templates).toEqual(["tmpl-1", "tmpl-2"]);
      expect(listSpy).toHaveBeenCalledWith("GCREATOR");
    });
  });

  describe("MilestoneModule delegation", () => {
    it("delegates milestone completion and active milestone retrieval", async () => {
      const milestoneMock = { index: 1, description: "Phase 1", amount: 1000n, completed: false } as any;
      const activeSpy = vi.spyOn(client, "getActiveMilestone").mockResolvedValue(milestoneMock);
      const completeSpy = vi.spyOn(client, "completeMilestone").mockResolvedValue({
        invoiceId: "inv-1",
        milestoneIndex: 1,
        releasedAmount: 1000n,
        txHash: "tx-m1",
      });

      const active = await client.milestones.getActive("inv-1");
      expect(active).toBe(milestoneMock);
      expect(activeSpy).toHaveBeenCalledWith("inv-1");

      const comp = await client.milestones.complete("inv-1", 1);
      expect(comp.milestoneIndex).toBe(1);
      expect(completeSpy).toHaveBeenCalledWith("inv-1", 1);
    });
  });
});
