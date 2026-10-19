import type { StellarSplitClient } from "./client.js";
import type { ConflictStrategy } from "./types.js";

export interface QueuedOperation {
  id: string;
  method: string;
  args: any[];
  timestamp: number;
}

export interface OfflineQueueConfig {
  enabled: boolean;
  maxQueueSize: number;
  persistToStorage: boolean;
  conflictStrategy?: ConflictStrategy;
}

export interface SyncResult {
  synced: number;
  failed: number;
  conflicts: number;
  operations: QueuedOperation[];
}

function serializeQueue(queue: QueuedOperation[]): string {
  return JSON.stringify(queue, (_key, value) =>
    typeof value === "bigint" ? { __type: "bigint", value: value.toString() } : value
  );
}

function deserializeQueue(raw: string): QueuedOperation[] {
  return JSON.parse(raw, (_key, value) => {
    if (value && typeof value === "object" && value.__type === "bigint") {
      return BigInt(value.value);
    }
    return value;
  });
}

export class OfflineQueue {
  private queue: QueuedOperation[] = [];
  public readonly config: OfflineQueueConfig;
  private client: StellarSplitClient;
  private readonly storageKey = "stellar_split_offline_queue";
  private isDraining = false;

  constructor(client: StellarSplitClient, config: OfflineQueueConfig) {
    this.client = client;
    this.config = config;
    if (this.config.persistToStorage) {
      this.loadFromStorage();
    }
  }

  public enqueue(method: string, args: any[]): void {
    if (!this.config.enabled) return;

    if (this.queue.length >= this.config.maxQueueSize) {
      this.queue.shift();
    }

    const operation: QueuedOperation = {
      id:
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : Math.random().toString(36).substring(2),
      method,
      args,
      timestamp: Date.now(),
    };

    this.queue.push(operation);

    if (this.config.persistToStorage) {
      this.saveToStorage();
    }
  }

  public getQueue(): QueuedOperation[] {
    return [...this.queue];
  }

  public clear(): void {
    this.queue = [];
    if (this.config.persistToStorage) {
      this.saveToStorage();
    }
  }

  public recoverState(): QueuedOperation[] {
    this.loadFromStorage();
    return this.getQueue();
  }

  public async drain(): Promise<void> {
    await this.sync();
  }

  public async sync(conflictStrategy?: ConflictStrategy): Promise<SyncResult> {
    if (this.isDraining || this.queue.length === 0) {
      return { synced: 0, failed: 0, conflicts: 0, operations: [] };
    }

    this.isDraining = true;
    const strategy = conflictStrategy ?? this.config.conflictStrategy ?? "remote-wins";
    const operationsToDrain = [...this.queue];
    this.clear();

    const result: SyncResult = {
      synced: 0,
      failed: 0,
      conflicts: 0,
      operations: operationsToDrain,
    };

    for (const op of operationsToDrain) {
      try {
        if (op.method === "pay" && op.args.length > 0 && typeof this.client.getInvoice === "function") {
          const invoiceId = op.args[0]?.invoiceId;
          if (invoiceId) {
            try {
              const remoteInvoice = await this.client.getInvoice(invoiceId);
              if (remoteInvoice && remoteInvoice.status !== "pending") {
                result.conflicts++;
                if (strategy === "remote-wins") {
                  this.client.emit("queue:conflict:resolved", {
                    operation: op,
                    strategy,
                    remoteState: remoteInvoice,
                  });
                  continue;
                }
              }
            } catch {
              // Proceed if remote fetch fails
            }
          }
        }

        // @ts-ignore
        await this.client[op.method](...op.args);
        result.synced++;
      } catch (error) {
        result.failed++;
        this.client.emit("queue:operation:failed", { operation: op, error });
      }
    }

    this.client.emit("queue:drained", undefined);
    this.isDraining = false;
    return result;
  }

  public loadFromStorage(): void {
    if (typeof localStorage !== "undefined") {
      try {
        const stored = localStorage.getItem(this.storageKey);
        if (stored) {
          this.queue = deserializeQueue(stored);
        }
      } catch (e) {
        console.warn("Failed to load offline queue from storage", e);
      }
    }
  }

  public saveToStorage(): void {
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(this.storageKey, serializeQueue(this.queue));
      } catch (e) {
        console.warn("Failed to save offline queue to storage", e);
      }
    }
  }
}

