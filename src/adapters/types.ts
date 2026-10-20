/** Generic wallet adapter interface for signing Stellar transactions. */
export interface WalletAdapter {
  /** Return the wallet's public key (G... address). */
  getAddress(): Promise<string>;
  /**
   * Sign a transaction XDR string.
   *
   * @param xdr     - Base64-encoded transaction XDR.
   * @param network - Network passphrase.
   * @returns Signed transaction XDR.
   */
  signTransaction(xdr: string, network: string): Promise<string>;
}

/** Supported source chains for the cross-chain payment bridge. */
export type BridgeSourceChain = 'ethereum' | 'solana';

/** Lifecycle status of a cross-chain bridge transfer. */
export type BridgeTransferStatus =
  | 'pending'
  | 'source-confirmed'
  | 'bridging'
  | 'stellar-confirmed'
  | 'completed'
  | 'failed';

/** Parameters for initiating an Ethereum/Solana -> Stellar bridge transfer. */
export interface BridgeTransferParams {
  /** Source chain the funds are bridged from. */
  sourceChain: BridgeSourceChain;
  /** Address on the source chain sending the funds. */
  sourceAddress: string;
  /** Stellar (G...) address receiving the bridged funds. */
  destinationAddress: string;
  /** Amount to bridge, as a decimal string in the source asset's units. */
  amount: string;
  /** Optional source-chain asset identifier (e.g. ERC-20 / SPL mint). */
  sourceAsset?: string;
  /** Optional Stellar asset to receive (defaults to the bridged asset). */
  destinationAsset?: string;
}

/** A cross-chain bridge transfer record. */
export interface BridgeTransfer {
  /** Unique bridge transfer identifier. */
  id: string;
  /** Current lifecycle status. */
  status: BridgeTransferStatus;
  /** Parameters the transfer was initiated with. */
  params: BridgeTransferParams;
  /** Source-chain transaction hash, once submitted. */
  sourceTxHash?: string;
  /** Stellar transaction hash, once submitted. */
  stellarTxHash?: string;
  /** Error message when the transfer fails. */
  error?: string;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** Last update timestamp (ms since epoch). */
  updatedAt: number;
}

/** Bridge lifecycle events emitted to subscribers. */
export type BridgeEvent =
  | { type: 'transfer-created'; transfer: BridgeTransfer }
  | { type: 'status-changed'; transfer: BridgeTransfer; previousStatus: BridgeTransferStatus }
  | { type: 'source-confirmed'; transfer: BridgeTransfer; sourceTxHash: string }
  | { type: 'stellar-confirmed'; transfer: BridgeTransfer; stellarTxHash: string }
  | { type: 'completed'; transfer: BridgeTransfer }
  | { type: 'failed'; transfer: BridgeTransfer; error: string };

/** Listener invoked for each emitted bridge event. */
export type BridgeEventListener = (event: BridgeEvent) => void;

/**
 * Cross-chain payment bridge client for moving funds from Ethereum/Solana to Stellar.
 */
export interface BridgeClient {
  /** Initiate a bridge transfer and return its initial record. */
  initiateTransfer(params: BridgeTransferParams): Promise<BridgeTransfer>;
  /** Fetch the current state of a bridge transfer by id. */
  getTransfer(id: string): Promise<BridgeTransfer | undefined>;
  /** List all known bridge transfers. */
  listTransfers(): Promise<BridgeTransfer[]>;
  /** Subscribe to bridge lifecycle events; returns an unsubscribe function. */
  onEvent(listener: BridgeEventListener): () => void;
}

/** A single operation to include in a multi-op invoice transaction. */
export interface InvoiceOperation {
  /** Operation kind (e.g. 'payment', 'create-account', 'change-trust'). */
  type: string;
  /** Operation-specific parameters. */
  params: Record<string, unknown>;
  /** Optional human-readable description of the operation. */
  description?: string;
}

/** Parameters for building a complex multi-op invoice transaction. */
export interface InvoiceTransactionParams {
  /** Stellar (G...) address funding the transaction. */
  sourceAddress: string;
  /** Network passphrase the transaction targets. */
  network: string;
  /** Optional memo attached to the transaction. */
  memo?: string;
  /** Ordered operations composing the invoice. */
  operations: InvoiceOperation[];
}

/** A built, unsigned multi-op invoice transaction. */
export interface InvoiceTransaction {
  /** Base64-encoded unsigned transaction XDR. */
  xdr: string;
  /** Source account the transaction was built from. */
  sourceAddress: string;
  /** Network passphrase the transaction targets. */
  network: string;
  /** Operations included in the transaction, in order. */
  operations: InvoiceOperation[];
  /** Optional memo attached to the transaction. */
  memo?: string;
  /** Build timestamp (ms since epoch). */
  createdAt: number;
}

/** Lifecycle events emitted by the invoice transaction builder. */
export type InvoiceTransactionEvent =
  | { type: 'build-started'; params: InvoiceTransactionParams }
  | { type: 'operation-added'; operation: InvoiceOperation; index: number }
  | { type: 'build-completed'; transaction: InvoiceTransaction }
  | { type: 'build-failed'; error: string };

/** Listener invoked for each emitted invoice transaction event. */
export type InvoiceTransactionEventListener = (event: InvoiceTransactionEvent) => void;

/**
 * Builder for composing complex multi-op invoice transactions.
 */
export interface InvoiceTransactionBuilder {
  /** Append an operation to the invoice. */
  addOperation(operation: InvoiceOperation): InvoiceTransactionBuilder;
  /** Build the unsigned transaction from the accumulated operations. */
  build(): Promise<InvoiceTransaction>;
  /** Subscribe to builder lifecycle events; returns an unsubscribe function. */
  onEvent(listener: InvoiceTransactionEventListener): () => void;
}

/**
 * Configuration for optional request deduplication by nonce.
 *
 * Deduplication is opt-in: when omitted (or `enabled` is false) requests
 * pass through unchanged and no nonce tracking occurs.
 */
export interface DeduplicationConfig {
  /** Whether deduplication is enabled. Defaults to false. */
  enabled?: boolean;
  /**
   * Time-to-live for a tracked nonce, in milliseconds. Once a nonce has been
   * seen for longer than this window it is evicted and may be accepted again.
   * When omitted, entries do not expire by time.
   */
  ttlMs?: number;
  /**
   * Maximum number of nonces retained. When exceeded, the oldest entries are
   * evicted first (FIFO). When omitted, capacity is unbounded.
   */
  maxEntries?: number;
}

/** Outcome of a deduplication check for a single request nonce. */
export type DeduplicationOutcome = 'accepted' | 'duplicate';

/** Lifecycle events emitted by the request deduplicator. */
export type DeduplicationEvent =
  | { type: 'request-accepted'; nonce: string }
  | { type: 'duplicate-detected'; nonce: string }
  | { type: 'nonce-evicted'; nonce: string; reason: 'expired' | 'capacity' };

/** Listener invoked for each emitted deduplication event. */
export type DeduplicationEventListener = (event: DeduplicationEvent) => void;

/**
 * Optional request deduplicator keyed by nonce.
 *
 * Implementations track previously seen nonces and report whether an incoming
 * request is a first-seen (accepted) or duplicate request.
 */
export interface RequestDeduplicator {
  /**
   * Check a nonce and record it when first seen.
   *
   * @param nonce - Unique request nonce.
   * @returns 'accepted' for a first-seen nonce, 'duplicate' otherwise.
   */
  check(nonce: string): DeduplicationOutcome;
  /** Whether the given nonce is currently tracked. */
  has(nonce: string): boolean;
  /** Remove all tracked nonces. */
  clear(): void;
  /** Subscribe to deduplication events; returns an unsubscribe function. */
  onEvent(listener: DeduplicationEventListener): () => void;
}

/**
 * Configuration for the database connection pool.
 *
 * Pooling is opt-in: when omitted, callers acquire a fresh connection per
 * request and no recycling, health checking, or failover occurs.
 */
export interface ConnectionPoolConfig {
  /** Whether connection pooling is enabled. Defaults to false. */
  enabled?: boolean;
  /** Maximum number of live connections the pool will hold. */
  maxConnections?: number;
  /** Minimum number of idle connections kept warm. */
  minConnections?: number;
  /**
   * Maximum age of a connection, in milliseconds, before it is recycled.
   * When omitted, connections are not recycled by age.
   */
  maxConnectionAgeMs?: number;
  /**
   * Maximum time a connection may sit idle, in milliseconds, before it is
   * recycled. When omitted, idle connections are not recycled by time.
   */
  maxIdleMs?: number;
  /** Interval between background health checks, in milliseconds. */
  healthCheckIntervalMs?: number;
  /** Maximum time to wait for a connection before failing, in milliseconds. */
  acquireTimeoutMs?: number;
  /** Ordered list of failover endpoints tried when the primary is unhealthy. */
  failoverEndpoints?: string[];
}

/** Lifecycle state of a pooled connection. */
export type ConnectionState = 'idle' | 'in-use' | 'recycling' | 'closed';

/** A single pooled database connection. */
export interface PooledConnection {
  /** Unique connection identifier. */
  id: string;
  /** Endpoint the connection is bound to. */
  endpoint: string;
  /** Current lifecycle state. */
  state: ConnectionState;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** Last time the connection was used (ms since epoch). */
  lastUsedAt: number;
}

/** Snapshot of pool statistics for monitoring. */
export interface ConnectionPoolStats {
  /** Total connections currently held by the pool. */
  total: number;
  /** Connections currently checked out. */
  inUse: number;
  /** Connections currently idle and available. */
  idle: number;
  /** Connections created since the pool started. */
  created: number;
  /** Connections recycled (closed and replaced) since the pool started. */
  recycled: number;
  /** Connections closed since the pool started. */
  closed: number;
  /** Number of acquire requests that timed out. */
  acquireTimeouts: number;
  /** Number of failover switches performed. */
  failovers: number;
}

/** Result of a connection health check. */
export interface ConnectionHealthCheck {
  /** Whether the connection is healthy. */
  healthy: boolean;
  /** Endpoint that was checked. */
  endpoint: string;
  /** Check timestamp (ms since epoch). */
  checkedAt: number;
  /** Optional error message when unhealthy. */
  error?: string;
}

/** Lifecycle events emitted by the connection pool. */
export type ConnectionPoolEvent =
  | { type: 'connection-created'; connection: PooledConnection }
  | { type: 'connection-acquired'; connection: PooledConnection }
  | { type: 'connection-released'; connection: PooledConnection }
  | { type: 'connection-recycled'; connection: PooledConnection; reason: 'age' | 'idle' | 'unhealthy' }
  | { type: 'health-check'; result: ConnectionHealthCheck }
  | { type: 'failover'; from: string; to: string }
  | { type: 'stats'; stats: ConnectionPoolStats };

/** Listener invoked for each emitted connection pool event. */
export type ConnectionPoolEventListener = (event: ConnectionPoolEvent) => void;

/**
 * Database connection pool manager.
 *
 * Hands out pooled connections, recycles stale ones, runs health checks,
 * fails over to alternate endpoints, and exposes statistics for monitoring.
 */
export interface ConnectionPool {
  /** Acquire a connection from the pool, waiting up to the configured timeout. */
  acquire(): Promise<PooledConnection>;
  /** Return a connection to the pool for reuse. */
  release(connection: PooledConnection): void;
  /** Run a health check against a connection (or the active endpoint). */
  healthCheck(connection?: PooledConnection): Promise<ConnectionHealthCheck>;
  /** Switch to the next healthy failover endpoint. */
  failover(): Promise<string>;
  /** Return a snapshot of current pool statistics. */
  getStats(): ConnectionPoolStats;
  /** Close all connections and stop background health checks. */
  close(): Promise<void>;
  /** Subscribe to pool lifecycle events; returns an unsubscribe function. */
  onEvent(listener: ConnectionPoolEventListener): () => void;
}
