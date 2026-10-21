/**
 * Multi-Signature Transaction Support for StellarSplit SDK.
 *
 * Provides a coordinator for collecting signatures from multiple signers
 * before a Stellar transaction can be submitted. Supports threshold-based
 * authorization and per-signer weights.
 */

export interface SignerInfo {
  /** Stellar G... public key */
  publicKey: string;
  /** Signing weight (default: 1) */
  weight: number;
}

export interface MultiSigConfig {
  /** Ordered list of authorized signers and their weights */
  signers: SignerInfo[];
  /** Combined weight required to authorize the transaction */
  threshold: number;
}

export type MultiSigStatus =
  | 'pending'     // Awaiting signatures
  | 'authorized'  // Threshold reached
  | 'expired'     // Collection window passed
  | 'rejected';   // Explicitly rejected

export interface SignatureEntry {
  publicKey: string;
  signature: string;
  timestamp: number;
  weight: number;
}

export interface MultiSigSession {
  id: string;
  txHash: string;
  txXdr: string;
  config: MultiSigConfig;
  signatures: SignatureEntry[];
  status: MultiSigStatus;
  createdAt: number;
  expiresAt?: number;
}

export interface MultiSigSessionOptions {
  /** Expiry unix timestamp (ms). No expiry if omitted. */
  expiresAt?: number;
}

export type MultiSigEventType =
  | 'signature:added'
  | 'threshold:reached'
  | 'session:expired'
  | 'session:rejected';

export interface MultiSigEvent {
  type: MultiSigEventType;
  sessionId: string;
  timestamp: number;
  detail?: Record<string, unknown>;
}

export type MultiSigEventHandler = (event: MultiSigEvent) => void;

/**
 * Compute the total accumulated signing weight for a session.
 */
export function computeAccumulatedWeight(session: MultiSigSession): number {
  return session.signatures.reduce((sum, sig) => sum + sig.weight, 0);
}

/**
 * Check whether a session has reached its signing threshold.
 */
export function isThresholdReached(session: MultiSigSession): boolean {
  return computeAccumulatedWeight(session) >= session.config.threshold;
}

/**
 * MultiSigCoordinator collects signatures for Stellar transactions
 * requiring multiple signers, enforcing a configurable weight threshold.
 */
export class MultiSigCoordinator {
  private readonly sessions = new Map<string, MultiSigSession>();
  private readonly eventHandlers = new Set<MultiSigEventHandler>();
  private sessionCounter = 0;

  /**
   * Create a new multi-sig session for a transaction.
   */
  createSession(
    txHash: string,
    txXdr: string,
    config: MultiSigConfig,
    options: MultiSigSessionOptions = {}
  ): MultiSigSession {
    if (config.signers.length === 0) {
      throw new Error('Multi-sig config must include at least one signer');
    }
    if (config.threshold <= 0) {
      throw new Error('Threshold must be positive');
    }
    const totalWeight = config.signers.reduce((s, signer) => s + signer.weight, 0);
    if (totalWeight < config.threshold) {
      throw new Error(
        `Total signer weight (${totalWeight}) cannot satisfy threshold (${config.threshold})`
      );
    }

    const id = `multisig-${++this.sessionCounter}`;
    const session: MultiSigSession = {
      id,
      txHash,
      txXdr,
      config,
      signatures: [],
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: options.expiresAt,
    };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): MultiSigSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all session IDs.
   */
  listSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Subscribe to multi-sig events. Returns an unsubscribe function.
   */
  onEvent(handler: MultiSigEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emit(event: MultiSigEvent): void {
    for (const handler of this.eventHandlers) {
      try { handler(event); } catch { /* ignore */ }
    }
  }

  /**
   * Add a signature to the session.
   * - The signer must be in the authorized signers list.
   * - Each signer may only sign once per session.
   * - The session must be in 'pending' status.
   * Returns true if the threshold was reached after this signature.
   */
  addSignature(sessionId: string, publicKey: string, signature: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found`);

    if (session.status !== 'pending') {
      throw new Error(`Session '${sessionId}' is not pending (status: ${session.status})`);
    }

    // Check expiry
    if (session.expiresAt !== undefined && Date.now() > session.expiresAt) {
      session.status = 'expired';
      this.emit({ type: 'session:expired', sessionId, timestamp: Date.now() });
      throw new Error(`Session '${sessionId}' has expired`);
    }

    // Find authorized signer
    const signerInfo = session.config.signers.find((s) => s.publicKey === publicKey);
    if (!signerInfo) {
      throw new Error(`Signer '${publicKey}' is not authorized for session '${sessionId}'`);
    }

    // Prevent duplicate signatures
    const alreadySigned = session.signatures.some((s) => s.publicKey === publicKey);
    if (alreadySigned) {
      throw new Error(`Signer '${publicKey}' has already signed session '${sessionId}'`);
    }

    session.signatures.push({
      publicKey,
      signature,
      timestamp: Date.now(),
      weight: signerInfo.weight,
    });

    this.emit({ type: 'signature:added', sessionId, timestamp: Date.now(), detail: { publicKey, weight: signerInfo.weight } });

    if (isThresholdReached(session)) {
      session.status = 'authorized';
      this.emit({ type: 'threshold:reached', sessionId, timestamp: Date.now(), detail: { totalWeight: computeAccumulatedWeight(session) } });
      return true;
    }
    return false;
  }

  /**
   * Reject a pending session.
   */
  rejectSession(sessionId: string, reason?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found`);
    if (session.status !== 'pending') {
      throw new Error(`Session '${sessionId}' is not pending`);
    }
    session.status = 'rejected';
    this.emit({ type: 'session:rejected', sessionId, timestamp: Date.now(), detail: { reason } });
  }

  /**
   * Returns how much more weight is needed to reach threshold.
   */
  remainingWeightNeeded(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found`);
    const accumulated = computeAccumulatedWeight(session);
    return Math.max(0, session.config.threshold - accumulated);
  }
}
