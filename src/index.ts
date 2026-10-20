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
