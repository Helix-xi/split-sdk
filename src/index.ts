/**
 * SDK health check system.
 *
 * Provides a small framework for registering health checks (service checks,
 * dependency checks, custom checks), executing them, aggregating their
 * results, and exposing the aggregated status through health endpoints.
 */

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheckResult {
  name: string;
  status: HealthStatus;
  message?: string;
  durationMs: number;
  timestamp: string;
  details?: Record<string, unknown>;
}

export interface HealthReport {
  status: HealthStatus;
  timestamp: string;
  durationMs: number;
  checks: HealthCheckResult[];
}

export type HealthCheckFn = () => Promise<HealthCheckResult> | HealthCheckResult;

export interface HealthCheck {
  name: string;
  critical: boolean;
  check: HealthCheckFn;
}

export interface HealthEndpointResponse {
  statusCode: number;
  body: HealthReport;
}

const STATUS_RANK: Record<HealthStatus, number> = {
  healthy: 0,
  degraded: 1,
  unhealthy: 2,
};

function worstStatus(a: HealthStatus, b: HealthStatus): HealthStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Framework for registering and running health checks.
 */
export class HealthCheckRegistry {
  private readonly checks = new Map<string, HealthCheck>();

  register(check: HealthCheck): this {
    if (!check.name) {
      throw new Error('Health check must have a name');
    }
    this.checks.set(check.name, check);
    return this;
  }

  unregister(name: string): boolean {
    return this.checks.delete(name);
  }

  has(name: string): boolean {
    return this.checks.has(name);
  }

  list(): HealthCheck[] {
    return Array.from(this.checks.values());
  }

  /**
   * Run a single check, capturing errors and timing.
   */
  async runCheck(check: HealthCheck): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const result = await check.check();
      return {
        ...result,
        name: check.name,
        durationMs: Date.now() - start,
        timestamp: result.timestamp ?? nowIso(),
      };
    } catch (err) {
      return {
        name: check.name,
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        timestamp: nowIso(),
      };
    }
  }

  /**
   * Run all registered checks and aggregate the results.
   */
  async runAll(): Promise<HealthReport> {
    const start = Date.now();
    const checks = this.list();
    const results = await Promise.all(checks.map((c) => this.runCheck(c)));

    let status: HealthStatus = 'healthy';
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const check = checks[i];
      // Non-critical checks can only degrade overall health, never fail it.
      if (!check.critical && result.status === 'unhealthy') {
        status = worstStatus(status, 'degraded');
      } else {
        status = worstStatus(status, result.status);
      }
    }

    return {
      status,
      timestamp: nowIso(),
      durationMs: Date.now() - start,
      checks: results,
    };
  }
}

/**
 * Build a health check for an external service reachable via a probe function.
 */
export function createServiceCheck(
  name: string,
  probe: () => Promise<boolean> | boolean,
  options: { critical?: boolean } = {},
): HealthCheck {
  return {
    name,
    critical: options.critical ?? true,
    async check(): Promise<HealthCheckResult> {
      const start = Date.now();
      const ok = await probe();
      return {
        name,
        status: ok ? 'healthy' : 'unhealthy',
        message: ok ? undefined : `Service ${name} is unavailable`,
        durationMs: Date.now() - start,
        timestamp: nowIso(),
      };
    },
  };
}

/**
 * Build a health check for a dependency (e.g. database, cache, queue).
 */
export function createDependencyCheck(
  name: string,
  verify: () => Promise<boolean> | boolean,
  options: { critical?: boolean } = {},
): HealthCheck {
  return {
    name: `dependency:${name}`,
    critical: options.critical ?? true,
    async check(): Promise<HealthCheckResult> {
      const start = Date.now();
      const ok = await verify();
      return {
        name: `dependency:${name}`,
        status: ok ? 'healthy' : 'unhealthy',
        message: ok ? undefined : `Dependency ${name} failed verification`,
        durationMs: Date.now() - start,
        timestamp: nowIso(),
      };
    },
  };
}

/**
 * Health endpoint handlers returning aggregated health status.
 */
export class HealthEndpoints {
  constructor(private readonly registry: HealthCheckRegistry) {}

  /** Liveness: process is up. */
  async liveness(): Promise<HealthEndpointResponse> {
    return {
      statusCode: 200,
      body: {
        status: 'healthy',
        timestamp: nowIso(),
        durationMs: 0,
        checks: [],
      },
    };
  }

  /** Readiness: all critical checks pass. */
  async readiness(): Promise<HealthEndpointResponse> {
    const report = await this.registry.runAll();
    const statusCode = report.status === 'unhealthy' ? 503 : 200;
    return { statusCode, body: report };
  }

  /** Full health report. */
  async health(): Promise<HealthEndpointResponse> {
    const report = await this.registry.runAll();
    const statusCode = report.status === 'unhealthy' ? 503 : 200;
    return { statusCode, body: report };
  }
}

/**
 * Periodic health monitoring that records the latest report and notifies
 * listeners on status changes.
 */
export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReport: HealthReport | null = null;
  private readonly listeners: Array<(report: HealthReport) => void> = [];

  constructor(
    private readonly registry: HealthCheckRegistry,
    private readonly intervalMs: number = 30_000,
  ) {}

  onReport(listener: (report: HealthReport) => void): this {
    this.listeners.push(listener);
    return this;
  }

  getLastReport(): HealthReport | null {
    return this.lastReport;
  }

  async runOnce(): Promise<HealthReport> {
    const report = await this.registry.runAll();
    const previous = this.lastReport;
    this.lastReport = report;
    if (!previous || previous.status !== report.status) {
      for (const listener of this.listeners) {
        listener(report);
      }
    }
    return report;
  }

  start(): this {
    if (this.timer) return this;
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    return this;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * SDK metrics and statistics collection.
 *
 * Provides counters, gauges, and histograms registered in a central registry,
 * plus export and analysis helpers for monitoring.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricSnapshot {
  name: string;
  type: MetricType;
  value: number | HistogramSummary;
  labels?: Record<string, string>;
}

export interface HistogramSummary {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  percentiles: Record<string, number>;
}

export interface MetricAnalysis {
  totalMetrics: number;
  byType: Record<MetricType, number>;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramSummary>;
}

/** Monotonically increasing counter. */
export class Counter {
  readonly type: MetricType = 'counter';
  private value = 0;

  constructor(readonly name: string, readonly labels?: Record<string, string>) {}

  inc(amount: number = 1): this {
    if (amount < 0) {
      throw new Error(`Counter ${this.name} cannot be decremented`);
    }
    this.value += amount;
    return this;
  }

  get(): number {
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}

/** Gauge that can be set, incremented, or decremented. */
export class Gauge {
  readonly type: MetricType = 'gauge';
  private value = 0;

  constructor(readonly name: string, readonly labels?: Record<string, string>) {}

  set(value: number): this {
    this.value = value;
    return this;
  }

  inc(amount: number = 1): this {
    this.value += amount;
    return this;
  }

  dec(amount: number = 1): this {
    this.value -= amount;
    return this;
  }

  get(): number {
    return this.value;
  }
}

/** Histogram with configurable buckets and summary statistics. */
export class Histogram {
  readonly type: MetricType = 'histogram';
  private readonly buckets: number[];
  private readonly counts: number[];
  private count = 0;
  private sum = 0;
  private min = Infinity;
  private max = -Infinity;
  private readonly samples: number[] = [];

  constructor(
    readonly name: string,
    buckets: number[] = [5, 10, 25, 50, 100, 250, 500, 1000],
    readonly labels?: Record<string, string>,
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.counts = new Array(this.buckets.length + 1).fill(0);
  }

  observe(value: number): this {
    this.count++;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    this.samples.push(value);
    let idx = this.buckets.length;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        idx = i;
        break;
      }
    }
    this.counts[idx]++;
    return this;
  }

  summary(percentiles: number[] = [50, 90, 95, 99]): HistogramSummary {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const pct: Record<string, number> = {};
    for (const p of percentiles) {
      if (sorted.length === 0) {
        pct[`p${p}`] = 0;
        continue;
      }
      const rank = Math.ceil((p / 100) * sorted.length) - 1;
      pct[`p${p}`] = sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
    }
    return {
      count: this.count,
      sum: this.sum,
      min: this.count === 0 ? 0 : this.min,
      max: this.count === 0 ? 0 : this.max,
      mean: this.count === 0 ? 0 : this.sum / this.count,
      percentiles: pct,
    };
  }

  bucketCounts(): number[] {
    return [...this.counts];
  }
}

/** Central registry for metrics. */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Counter | Gauge | Histogram>();

  private key(name: string, labels?: Record<string, string>): string {
    if (!labels) return name;
    const parts = Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k]}`);
    return parts.length ? `${name}{${parts.join(',')}}` : name;
  }

  counter(name: string, labels?: Record<string, string>): Counter {
    const key = this.key(name, labels);
    const existing = this.metrics.get(key);
    if (existing) {
      if (!(existing instanceof Counter)) {
        throw new Error(`Metric ${key} already registered with a different type`);
      }
      return existing;
    }
    const counter = new Counter(name, labels);
    this.metrics.set(key, counter);
    return counter;
  }

  gauge(name: string, labels?: Record<string, string>): Gauge {
    const key = this.key(name, labels);
    const existing = this.metrics.get(key);
    if (existing) {
      if (!(existing instanceof Gauge)) {
        throw new Error(`Metric ${key} already registered with a different type`);
      }
      return existing;
    }
    const gauge = new Gauge(name, labels);
    this.metrics.set(key, gauge);
    return gauge;
  }

  histogram(
    name: string,
    buckets?: number[],
    labels?: Record<string, string>,
  ): Histogram {
    const key = this.key(name, labels);
    const existing = this.metrics.get(key);
    if (existing) {
      if (!(existing instanceof Histogram)) {
        throw new Error(`Metric ${key} already registered with a different type`);
      }
      return existing;
    }
    const histogram = new Histogram(name, buckets, labels);
    this.metrics.set(key, histogram);
    return histogram;
  }

  remove(name: string, labels?: Record<string, string>): boolean {
    return this.metrics.delete(this.key(name, labels));
  }

  clear(): void {
    this.metrics.clear();
  }

  /** Snapshot all metrics for export. */
  snapshot(): MetricSnapshot[] {
    const out: MetricSnapshot[] = [];
    for (const metric of this.metrics.values()) {
      if (metric instanceof Histogram) {
        out.push({
          name: metric.name,
          type: metric.type,
          value: metric.summary(),
          labels: metric.labels,
        });
      } else {
        out.push({
          name: metric.name,
          type: metric.type,
          value: metric.get(),
          labels: metric.labels,
        });
      }
    }
    return out;
  }

  /** Export metrics as a JSON string. */
  exportJson(): string {
    return JSON.stringify(this.snapshot());
  }

  /** Export metrics in Prometheus text exposition format. */
  exportPrometheus(): string {
    const lines: string[] = [];
    for (const metric of this.metrics.values()) {
      const labelStr = metric.labels
        ? `{${Object.keys(metric.labels)
            .sort()
            .map((k) => `${k}="${metric.labels![k]}"`)
            .join(',')}}`
        : '';
      if (metric instanceof Histogram) {
        const summary = metric.summary();
        lines.push(`# TYPE ${metric.name} histogram`);
        lines.push(`${metric.name}_count${labelStr} ${summary.count}`);
        lines.push(`${metric.name}_sum${labelStr} ${summary.sum}`);
        lines.push(`${metric.name}_min${labelStr} ${summary.min}`);
        lines.push(`${metric.name}_max${labelStr} ${summary.max}`);
      } else {
        lines.push(`# TYPE ${metric.name} ${metric.type}`);
        lines.push(`${metric.name}${labelStr} ${metric.get()}`);
      }
    }
    return lines.join('\n');
  }

  /** Analyze collected metrics into a structured summary. */
  analyze(): MetricAnalysis {
    const analysis: MetricAnalysis = {
      totalMetrics: 0,
      byType: { counter: 0, gauge: 0, histogram: 0 },
      counters: {},
      gauges: {},
      histograms: {},
    };
    for (const metric of this.metrics.values()) {
      analysis.totalMetrics++;
      analysis.byType[metric.type]++;
      if (metric instanceof Counter) {
        analysis.counters[metric.name] = metric.get();
      } else if (metric instanceof Gauge) {
        analysis.gauges[metric.name] = metric.get();
      } else if (metric instanceof Histogram) {
        analysis.histograms[metric.name] = metric.summary();
      }
    }
    return analysis;
  }
}
