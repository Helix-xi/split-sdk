/**
 * NonceManager — Automatic transaction nonce management and replay protection.
 *
 * Tracks nonce state per account, automatically increments nonces for sequential
 * transaction generation, handles resets and on-chain synchronization, and validates
 * nonces prior to submission to prevent replay attacks.
 */

import { StellarSplitError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export interface NonceState {
  accountId: string;
  currentNonce: bigint;
  lastUpdated: number;
  inFlightNonces: bigint[];
}

export interface NonceManagerOptions {
  /** Default starting nonce for newly tracked accounts (default: 0n). */
  initialNonce?: bigint;
  /** Amount to increment nonce by on each auto-increment (default: 1n). */
  incrementStep?: bigint;
  /** Maximum number of committed nonces retained in memory for replay protection (default: 1000). */
  replayWindowSize?: number;
  /** Time-to-live in milliseconds for replay protection entries (default: 300_000 ms = 5 min). */
  replayTtlMs?: number;
  /** Whether strict sequential ordering is required during validation (default: true). */
  strictOrdering?: boolean;
}

export interface NonceResetOptions {
  /** New nonce value to reset to. Defaults to 0n if omitted. */
  newNonce?: bigint;
  /** Reason for the reset (e.g. 'sync', 'reorg', 'manual', 'error'). */
  reason?: string;
  /** Whether to clear the seen replay history for this account. Defaults to false. */
  clearReplayHistory?: boolean;
}

export interface NonceValidationResult {
  valid: boolean;
  error?: string;
  expectedNonce?: bigint;
  receivedNonce?: bigint;
}

export type NonceEventType =
  | "nonce:acquired"
  | "nonce:committed"
  | "nonce:rolled_back"
  | "nonce:reset"
  | "nonce:validation_failed";

export interface NonceEvent {
  type: NonceEventType;
  accountId: string;
  nonce?: bigint;
  previousNonce?: bigint;
  newNonce?: bigint;
  reason?: string;
  timestamp: number;
}

export type NonceEventListener = (event: NonceEvent) => void;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class NonceError extends StellarSplitError {
  constructor(message: string, code: string = "NONCE_ERROR", context?: Record<string, unknown>) {
    super(message, code, context);
    this.name = "NonceError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidNonceError extends NonceError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "INVALID_NONCE", context);
    this.name = "InvalidNonceError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DuplicateNonceError extends NonceError {
  readonly nonce: bigint;

  constructor(accountId: string, nonce: bigint) {
    super(
      `Replay attack detected: nonce ${nonce.toString()} has already been used for account ${accountId}.`,
      "DUPLICATE_NONCE",
      { accountId, nonce: nonce.toString() }
    );
    this.name = "DuplicateNonceError";
    this.nonce = nonce;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class StaleNonceError extends NonceError {
  readonly expectedNonce: bigint;
  readonly receivedNonce: bigint;

  constructor(accountId: string, expectedNonce: bigint, receivedNonce: bigint) {
    super(
      `Stale nonce: expected nonce ${expectedNonce.toString()}, but received ${receivedNonce.toString()} for account ${accountId}.`,
      "STALE_NONCE",
      { accountId, expectedNonce: expectedNonce.toString(), receivedNonce: receivedNonce.toString() }
    );
    this.name = "StaleNonceError";
    this.expectedNonce = expectedNonce;
    this.receivedNonce = receivedNonce;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NonceGapError extends NonceError {
  readonly expectedNonce: bigint;
  readonly receivedNonce: bigint;

  constructor(accountId: string, expectedNonce: bigint, receivedNonce: bigint) {
    super(
      `Nonce gap detected: expected nonce ${expectedNonce.toString()}, but received ${receivedNonce.toString()} for account ${accountId}.`,
      "NONCE_GAP",
      { accountId, expectedNonce: expectedNonce.toString(), receivedNonce: receivedNonce.toString() }
    );
    this.name = "NonceGapError";
    this.expectedNonce = expectedNonce;
    this.receivedNonce = receivedNonce;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// NonceManager Implementation
// ---------------------------------------------------------------------------

export class NonceManager {
  private readonly defaultInitialNonce: bigint;
  private readonly incrementStep: bigint;
  private readonly replayWindowSize: number;
  private readonly replayTtlMs: number;
  private readonly strictOrdering: boolean;

  /** Tracked accounts and their nonce states. */
  private readonly states = new Map<string, NonceState>();

  /**
   * Replay detection cache: map accountId -> Map(nonceString -> timestamp).
   */
  private readonly committedNonces = new Map<string, Map<string, number>>();

  /** Event listeners */
  private readonly listeners = new Set<NonceEventListener>();

  constructor(options: NonceManagerOptions = {}) {
    this.defaultInitialNonce = options.initialNonce ?? 0n;
    this.incrementStep = options.incrementStep ?? 1n;
    this.replayWindowSize = options.replayWindowSize ?? 1000;
    this.replayTtlMs = options.replayTtlMs ?? 300_000;
    this.strictOrdering = options.strictOrdering ?? true;
  }

  // -------------------------------------------------------------------------
  // Account Tracking & State
  // -------------------------------------------------------------------------

  /**
   * Register or initialize tracking for an account.
   * If already tracked, returns existing state without overwriting.
   */
  trackAccount(accountId: string, initialNonce?: bigint): NonceState {
    if (!accountId || typeof accountId !== "string") {
      throw new InvalidNonceError("Invalid accountId: must be a non-empty string.");
    }

    let state = this.states.get(accountId);
    if (!state) {
      state = {
        accountId,
        currentNonce: initialNonce ?? this.defaultInitialNonce,
        lastUpdated: Date.now(),
        inFlightNonces: [],
      };
      this.states.set(accountId, state);
    }
    return { ...state, inFlightNonces: [...state.inFlightNonces] };
  }

  /**
   * Check whether an account is currently tracked.
   */
  hasAccount(accountId: string): boolean {
    return this.states.has(accountId);
  }

  /**
   * Get the current nonce state for an account.
   * If not already tracked, initializes it.
   */
  getNonceState(accountId: string): NonceState {
    this.ensureTracked(accountId);
    const state = this.states.get(accountId)!;
    return { ...state, inFlightNonces: [...state.inFlightNonces] };
  }

  /**
   * Get the current nonce for an account.
   */
  getNonce(accountId: string): bigint {
    return this.getNonceState(accountId).currentNonce;
  }

  /**
   * Peek at the next nonce that will be returned by auto-increment,
   * without mutating state or advancing the counter.
   */
  peekNextNonce(accountId: string): bigint {
    const state = this.getNonceState(accountId);
    return state.currentNonce;
  }

  // -------------------------------------------------------------------------
  // Auto-Increment & Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Acquire the next nonce for transaction creation and automatically increment
   * the tracked counter.
   *
   * The returned nonce is placed into `inFlightNonces` until committed or rolled back.
   */
  acquireNextNonce(accountId: string): bigint {
    this.ensureTracked(accountId);
    const state = this.states.get(accountId)!;

    const nonceToIssue = state.currentNonce;
    state.currentNonce += this.incrementStep;
    state.lastUpdated = Date.now();
    state.inFlightNonces.push(nonceToIssue);

    this.emit({
      type: "nonce:acquired",
      accountId,
      nonce: nonceToIssue,
      timestamp: Date.now(),
    });

    return nonceToIssue;
  }

  /**
   * Alias for {@link acquireNextNonce}.
   */
  consumeNonce(accountId: string): bigint {
    return this.acquireNextNonce(accountId);
  }

  /**
   * Commit a nonce after transaction submission or confirmation.
   * Records the nonce into the replay detection cache to prevent replays.
   */
  commitNonce(accountId: string, nonce: bigint | number | string): void {
    const parsed = this.parseNonce(nonce);
    this.ensureTracked(accountId);
    const state = this.states.get(accountId)!;

    // Remove from in-flight list if present
    const idx = state.inFlightNonces.indexOf(parsed);
    if (idx !== -1) {
      state.inFlightNonces.splice(idx, 1);
    }

    // Add to committed replay protection map
    let history = this.committedNonces.get(accountId);
    if (!history) {
      history = new Map<string, number>();
      this.committedNonces.set(accountId, history);
    }

    const key = parsed.toString();
    history.set(key, Date.now());

    // Prune expired or excessive entries
    this.pruneReplayCache(history);

    this.emit({
      type: "nonce:committed",
      accountId,
      nonce: parsed,
      timestamp: Date.now(),
    });
  }

  /**
   * Roll back an acquired in-flight nonce (e.g. if transaction construction
   * or signing failed before network broadcast).
   */
  rollbackNonce(accountId: string, nonce: bigint | number | string): void {
    const parsed = this.parseNonce(nonce);
    this.ensureTracked(accountId);
    const state = this.states.get(accountId)!;

    const idx = state.inFlightNonces.indexOf(parsed);
    if (idx !== -1) {
      state.inFlightNonces.splice(idx, 1);
    }

    // If this was the most recently issued nonce and currentNonce matches next step,
    // step currentNonce back down.
    if (state.currentNonce === parsed + this.incrementStep) {
      state.currentNonce = parsed;
    }

    this.emit({
      type: "nonce:rolled_back",
      accountId,
      nonce: parsed,
      timestamp: Date.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Resets & Synchronization
  // -------------------------------------------------------------------------

  /**
   * Handle nonce reset for an account.
   * Can be used to recover from desynchronization or explicit reset.
   */
  resetNonce(accountId: string, options?: NonceResetOptions | bigint): void {
    this.ensureTracked(accountId);
    const state = this.states.get(accountId)!;
    const previous = state.currentNonce;

    let targetNonce = 0n;
    let reason = "manual";
    let clearReplay = false;

    if (typeof options === "bigint") {
      targetNonce = options;
    } else if (options) {
      if (options.newNonce !== undefined) {
        targetNonce = options.newNonce;
      }
      if (options.reason) {
        reason = options.reason;
      }
      clearReplay = options.clearReplayHistory ?? false;
    }

    if (targetNonce < 0n) {
      throw new InvalidNonceError(`Cannot reset nonce to negative value: ${targetNonce.toString()}`);
    }

    state.currentNonce = targetNonce;
    state.inFlightNonces = [];
    state.lastUpdated = Date.now();

    if (clearReplay) {
      this.committedNonces.delete(accountId);
    }

    this.emit({
      type: "nonce:reset",
      accountId,
      previousNonce: previous,
      newNonce: targetNonce,
      reason,
      timestamp: Date.now(),
    });
  }

  /**
   * Synchronize the account's nonce with an external / on-chain source.
   */
  async syncNonce(accountId: string, fetchFn: () => Promise<bigint | number | string>): Promise<bigint> {
    const onChainVal = await fetchFn();
    const parsed = this.parseNonce(onChainVal);
    this.resetNonce(accountId, { newNonce: parsed, reason: "sync" });
    return parsed;
  }

  // -------------------------------------------------------------------------
  // Validation Before Send
  // -------------------------------------------------------------------------

  /**
   * Validate a nonce before sending a transaction.
   * Throws typed errors (DuplicateNonceError, StaleNonceError, NonceGapError, InvalidNonceError)
   * if validation fails.
   */
  validateBeforeSend(
    accountId: string,
    nonce: bigint | number | string,
    options?: { strictOrdering?: boolean }
  ): void {
    const result = this.validate(accountId, nonce, options);
    if (!result.valid) {
      this.emit({
        type: "nonce:validation_failed",
        accountId,
        nonce: result.receivedNonce,
        reason: result.error ?? "Validation failed",
        timestamp: Date.now(),
      });

      if (result.error?.includes("Replay attack")) {
        throw new DuplicateNonceError(accountId, result.receivedNonce!);
      }
      if (result.error?.includes("Stale")) {
        throw new StaleNonceError(accountId, result.expectedNonce!, result.receivedNonce!);
      }
      if (result.error?.includes("gap")) {
        throw new NonceGapError(accountId, result.expectedNonce!, result.receivedNonce!);
      }
      throw new InvalidNonceError(result.error ?? "Invalid nonce");
    }
  }

  /**
   * Pure check method that returns validation details without throwing.
   */
  validate(
    accountId: string,
    nonce: bigint | number | string,
    options?: { strictOrdering?: boolean }
  ): NonceValidationResult {
    let parsed: bigint;
    try {
      parsed = this.parseNonce(nonce);
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : "Invalid nonce format",
      };
    }

    // 1. Replay attack check: has this nonce already been committed?
    const history = this.committedNonces.get(accountId);
    if (history && history.has(parsed.toString())) {
      const seenTime = history.get(parsed.toString())!;
      const now = Date.now();
      if (now - seenTime <= this.replayTtlMs) {
        return {
          valid: false,
          error: `Replay attack detected: nonce ${parsed.toString()} was already committed for account ${accountId}`,
          receivedNonce: parsed,
        };
      }
    }

    // 2. Ordering check against current state
    const state = this.getNonceState(accountId);
    const expected = state.currentNonce;
    const isStrict = options?.strictOrdering ?? this.strictOrdering;

    if (parsed < expected) {
      // Check if it's currently marked as in-flight
      const isInFlight = state.inFlightNonces.includes(parsed);
      if (!isInFlight) {
        return {
          valid: false,
          error: `Stale nonce: received ${parsed.toString()} is lower than expected nonce ${expected.toString()}`,
          expectedNonce: expected,
          receivedNonce: parsed,
        };
      }
    } else if (isStrict && parsed > expected) {
      return {
        valid: false,
        error: `Nonce gap: received ${parsed.toString()} but expected ${expected.toString()}`,
        expectedNonce: expected,
        receivedNonce: parsed,
      };
    }

    return {
      valid: true,
      expectedNonce: expected,
      receivedNonce: parsed,
    };
  }

  // -------------------------------------------------------------------------
  // Event Subscription & Utilities
  // -------------------------------------------------------------------------

  /**
   * Subscribe to nonce lifecycle events. Returns unsubscribe function.
   */
  onEvent(listener: NonceEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Clear all tracked accounts and state.
   */
  clear(): void {
    this.states.clear();
    this.committedNonces.clear();
    this.listeners.clear();
  }

  /**
   * Total number of tracked accounts.
   */
  get size(): number {
    return this.states.size;
  }

  // -------------------------------------------------------------------------
  // Internal Helpers
  // -------------------------------------------------------------------------

  private ensureTracked(accountId: string): void {
    if (!this.states.has(accountId)) {
      this.trackAccount(accountId);
    }
  }

  private parseNonce(val: bigint | number | string): bigint {
    if (typeof val === "bigint") {
      if (val < 0n) throw new InvalidNonceError(`Nonce cannot be negative: ${val.toString()}`);
      return val;
    }
    if (typeof val === "number") {
      if (!Number.isFinite(val) || !Number.isInteger(val) || val < 0) {
        throw new InvalidNonceError(`Nonce must be a non-negative integer: ${val}`);
      }
      return BigInt(val);
    }
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (!/^\d+$/.test(trimmed)) {
        throw new InvalidNonceError(`Invalid numeric nonce string: "${val}"`);
      }
      return BigInt(trimmed);
    }
    throw new InvalidNonceError(`Unsupported nonce type: ${typeof val}`);
  }

  private pruneReplayCache(history: Map<string, number>): void {
    const now = Date.now();
    for (const [nonceStr, timestamp] of history) {
      if (now - timestamp > this.replayTtlMs) {
        history.delete(nonceStr);
      }
    }
    while (history.size > this.replayWindowSize) {
      const oldestKey = history.keys().next().value;
      if (oldestKey !== undefined) {
        history.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  private emit(event: NonceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("Error in NonceManager event listener:", err);
      }
    }
  }
}
