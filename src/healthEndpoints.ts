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
  details?: Record<string, unknown>;
  durationMs: number;
  timestamp: string;
}

export interface HealthCheck {
  name: string;
  /** Optional timeout in milliseconds for this individual check. */
  timeoutMs?: number;
  /** Whether a failure of this check should mark the whole system unhealthy. */
  critical?: boolean;
  run: () => Promise<HealthCheckResult> | HealthCheckResult;
}

export interface AggregatedHealth {
  status: HealthStatus;
  checks: HealthCheckResult[];
  timestamp: string;
  uptimeMs: number;
}

export interface HealthEndpointResponse {
  statusCode: number;
  body: AggregatedHealth;
}

const DEFAULT_TIMEOUT_MS = 5000;

function nowIso(): string {
  return new Date().toISOString();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Health check "${name}" timed out after ${timeoutMs}ms`));
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
 * Registry and executor for health checks.
 */
export class HealthCheckRegistry {
  private readonly checks = new Map<string, HealthCheck>();
  private readonly startedAt = Date.now();

  register(check: HealthCheck): this {
    if (!check || typeof check.name !== 'string' || check.name.length === 0) {
      throw new Error('Health check must have a non-empty name');
    }
    if (typeof check.run !== 'function') {
      throw new Error(`Health check "${check.name}" must provide a run function`);
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

  list(): string[] {
    return Array.from(this.checks.keys());
  }

  async runCheck(check: HealthCheck): Promise<HealthCheckResult> {
    const started = Date.now();
    const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const result = await withTimeout(
        Promise.resolve().then(() => check.run()),
        timeoutMs,
        check.name,
      );
      return {
        ...result,
        name: check.name,
        durationMs: Date.now() - started,
        timestamp: result.timestamp ?? nowIso(),
      };
    } catch (error) {
      return {
        name: check.name,
        status: 'unhealthy',
        message: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
        timestamp: nowIso(),
      };
    }
  }

  async runAll(): Promise<HealthCheckResult[]> {
    const checks = Array.from(this.checks.values());
    return Promise.all(checks.map((check) => this.runCheck(check)));
  }

  aggregate(results: HealthCheckResult[]): AggregatedHealth {
    let status: HealthStatus = 'healthy';
    for (const result of results) {
      if (result.status === 'unhealthy') {
        status = 'unhealthy';
        break;
      }
      if (result.status === 'degraded') {
        status = 'degraded';
      }
    }
    return {
      status,
      checks: results,
      timestamp: nowIso(),
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  async getHealth(): Promise<AggregatedHealth> {
    const results = await this.runAll();
    return this.aggregate(results);
  }
}

/**
 * Helper to build a passing check result.
 */
export function healthy(
  name: string,
  details?: Record<string, unknown>,
): HealthCheckResult {
  return { name, status: 'healthy', details, durationMs: 0, timestamp: nowIso() };
}

/**
 * Helper to build a degraded check result.
 */
export function degraded(
  name: string,
  message?: string,
  details?: Record<string, unknown>,
): HealthCheckResult {
  return { name, status: 'degraded', message, details, durationMs: 0, timestamp: nowIso() };
}

/**
 * Helper to build a failing check result.
 */
export function unhealthy(
  name: string,
  message?: string,
  details?: Record<string, unknown>,
): HealthCheckResult {
  return { name, status: 'unhealthy', message, details, durationMs: 0, timestamp: nowIso() };
}

/**
 * Create a service check that probes an external service via a supplied probe.
 */
export function createServiceCheck(
  name: string,
  probe: () => Promise<boolean> | boolean,
  options: { critical?: boolean; timeoutMs?: number } = {},
): HealthCheck {
  return {
    name,
    critical: options.critical ?? true,
    timeoutMs: options.timeoutMs,
    async run() {
      const ok = await probe();
      return ok
        ? healthy(name)
        : unhealthy(name, `Service "${name}" is not responding`);
    },
  };
}

/**
 * Create a dependency check that verifies a dependency is reachable.
 */
export function createDependencyCheck(
  name: string,
  verify: () => Promise<boolean> | boolean,
  options: { critical?: boolean; timeoutMs?: number } = {},
): HealthCheck {
  return {
    name,
    critical: options.critical ?? true,
    timeoutMs: options.timeoutMs,
    async run() {
      const ok = await verify();
      return ok
        ? healthy(name)
        : unhealthy(name, `Dependency "${name}" verification failed`);
    },
  };
}

/**
 * Build an HTTP-style health endpoint response from aggregated health.
 */
export function toEndpointResponse(health: AggregatedHealth): HealthEndpointResponse {
  const statusCode = health.status === 'unhealthy' ? 503 : 200;
  return { statusCode, body: health };
}

/**
 * Create a request handler suitable for wiring into an HTTP server.
 */
export function createHealthHandler(
  registry: HealthCheckRegistry,
): () => Promise<HealthEndpointResponse> {
  return async () => {
    const health = await registry.getHealth();
    return toEndpointResponse(health);
  };
}

/**
 * Create a liveness handler that reports process liveness without running checks.
 */
export function createLivenessHandler(
  registry: HealthCheckRegistry,
): () => HealthEndpointResponse {
  return () => ({
    statusCode: 200,
    body: {
      status: 'healthy',
      checks: [],
      timestamp: nowIso(),
      uptimeMs: (registry as unknown as { startedAt?: number }).startedAt
        ? Date.now() - ((registry as unknown as { startedAt: number }).startedAt)
        : 0,
    },
  });
}

/**
 * Periodically run health checks and invoke a callback with the aggregated result.
 * Returns a stop function to cancel monitoring.
 */
export function startHealthMonitoring(
  registry: HealthCheckRegistry,
  intervalMs: number,
  onResult: (health: AggregatedHealth) => void,
): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const health = await registry.getHealth();
      if (!stopped) onResult(health);
    } catch (error) {
      if (!stopped) {
        onResult({
          status: 'unhealthy',
          checks: [],
          timestamp: nowIso(),
          uptimeMs: 0,
        });
      }
    }
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
