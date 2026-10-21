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

export interface HealthCheckRegistration {
  name: string;
  check: HealthCheckFn;
  /** Optional timeout in milliseconds for this check. */
  timeoutMs?: number;
  /** Whether a failing check should mark the whole report unhealthy. */
  critical?: boolean;
}

export interface HealthEndpointResponse {
  statusCode: number;
  body: HealthReport;
}

const DEFAULT_TIMEOUT_MS = 5000;

function nowIso(): string {
  return new Date().toISOString();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Health check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Framework for registering and running health checks.
 */
export class HealthCheckRegistry {
  private readonly checks = new Map<string, HealthCheckRegistration>();

  register(registration: HealthCheckRegistration): void {
    if (!registration.name) {
      throw new Error('Health check name is required');
    }
    this.checks.set(registration.name, registration);
  }

  unregister(name: string): boolean {
    return this.checks.delete(name);
  }

  has(name: string): boolean {
    return this.checks.has(name);
  }

  list(): string[] {
    return Array.from(this.checks.keys());
  }

  clear(): void {
    this.checks.clear();
  }

  private async runCheck(registration: HealthCheckRegistration): Promise<HealthCheckResult> {
    const start = Date.now();
    const timeoutMs = registration.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const result = await withTimeout(
        Promise.resolve(registration.check()),
        timeoutMs,
      );
      return {
        ...result,
        name: registration.name,
        durationMs: Date.now() - start,
        timestamp: result.timestamp ?? nowIso(),
      };
    } catch (error) {
      return {
        name: registration.name,
        status: 'unhealthy',
        message: error instanceof Error ? error.message : String(error),
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
    const registrations = Array.from(this.checks.values());
    const results = await Promise.all(registrations.map((r) => this.runCheck(r)));
    return {
      status: aggregateStatus(results, registrations),
      timestamp: nowIso(),
      durationMs: Date.now() - start,
      checks: results,
    };
  }
}

/**
 * Aggregate individual check results into an overall status.
 *
 * - Any critical check failing => unhealthy
 * - Any non-critical check failing or degraded => degraded
 * - Otherwise healthy
 */
export function aggregateStatus(
  results: HealthCheckResult[],
  registrations: HealthCheckRegistration[] = [],
): HealthStatus {
  const criticalNames = new Set(
    registrations.filter((r) => r.critical).map((r) => r.name),
  );
  let degraded = false;
  for (const result of results) {
    if (result.status === 'unhealthy') {
      if (criticalNames.size === 0 || criticalNames.has(result.name)) {
        return 'unhealthy';
      }
      degraded = true;
    } else if (result.status === 'degraded') {
      degraded = true;
    }
  }
  return degraded ? 'degraded' : 'healthy';
}

/**
 * Build a health check for an external service using a probe function.
 */
export function createServiceCheck(
  name: string,
  probe: () => Promise<boolean> | boolean,
  options: { timeoutMs?: number; critical?: boolean } = {},
): HealthCheckRegistration {
  return {
    name,
    timeoutMs: options.timeoutMs,
    critical: options.critical,
    check: async () => {
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
  options: { timeoutMs?: number; critical?: boolean } = {},
): HealthCheckRegistration {
  return {
    name: `dependency:${name}`,
    timeoutMs: options.timeoutMs,
    critical: options.critical ?? true,
    check: async () => {
      const start = Date.now();
      const ok = await verify();
      return {
        name: `dependency:${name}`,
        status: ok ? 'healthy' : 'unhealthy',
        message: ok ? undefined : `Dependency ${name} is not reachable`,
        durationMs: Date.now() - start,
        timestamp: nowIso(),
        details: { dependency: name },
      };
    },
  };
}

/**
 * Create a health endpoint handler that returns an aggregated report.
 */
export function createHealthEndpoint(
  registry: HealthCheckRegistry,
): () => Promise<HealthEndpointResponse> {
  return async () => {
    const report = await registry.runAll();
    const statusCode =
      report.status === 'healthy' ? 200 : report.status === 'degraded' ? 200 : 503;
    return { statusCode, body: report };
  };
}

/**
 * Simple health monitor that periodically runs checks and reports changes.
 */
export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStatus: HealthStatus | null = null;

  constructor(
    private readonly registry: HealthCheckRegistry,
    private readonly intervalMs: number = 30000,
    private readonly onReport?: (report: HealthReport) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      const report = await this.registry.runAll();
      if (report.status !== this.lastStatus) {
        this.lastStatus = report.status;
      }
      this.onReport?.(report);
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  getLastStatus(): HealthStatus | null {
    return this.lastStatus;
  }
}
