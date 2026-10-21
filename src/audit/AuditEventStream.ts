import type { AuditEvent } from '../types/audit.js';

export type AuditEventHandler = (event: AuditEvent) => void;

export interface AuditStreamOptions {
  /** Buffer size for event replay on new subscriber (default: 0 = no replay) */
  bufferSize?: number;
  /** Filter function - only events passing this are emitted */
  filter?: (event: AuditEvent) => boolean;
}

/**
 * AuditEventStream provides a pub/sub stream for SDK audit events.
 * Supports multiple subscribers, optional event buffering for replay,
 * and per-subscriber filtering.
 */
export class AuditEventStream {
  private readonly handlers = new Set<AuditEventHandler>();
  private readonly buffer: AuditEvent[] = [];
  private readonly bufferSize: number;
  private readonly filter?: (event: AuditEvent) => boolean;
  private closed = false;

  constructor(options: AuditStreamOptions = {}) {
    this.bufferSize = options.bufferSize ?? 0;
    this.filter = options.filter;
  }

  /**
   * Publish an audit event to all subscribers.
   * If the stream is closed, the event is silently dropped.
   */
  publish(event: AuditEvent): void {
    if (this.closed) return;
    if (this.filter && !this.filter(event)) return;

    if (this.bufferSize > 0) {
      this.buffer.push(event);
      if (this.buffer.length > this.bufferSize) {
        this.buffer.shift();
      }
    }

    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // subscriber errors must not break the stream
      }
    }
  }

  /**
   * Subscribe to audit events. Replays buffered events immediately if any.
   * Returns an unsubscribe function.
   */
  subscribe(handler: AuditEventHandler): () => void {
    this.handlers.add(handler);
    // Replay buffered events
    for (const event of this.buffer) {
      try {
        handler(event);
      } catch {
        // ignore replay errors
      }
    }
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Returns the number of active subscribers.
   */
  get subscriberCount(): number {
    return this.handlers.size;
  }

  /**
   * Returns a copy of the current replay buffer.
   */
  getBuffer(): AuditEvent[] {
    return [...this.buffer];
  }

  /**
   * Clears all buffered events.
   */
  clearBuffer(): void {
    this.buffer.length = 0;
  }

  /**
   * Close the stream, preventing any further event publishing.
   * All existing subscribers are removed.
   */
  close(): void {
    this.closed = true;
    this.handlers.clear();
  }

  /**
   * Whether the stream has been closed.
   */
  get isClosed(): boolean {
    return this.closed;
  }
}
