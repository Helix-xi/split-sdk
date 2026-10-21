/**
 * Enterprise SLA monitoring for the StellarSplit SDK.
 *
 * Provides named SLA definitions with configurable thresholds, tier-based
 * classification (Gold / Silver / Bronze), real-time violation tracking, and
 * comprehensive reporting. Fires registered callbacks whenever a threshold is
 * breached.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Pre-defined SLA tiers with recommended thresholds in milliseconds. */
export const SlaTiers = {
  Gold: 500,
  Silver: 2_000,
  Bronze: 5_000,
} as const;

/** Named SLA tier. */
export type SlaTier = keyof typeof SlaTiers;

/** A registered SLA definition. */
export interface SlaDefinition {
  /** Unique name for this SLA (e.g. "invoice.create"). */
  name: string;
  /** Maximum allowed duration in milliseconds before a breach is raised. */
  thresholdMs: number;
  /** Optional human-readable description. */
  description?: string;
}

/** A recorded SLA event. */
export interface SlaEvent {
  /** The SLA name this event applies to. */
  slaName: string;
  /** Observed duration in milliseconds. */
  durationMs: number;
  /** Unix millisecond timestamp when the event was recorded. */
  recordedAt: number;
  /** Whether this event exceeded the configured threshold. */
  violated: boolean;
}

/** Aggregated report for a single SLA definition. */
export interface SlaMetrics {
  /** SLA name. */
  name: string;
  /** Configured threshold. */
  thresholdMs: number;
  /** Total events recorded. */
  totalEvents: number;
  /** Number of events that violated the threshold. */
  violations: number;
  /** Compliance rate (0–1). */
  complianceRate: number;
  /** Minimum observed duration. */
  minDurationMs: number;
  /** Maximum observed duration. */
  maxDurationMs: number;
  /** Average observed duration. */
  avgDurationMs: number;
  /** 95th-percentile observed duration. */
  p95DurationMs: number;
}

/** Full SLA report produced by {@link EnterpriseSlaMonitor.getSlaReport}. */
export interface SlaReport {
  /** Per-SLA metrics, one entry per registered SLA. */
  metrics: SlaMetrics[];
  /** Total violations across all SLAs. */
  totalViolations: number;
  /** Overall compliance rate across all events (0–1). */
  overallComplianceRate: number;
  /** Unix millisecond timestamp when this report was generated. */
  generatedAt: number;
}

/** Callback invoked whenever a violation is detected. */
export type ViolationCallback = (event: SlaEvent) => void;

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

/**
 * Enterprise SLA monitor.
 *
 * Register SLA definitions, record observed durations, retrieve violation
 * history, and subscribe to real-time violation events.
 *
 * @example
 * ```ts
 * const monitor = new EnterpriseSlaMonitor();
 * monitor.registerSla({ name: "invoice.create", thresholdMs: SlaTiers.Gold });
 * monitor.onViolation((e) => console.error("SLA breach:", e));
 *
 * monitor.recordEvent("invoice.create", 350);  // OK
 * monitor.recordEvent("invoice.create", 900);  // triggers callback
 *
 * const report = monitor.getSlaReport();
 * ```
 */
export class EnterpriseSlaMonitor {
  private readonly _slas = new Map<string, SlaDefinition>();
  private readonly _events = new Map<string, SlaEvent[]>();
  private readonly _callbacks: ViolationCallback[] = [];

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register or update an SLA definition.
   *
   * If an SLA with the same `name` was already registered it is replaced.
   *
   * @param definition - The SLA definition to register.
   */
  registerSla(definition: SlaDefinition): void {
    this._slas.set(definition.name, { ...definition });
    if (!this._events.has(definition.name)) {
      this._events.set(definition.name, []);
    }
  }

  /**
   * Convenience method to register a SLA using a pre-defined tier threshold.
   *
   * @param name        - Unique SLA name.
   * @param tier        - One of `"Gold"`, `"Silver"`, or `"Bronze"`.
   * @param description - Optional description.
   */
  registerSlaTier(name: string, tier: SlaTier, description?: string): void {
    this.registerSla({ name, thresholdMs: SlaTiers[tier], description });
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  /**
   * Record an observed duration for a named SLA.
   *
   * If the SLA is not registered the call is silently ignored.
   * When the duration exceeds the threshold all registered violation callbacks
   * are invoked synchronously.
   *
   * @param slaName    - The SLA to record against.
   * @param durationMs - Observed duration in milliseconds.
   * @returns The recorded {@link SlaEvent}, or `null` when the SLA is unknown.
   */
  recordEvent(slaName: string, durationMs: number): SlaEvent | null {
    const sla = this._slas.get(slaName);
    if (!sla) return null;

    const violated = durationMs > sla.thresholdMs;
    const event: SlaEvent = {
      slaName,
      durationMs,
      recordedAt: Date.now(),
      violated,
    };

    this._events.get(slaName)!.push(event);

    if (violated) {
      for (const cb of this._callbacks) {
        cb(event);
      }
    }

    return event;
  }

  // ---------------------------------------------------------------------------
  // Querying
  // ---------------------------------------------------------------------------

  /**
   * Return all violation events, optionally filtered to a single SLA.
   *
   * @param slaName - When provided, only violations for this SLA are returned.
   * @returns Array of violating {@link SlaEvent}s ordered by `recordedAt` ascending.
   */
  getViolations(slaName?: string): SlaEvent[] {
    if (slaName !== undefined) {
      return (this._events.get(slaName) ?? []).filter((e) => e.violated);
    }

    const all: SlaEvent[] = [];
    for (const events of this._events.values()) {
      all.push(...events.filter((e) => e.violated));
    }
    return all.sort((a, b) => a.recordedAt - b.recordedAt);
  }

  /**
   * Return all recorded events for an SLA, including compliant ones.
   *
   * @param slaName - The SLA to query.
   * @returns All recorded {@link SlaEvent}s, or `[]` for an unknown SLA.
   */
  getEvents(slaName: string): SlaEvent[] {
    return [...(this._events.get(slaName) ?? [])];
  }

  /**
   * Compute and return a full SLA report covering all registered SLAs.
   *
   * @returns A {@link SlaReport} snapshot.
   */
  getSlaReport(): SlaReport {
    const metrics: SlaMetrics[] = [];
    let totalEvents = 0;
    let totalViolations = 0;

    for (const [name, sla] of this._slas) {
      const events = this._events.get(name) ?? [];
      const durations = events.map((e) => e.durationMs).sort((a, b) => a - b);
      const violations = events.filter((e) => e.violated).length;

      totalEvents += events.length;
      totalViolations += violations;

      const avgDurationMs =
        durations.length > 0
          ? durations.reduce((s, d) => s + d, 0) / durations.length
          : 0;

      const p95DurationMs =
        durations.length > 0
          ? durations[Math.min(durations.length - 1, Math.ceil(0.95 * durations.length) - 1)]!
          : 0;

      metrics.push({
        name,
        thresholdMs: sla.thresholdMs,
        totalEvents: events.length,
        violations,
        complianceRate:
          events.length > 0 ? (events.length - violations) / events.length : 1,
        minDurationMs: durations[0] ?? 0,
        maxDurationMs: durations[durations.length - 1] ?? 0,
        avgDurationMs,
        p95DurationMs,
      });
    }

    return {
      metrics,
      totalViolations,
      overallComplianceRate:
        totalEvents > 0 ? (totalEvents - totalViolations) / totalEvents : 1,
      generatedAt: Date.now(),
    };
  }

  /**
   * Remove all recorded events while keeping SLA definitions intact.
   */
  clearEvents(): void {
    for (const name of this._events.keys()) {
      this._events.set(name, []);
    }
  }

  /**
   * Remove a registered SLA and all its recorded events.
   *
   * @param name - The SLA name to remove.
   */
  deregisterSla(name: string): void {
    this._slas.delete(name);
    this._events.delete(name);
  }

  // ---------------------------------------------------------------------------
  // Event handling
  // ---------------------------------------------------------------------------

  /**
   * Register a callback to be invoked on every SLA violation.
   *
   * Returns an `unsubscribe` function.
   *
   * @param callback - Invoked synchronously with the violating {@link SlaEvent}.
   * @returns A function that removes this callback.
   */
  onViolation(callback: ViolationCallback): () => void {
    this._callbacks.push(callback);
    return () => {
      const idx = this._callbacks.indexOf(callback);
      if (idx !== -1) this._callbacks.splice(idx, 1);
    };
  }
}
