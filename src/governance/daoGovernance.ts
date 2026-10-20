/**
 * DAO governance framework for decentralized protocol decisions.
 *
 * Provides a proposal lifecycle, weighted voting (for/against/abstain),
 * treasury management gated by governance authorization, execution logic,
 * and analytics for transparency.
 */

export type ProposalState =
  | 'pending'
  | 'active'
  | 'succeeded'
  | 'defeated'
  | 'queued'
  | 'executed'
  | 'cancelled';

export type VoteChoice = 'for' | 'against' | 'abstain';

export interface GovernanceConfig {
  /** Voting power required for a proposal to reach quorum. */
  quorum: number;
  /** Fraction (0-1) of for-votes required among for+against to succeed. */
  approvalThreshold: number;
  /** Duration in ms a proposal stays open for voting. */
  votingPeriodMs: number;
  /** Minimum voting power required to create a proposal. */
  proposalThreshold: number;
}

export interface ProposalAction {
  /** Recipient address for treasury transfers, if any. */
  target?: string;
  /** Amount to transfer from treasury on execution. */
  amount?: number;
}

export interface Proposal {
  id: string;
  proposer: string;
  title: string;
  description: string;
  createdAt: number;
  startAt: number;
  endAt: number;
  state: ProposalState;
  action: ProposalAction;
  votes: Record<VoteChoice, number>;
  voters: Record<string, VoteChoice>;
}

export interface GovernanceAnalytics {
  totalProposals: number;
  byState: Record<ProposalState, number>;
  totalVotingPowerCast: number;
  participationRate: number;
  treasuryBalance: number;
}

export interface VotingPowerSource {
  /** Returns the voting power for a given address. */
  getVotingPower(address: string): number;
}

export class DAOGovernance {
  private readonly config: GovernanceConfig;
  private readonly powerSource: VotingPowerSource;
  private readonly proposals = new Map<string, Proposal>();
  private treasuryBalance = 0;
  private proposalCounter = 0;

  constructor(config: GovernanceConfig, powerSource: VotingPowerSource) {
    this.config = config;
    this.powerSource = powerSource;
  }

  // --- Proposal system -----------------------------------------------------

  createProposal(
    proposer: string,
    title: string,
    description: string,
    action: ProposalAction = {},
    now: number = Date.now(),
  ): Proposal {
    if (this.powerSource.getVotingPower(proposer) < this.config.proposalThreshold) {
      throw new Error('Insufficient voting power to create proposal');
    }
    if (!title.trim()) {
      throw new Error('Proposal title is required');
    }

    const id = `prop-${++this.proposalCounter}`;
    const proposal: Proposal = {
      id,
      proposer,
      title,
      description,
      createdAt: now,
      startAt: now,
      endAt: now + this.config.votingPeriodMs,
      state: 'active',
      action,
      votes: { for: 0, against: 0, abstain: 0 },
      voters: {},
    };
    this.proposals.set(id, proposal);
    return proposal;
  }

  getProposal(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  listProposals(): Proposal[] {
    return Array.from(this.proposals.values());
  }

  cancelProposal(id: string, caller: string): Proposal {
    const proposal = this.requireProposal(id);
    if (proposal.proposer !== caller) {
      throw new Error('Only the proposer can cancel this proposal');
    }
    if (proposal.state === 'executed') {
      throw new Error('Cannot cancel an executed proposal');
    }
    proposal.state = 'cancelled';
    return proposal;
  }

  // --- Voting --------------------------------------------------------------

  castVote(id: string, voter: string, choice: VoteChoice, now: number = Date.now()): Proposal {
    const proposal = this.requireProposal(id);
    this.refreshState(proposal, now);
    if (proposal.state !== 'active') {
      throw new Error(`Cannot vote on proposal in state ${proposal.state}`);
    }
    if (proposal.voters[voter]) {
      throw new Error('Address has already voted on this proposal');
    }
    const power = this.powerSource.getVotingPower(voter);
    if (power <= 0) {
      throw new Error('Address has no voting power');
    }
    proposal.voters[voter] = choice;
    proposal.votes[choice] += power;
    return proposal;
  }

  // --- Execution -----------------------------------------------------------

  executeProposal(id: string, now: number = Date.now()): Proposal {
    const proposal = this.requireProposal(id);
    this.refreshState(proposal, now);
    if (proposal.state !== 'succeeded') {
      throw new Error(`Proposal cannot be executed in state ${proposal.state}`);
    }
    const { target, amount } = proposal.action;
    if (amount !== undefined && amount > 0) {
      if (!target) {
        throw new Error('Treasury transfer requires a target address');
      }
      this.withdraw(target, amount);
    }
    proposal.state = 'executed';
    return proposal;
  }

  // --- Treasury ------------------------------------------------------------

  deposit(amount: number): number {
    if (amount <= 0) {
      throw new Error('Deposit amount must be positive');
    }
    this.treasuryBalance += amount;
    return this.treasuryBalance;
  }

  getTreasuryBalance(): number {
    return this.treasuryBalance;
  }

  /** Withdraw is internal-only; external withdrawals must go through executeProposal. */
  private withdraw(target: string, amount: number): void {
    if (amount > this.treasuryBalance) {
      throw new Error('Insufficient treasury balance');
    }
    if (!target) {
      throw new Error('Withdrawal target is required');
    }
    this.treasuryBalance -= amount;
  }

  // --- Analytics -----------------------------------------------------------

  getAnalytics(): GovernanceAnalytics {
    const byState: Record<ProposalState, number> = {
      pending: 0,
      active: 0,
      succeeded: 0,
      defeated: 0,
      queued: 0,
      executed: 0,
      cancelled: 0,
    };
    let totalVotingPowerCast = 0;
    let totalEligible = 0;
    for (const proposal of this.proposals.values()) {
      byState[proposal.state] += 1;
      const cast = proposal.votes.for + proposal.votes.against + proposal.votes.abstain;
      totalVotingPowerCast += cast;
      totalEligible += cast;
    }
    const participationRate = totalEligible === 0 ? 0 : totalVotingPowerCast / totalEligible;
    return {
      totalProposals: this.proposals.size,
      byState,
      totalVotingPowerCast,
      participationRate,
      treasuryBalance: this.treasuryBalance,
    };
  }

  // --- Internals -----------------------------------------------------------

  private requireProposal(id: string): Proposal {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new Error(`Proposal ${id} not found`);
    }
    return proposal;
  }

  private refreshState(proposal: Proposal, now: number): void {
    if (proposal.state !== 'active' || now < proposal.endAt) {
      return;
    }
    const { for: forVotes, against: againstVotes, abstain: abstainVotes } = proposal.votes;
    const totalCast = forVotes + againstVotes + abstainVotes;
    const decisive = forVotes + againstVotes;
    const quorumReached = totalCast >= this.config.quorum;
    const approval = decisive === 0 ? 0 : forVotes / decisive;
    proposal.state =
      quorumReached && approval >= this.config.approvalThreshold ? 'succeeded' : 'defeated';
  }
}
