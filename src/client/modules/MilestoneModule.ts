import { BaseClientModule } from "./BaseModule.js";
import type {
  RoundCloseResult,
  RoundInfo,
  MilestoneResult,
  Milestone,
} from "../../types.js";

/**
 * Module dedicated to Milestones and Funding Round operations.
 */
export class MilestoneModule extends BaseClientModule {
  /**
   * Closes a funding round after the round deadline has passed.
   */
  async closeRound(invoiceId: string): Promise<RoundCloseResult> {
    return this.client.closeRound(invoiceId);
  }

  /**
   * Retrieves status and configuration of a funding round.
   */
  async getRoundInfo(invoiceId: string): Promise<RoundInfo> {
    return this.client.getRoundInfo(invoiceId);
  }

  /**
   * Marks a milestone as completed and unlocks corresponding tranche funds.
   */
  async complete(invoiceId: string, index: number): Promise<MilestoneResult> {
    return this.client.completeMilestone(invoiceId, index);
  }

  /** Alias for `complete`. */
  async completeMilestone(invoiceId: string, index: number): Promise<MilestoneResult> {
    return this.complete(invoiceId, index);
  }

  /**
   * Retrieves the currently active milestone for an invoice.
   */
  async getActive(invoiceId: string): Promise<Milestone | null> {
    return this.client.getActiveMilestone(invoiceId);
  }

  /** Alias for `getActive`. */
  async getActiveMilestone(invoiceId: string): Promise<Milestone | null> {
    return this.getActive(invoiceId);
  }

  /**
   * Retrieves all milestones defined for an invoice.
   */
  async list(invoiceId: string): Promise<Milestone[]> {
    return this.client.getMilestones(invoiceId);
  }

  /** Alias for `list`. */
  async getMilestones(invoiceId: string): Promise<Milestone[]> {
    return this.list(invoiceId);
  }
}
