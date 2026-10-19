/**
 * Optional analytics tracking for SDK usage metrics with privacy controls and reporting.
 *
 * Designed to provide privacy-preserving usage metrics for SDK consumers.
 * Strictly opt-in (enabled: false by default).
 */

import { createHash } from "crypto";

export type PrivacyLevel = "strict" | "anonymized" | "standard";

export interface AnalyticsPrivacyConfig {
  /**
   * Overall privacy level:
   * - "strict": completely drops all addresses, metadata, and custom properties.
   * - "anonymized": hashes/masks Stellar public keys and scrubs sensitive data (default).
   * - "standard": allows public keys but scrubs secret keys and credentials.
   */
  level?: PrivacyLevel;
  /** Whether to anonymize Stellar public keys (G...). Default: true. */
  anonymizeAddresses?: boolean;
  /** Whether to strip secret keys (S...) and credentials. Default: true. */
  stripSecrets?: boolean;
  /** Whether to strip PII (email, IP, names). Default: true. */
  allowPII?: boolean;
  /** Respect browser / environment Do Not Track headers or flags. Default: true. */
  respectDoNotTrack?: boolean;
}

export interface AnalyticsEventInput {
  name: string;
  category?: string;
  properties?: Record<string, unknown>;
  timestamp?: number;
}

export interface AnalyticsEvent {
  name: string;
  category: string;
  properties: Record<string, unknown>;
  timestamp: number;
}

export interface MethodMetric {
  calls: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
}

export interface AnalyticsReport {
  generatedAt: number;
  periodMs: number;
  privacyLevel: PrivacyLevel;
  totalEvents: number;
  totalMethodCalls: number;
  totalErrors: number;
  overallErrorRate: number;
  methods: Record<string, MethodMetric>;
  eventsByCategory: Record<string, number>;
  metrics: Record<string, number>;
  events: AnalyticsEvent[];
}

export interface AnalyticsTrackerOptions {
  /** Strictly opt-in: defaults to false. */
  enabled?: boolean;
  /** Privacy controls configuration. */
  privacy?: AnalyticsPrivacyConfig;
  /** Remote reporting endpoint URL for flush(). */
  endpoint?: string;
  /** Auto-flush interval in milliseconds (0 or undefined to disable auto-flush). */
  flushIntervalMs?: number;
  /** Maximum number of raw events retained in the collector buffer. Default: 1000. */
  maxQueueSize?: number;
  /** Custom reporter callback invoked on flush or report generation. */
  onReport?: (report: AnalyticsReport) => void;
  /** Optional custom fetch implementation for network reporting. */
  fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Privacy Controller
// ---------------------------------------------------------------------------

const STELLAR_SECRET_PATTERN = /\bS[A-Z0-9]{55}\b/g;
const STELLAR_PUBLIC_PATTERN = /\bG[A-Z0-9]{55}\b/g;
const PII_KEYS = new Set([
  "ip",
  "ipaddress",
  "ip_address",
  "email",
  "emailaddress",
  "email_address",
  "phone",
  "phonenumber",
  "ssn",
  "password",
  "secret",
  "privatekey",
  "private_key",
  "authorization",
  "token",
]);

export class PrivacyController {
  private readonly config: Required<AnalyticsPrivacyConfig>;

  constructor(config?: AnalyticsPrivacyConfig) {
    this.config = {
      level: config?.level ?? "anonymized",
      anonymizeAddresses: config?.anonymizeAddresses ?? true,
      stripSecrets: config?.stripSecrets ?? true,
      allowPII: config?.allowPII ?? false,
      respectDoNotTrack: config?.respectDoNotTrack ?? true,
    };
  }

  get level(): PrivacyLevel {
    return this.config.level;
  }

  isDoNotTrackEnabled(): boolean {
    if (!this.config.respectDoNotTrack) return false;
    if (typeof navigator !== "undefined" && "doNotTrack" in navigator) {
      return (navigator as { doNotTrack?: string }).doNotTrack === "1";
    }
    if (typeof process !== "undefined" && process.env?.DO_NOT_TRACK === "1") {
      return true;
    }
    return false;
  }

  anonymizeAddress(address: string): string {
    if (this.config.level === "strict") {
      return "[REDACTED_ADDRESS]";
    }
    if (!this.config.anonymizeAddresses && this.config.level === "standard") {
      return address;
    }
    // Deterministic pseudonym: first 4, last 4 chars + 8-char sha256 hash
    const hash = createHash("sha256").update(address).digest("hex").slice(0, 8);
    return `${address.slice(0, 4)}...${hash}...${address.slice(-4)}`;
  }

  sanitizeString(val: string): string {
    let out = val;
    if (this.config.stripSecrets) {
      out = out.replace(STELLAR_SECRET_PATTERN, "[REDACTED_SECRET]");
    }
    if (this.config.anonymizeAddresses || this.config.level !== "standard") {
      out = out.replace(STELLAR_PUBLIC_PATTERN, (match) => this.anonymizeAddress(match));
    }
    return out;
  }

  sanitizeValue(key: string, value: unknown): unknown {
    if (value === null || value === undefined) return value;

    const lowerKey = key.toLowerCase();
    if (!this.config.allowPII && PII_KEYS.has(lowerKey)) {
      return "[REDACTED_PII]";
    }

    if (typeof value === "string") {
      return this.sanitizeString(value);
    }

    if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (Array.isArray(value)) {
      if (this.config.level === "strict") return [];
      return value.map((item, idx) => this.sanitizeValue(`${key}_${idx}`, item));
    }

    if (typeof value === "object") {
      if (this.config.level === "strict") return {};
      return this.sanitizeProperties(value as Record<string, unknown>);
    }

    return String(value);
  }

  sanitizeProperties(properties?: Record<string, unknown>): Record<string, unknown> {
    if (!properties) return {};
    if (this.config.level === "strict") return {};

    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(properties)) {
      sanitized[key] = this.sanitizeValue(key, val);
    }
    return sanitized;
  }
}

// ---------------------------------------------------------------------------
// Analytics Collector
// ---------------------------------------------------------------------------

interface MethodRecord {
  count: number;
  errors: number;
  durations: number[];
}

export class AnalyticsCollector {
  private readonly maxQueueSize: number;
  private readonly events: AnalyticsEvent[] = [];
  private readonly methods = new Map<string, MethodRecord>();
  private readonly metrics = new Map<string, number>();
  private readonly categoryCounts = new Map<string, number>();
  private startTime: number = Date.now();

  constructor(maxQueueSize = 1000) {
    this.maxQueueSize = maxQueueSize;
  }

  recordEvent(event: AnalyticsEvent): void {
    if (this.events.length >= this.maxQueueSize) {
      this.events.shift(); // Evict oldest event when queue is full
    }
    this.events.push(event);

    const cat = event.category || "general";
    this.categoryCounts.set(cat, (this.categoryCounts.get(cat) ?? 0) + 1);
  }

  recordMethod(method: string, durationMs: number, success: boolean): void {
    let rec = this.methods.get(method);
    if (!rec) {
      rec = { count: 0, errors: 0, durations: [] };
      this.methods.set(method, rec);
    }
    rec.count += 1;
    if (!success) {
      rec.errors += 1;
    }
    rec.durations.push(durationMs);
    // Keep max 500 duration samples per method to avoid unbounded memory
    if (rec.durations.length > 500) {
      rec.durations.shift();
    }
  }

  recordMetric(name: string, value: number): void {
    this.metrics.set(name, (this.metrics.get(name) ?? 0) + value);
  }

  getEvents(): AnalyticsEvent[] {
    return [...this.events];
  }

  getMetrics(): Record<string, number> {
    return Object.fromEntries(this.metrics.entries());
  }

  private calculatePercentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0;
  }

  generateReport(privacyLevel: PrivacyLevel = "anonymized"): AnalyticsReport {
    const now = Date.now();
    const methodsReport: Record<string, MethodMetric> = {};

    let totalMethodCalls = 0;
    let totalErrors = 0;

    for (const [method, rec] of this.methods.entries()) {
      const sorted = [...rec.durations].sort((a, b) => a - b);
      const sum = sorted.reduce((acc, d) => acc + d, 0);
      const avg = sorted.length > 0 ? Number((sum / sorted.length).toFixed(2)) : 0;
      const min = sorted.length > 0 ? (sorted[0] ?? 0) : 0;
      const max = sorted.length > 0 ? (sorted[sorted.length - 1] ?? 0) : 0;
      const errorRate = rec.count > 0 ? Number((rec.errors / rec.count).toFixed(4)) : 0;

      totalMethodCalls += rec.count;
      totalErrors += rec.errors;

      methodsReport[method] = {
        calls: rec.count,
        errors: rec.errors,
        errorRate,
        avgDurationMs: avg,
        minDurationMs: min,
        maxDurationMs: max,
        p50DurationMs: this.calculatePercentile(sorted, 50),
        p95DurationMs: this.calculatePercentile(sorted, 95),
        p99DurationMs: this.calculatePercentile(sorted, 99),
      };
    }

    const overallErrorRate =
      totalMethodCalls > 0 ? Number((totalErrors / totalMethodCalls).toFixed(4)) : 0;

    return {
      generatedAt: now,
      periodMs: now - this.startTime,
      privacyLevel,
      totalEvents: this.events.length,
      totalMethodCalls,
      totalErrors,
      overallErrorRate,
      methods: methodsReport,
      eventsByCategory: Object.fromEntries(this.categoryCounts.entries()),
      metrics: Object.fromEntries(this.metrics.entries()),
      events: [...this.events],
    };
  }

  reset(): void {
    this.events.length = 0;
    this.methods.clear();
    this.metrics.clear();
    this.categoryCounts.clear();
    this.startTime = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Main Analytics Tracker API
// ---------------------------------------------------------------------------

export class AnalyticsTracker {
  private _enabled: boolean;
  private readonly privacy: PrivacyController;
  private readonly collector: AnalyticsCollector;
  private readonly endpoint?: string;
  private readonly onReport?: (report: AnalyticsReport) => void;
  private readonly fetchFn: typeof fetch;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AnalyticsTrackerOptions = {}) {
    this.privacy = new PrivacyController(options.privacy);
    // Respect Do Not Track
    if (this.privacy.isDoNotTrackEnabled()) {
      this._enabled = false;
    } else {
      this._enabled = options.enabled ?? false;
    }

    this.collector = new AnalyticsCollector(options.maxQueueSize ?? 1000);
    this.endpoint = options.endpoint;
    this.onReport = options.onReport;
    this.fetchFn = options.fetchFn ?? (typeof fetch !== "undefined" ? fetch : (() => Promise.resolve({ ok: true })) as unknown as typeof fetch);

    if (this._enabled && options.flushIntervalMs && options.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => void this.flush(), options.flushIntervalMs);
      if (typeof this.flushTimer === "object" && this.flushTimer !== null && "unref" in this.flushTimer) {
        (this.flushTimer as NodeJS.Timeout).unref();
      }
    }
  }

  isEnabled(): boolean {
    return this._enabled && !this.privacy.isDoNotTrackEnabled();
  }

  optIn(): void {
    if (!this.privacy.isDoNotTrackEnabled()) {
      this._enabled = true;
    }
  }

  optOut(): void {
    this._enabled = false;
    this.collector.reset();
  }

  getPrivacyLevel(): PrivacyLevel {
    return this.privacy.level;
  }

  /**
   * Track an arbitrary SDK event with privacy scrubbing applied.
   */
  track(event: AnalyticsEventInput): void {
    if (!this.isEnabled()) return;

    const sanitizedProps = this.privacy.sanitizeProperties(event.properties);
    const sanitizedEvent: AnalyticsEvent = {
      name: this.privacy.sanitizeString(event.name),
      category: event.category || "general",
      properties: sanitizedProps,
      timestamp: event.timestamp ?? Date.now(),
    };

    this.collector.recordEvent(sanitizedEvent);
  }

  /**
   * Track method execution latency, success/failure status, and metadata.
   */
  trackMethod(
    method: string,
    durationMs: number,
    success: boolean,
    metadata?: Record<string, unknown>,
  ): void {
    if (!this.isEnabled()) return;

    this.collector.recordMethod(method, Math.max(0, durationMs), success);
    this.track({
      name: `method:${method}`,
      category: "method_call",
      properties: {
        method,
        durationMs,
        success,
        ...metadata,
      },
    });
  }

  /**
   * Track an error encountered during SDK operation.
   */
  trackError(error: Error | string, context?: Record<string, unknown>): void {
    if (!this.isEnabled()) return;

    const message = typeof error === "string" ? error : error.message;
    const name = typeof error === "string" ? "Error" : error.name;

    this.track({
      name: "error_occurred",
      category: "errors",
      properties: {
        errorName: name,
        errorMessage: message,
        ...context,
      },
    });
    this.collector.recordMetric("error_count", 1);
  }

  /**
   * Track a numerical metric counter or gauge.
   */
  trackMetric(name: string, value: number): void {
    if (!this.isEnabled()) return;
    this.collector.recordMetric(name, value);
  }

  /**
   * Generate a comprehensive analytics report of all metrics accumulated.
   */
  generateReport(): AnalyticsReport {
    const report = this.collector.generateReport(this.privacy.level);
    if (this.onReport) {
      try {
        this.onReport(report);
      } catch {
        // Non-blocking report callback
      }
    }
    return report;
  }

  /**
   * Dispatch report to configured remote endpoint, notify onReport, and reset counters.
   */
  async flush(): Promise<AnalyticsReport | null> {
    if (!this.isEnabled()) return null;

    const report = this.generateReport();
    this.collector.reset();

    if (this.endpoint) {
      try {
        await this.fetchFn(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(report),
        });
      } catch {
        // Analytics flush failure must never break consumer operations
      }
    }

    return report;
  }

  /**
   * Cleanup timer resources and reset collector.
   */
  destroy(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.collector.reset();
  }
}

/**
 * Convenience helper to wrap any client or service with automated analytics tracking.
 */
export function wrapClientWithAnalytics<T extends object>(
  client: T,
  tracker: AnalyticsTracker,
): T {
  if (!tracker.isEnabled()) {
    return client;
  }

  return new Proxy(client, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig === "function" && typeof prop === "string") {
        return function (this: unknown, ...args: unknown[]) {
          const start = Date.now();
          try {
            const result = (orig as (...a: unknown[]) => unknown).apply(this ?? target, args);
            if (result && typeof result === "object" && "then" in result && typeof (result as Promise<unknown>).then === "function") {
              return (result as Promise<unknown>)
                .then((res) => {
                  tracker.trackMethod(prop, Date.now() - start, true);
                  return res;
                })
                .catch((err) => {
                  tracker.trackMethod(prop, Date.now() - start, false, {
                    errorMessage: (err as Error)?.message,
                  });
                  throw err;
                });
            }
            tracker.trackMethod(prop, Date.now() - start, true);
            return result;
          } catch (err) {
            tracker.trackMethod(prop, Date.now() - start, false, {
              errorMessage: (err as Error)?.message,
            });
            throw err;
          }
        };
      }
      return orig;
    },
  });
}
