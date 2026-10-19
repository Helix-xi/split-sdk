import { BaseClientModule } from "./BaseModule.js";
import type {
  DisputeResult,
  ArbiterVote,
  DisputeStatus,
} from "../../types.js";

/**
 * Module dedicated to Dispute and Arbitration flows:
 * raising disputes, arbiter voting, resolving disputes, and evidence submission.
 */
export class DisputeModule extends BaseClientModule {
  /**
   * Raises a dispute on an invoice.
   */
  async raise(invoiceId: string): Promise<DisputeResult> {
    return this.client.raiseDispute(invoiceId);
  }

  /** Alias for `raise`. */
  async raiseDispute(invoiceId: string): Promise<DisputeResult> {
    return this.raise(invoiceId);
  }

  /**
   * Disputes an invoice (legacy entrypoint).
   */
  async dispute(invoiceId: string): Promise<DisputeResult> {
    return this.client.disputeInvoice(invoiceId);
  }

  /** Alias for `dispute`. */
  async disputeInvoice(invoiceId: string): Promise<DisputeResult> {
    return this.dispute(invoiceId);
  }

  /**
   * Submits an arbiter vote on an active dispute.
   */
  async submitVote(vote: ArbiterVote): Promise<DisputeResult> {
    return this.client.submitArbiterVote(vote);
  }

  /** Alias for `submitVote`. */
  async submitArbiterVote(vote: ArbiterVote): Promise<DisputeResult> {
    return this.submitVote(vote);
  }

  /**
   * Casts an arbiter vote and returns the transaction hash.
   */
  async vote(params: ArbiterVote): Promise<{ txHash: string }> {
    return this.client.voteDispute(params);
  }

  /** Alias for `vote`. */
  async voteDispute(params: ArbiterVote): Promise<{ txHash: string }> {
    return this.vote(params);
  }

  /**
   * Resolves a dispute with a final ruling.
   */
  async resolve(params: {
    invoiceId: string;
    action: "release" | "refund";
    caller: string;
  }): Promise<DisputeResult> {
    return this.client.resolveDispute(params);
  }

  /** Alias for `resolve`. */
  async resolveDispute(params: {
    invoiceId: string;
    action: "release" | "refund";
    caller: string;
  }): Promise<DisputeResult> {
    return this.resolve(params);
  }

  /**
   * Retrieves the current dispute status for an invoice.
   */
  async getStatus(invoiceId: string): Promise<DisputeStatus> {
    return this.client.getDisputeStatus(invoiceId);
  }

  /** Alias for `getStatus`. */
  async getDisputeStatus(invoiceId: string): Promise<DisputeStatus> {
    return this.getStatus(invoiceId);
  }

  /**
   * Adds evidence URI / hash to an active dispute.
   */
  async addEvidence(
    invoiceId: string,
    evidenceUri: string,
    submitter: string
  ): Promise<DisputeResult> {
    return this.client.addDisputeEvidence(invoiceId, evidenceUri, submitter);
  }

  /** Alias for `addEvidence`. */
  async addDisputeEvidence(
    invoiceId: string,
    evidenceUri: string,
    submitter: string
  ): Promise<DisputeResult> {
    return this.addEvidence(invoiceId, evidenceUri, submitter);
  }
}
