/**
 * DAO governance types for decentralized protocol governance.
 *
 * Covers the proposal lifecycle, voting mechanisms, treasury management,
 * execution logic, and governance analytics.
 */

/** Lifecycle states a proposal moves through. */
export type ProposalState =
  | 'pending' // created, awaiting voting start
  | 'active' // voting open
  | 'succeeded' // passed quorum + threshold
  | 'defeated' // failed quorum or threshold
  | 'queued' // passed, awaiting execution
  | 'executed' // execution completed
  | 'canceled'; // canceled by proposer or governance

/** Supported vote choices. */
export type VoteChoice = 'for' | 'against' | 'abstain';

/** A single on-chain vote record. */
export interface Vote {
  /** Voter address (one vote per address per proposal). */
  voter: string;
  choice: VoteChoice;
  /** Voting power applied to this vote at cast time. */
  weight: bigint;
  /** Optional human-readable rationale. */
  reason?: string;
  /** Timestamp (ms) the vote was cast. */
  timestamp: number;
}

/** An executable action attached to a proposal. */
export interface ProposalAction {
  /** Target contract/account address. */
  target: string;
  /** Encoded calldata. */
  data: string;
  /** Native value to forward, if any. */
  value?: bigint;
}

/** A governance proposal. */
export interface Proposal {
  id: string;
  proposer: string;
  title: string;
  description: string;
  actions: ProposalAction[];
  state: ProposalState;
  /** Voting power required to reach quorum. */
  quorum: bigint;
  /** Minimum approval ratio (0-1) required to succeed. */
  threshold: number;
  /** Timestamp (ms) voting opens. */
  startTime: number;
  /** Timestamp (ms) voting closes. */
  endTime: number;
  /** Aggregated voting power per choice. */
  votes: {
    for: bigint;
    against: bigint;
    abstain: bigint;
  };
  /** Individual vote records keyed by voter address. */
  voters: Record<string, Vote>;
  /** Timestamp (ms) the proposal was created. */
  createdAt: number;
  /** Timestamp (ms) the proposal was executed, if applicable. */
  executedAt?: number;
}

/** Parameters for creating a proposal. */
export interface CreateProposalParams {
  proposer: string;
  title: string;
  description: string;
  actions?: ProposalAction[];
  /** Optional override for quorum. */
  quorum?: bigint;
  /** Optional override for approval threshold (0-1). */
  threshold?: number;
  /** Voting duration in ms. */
  votingDuration?: number;
}

/** Parameters for casting a vote. */
export interface CastVoteParams {
  proposalId: string;
  voter: string;
  choice: VoteChoice;
  reason?: string;
}

/** Governance configuration (voting power, quorum, thresholds). */
export interface GovernanceConfig {
  /** Default quorum in voting power units. */
  quorum: bigint;
  /** Default approval threshold (0-1). */
  threshold: number;
  /** Default voting duration in ms. */
  votingDuration: number;
  /** Minimum voting power required to create a proposal. */
  proposalThreshold: bigint;
  /** Whether voting power is weighted (true) or one-vote-per-address (false). */
  weightedVoting: boolean;
}

/** Treasury balance and authorization state. */
export interface Treasury {
  /** Treasury account address. */
  address: string;
  /** Current native/token balance. */
  balance: bigint;
  /** Token symbol for the tracked balance. */
  symbol: string;
}

/** Parameters for a treasury withdrawal requiring governance authorization. */
export interface TreasuryWithdrawParams {
  /** Proposal that authorized the withdrawal. */
  proposalId: string;
  /** Recipient address. */
  recipient: string;
  /** Amount to withdraw. */
  amount: bigint;
}

/** Aggregated governance analytics. */
export interface GovernanceAnalytics {
  totalProposals: number;
  activeProposals: number;
  executedProposals: number;
  defeatedProposals: number;
  /** Total voting power participating across proposals. */
  totalVotingPower: bigint;
  /** Average participation ratio (0-1) across closed proposals. */
  averageParticipation: number;
  /** Treasury balance snapshot. */
  treasuryBalance: bigint;
}

/** Result of an execution attempt. */
export interface ExecutionResult {
  proposalId: string;
  success: boolean;
  /** Transaction hashes for executed actions. */
  txHashes: string[];
  error?: string;
}
