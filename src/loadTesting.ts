/**
 * Comprehensive SDK performance and load testing suite.
 *
 * Provides concurrency control, pacing/rate limiting, latency percentile analysis,
 * event emission, and comparative benchmarking for StellarSplit SDK operations.
 */

export interface LoadTestOptions {
  /** Optional descriptive name for the load test scenario. */
  name?: string;
  /** Number of concurrent virtual workers executing tasks (default: 1). */
  concurrency?: number;
  /** Total number of iterations to execute across all workers (optional if durationMs is provided). */
  iterations?: number;
  /** Maximum duration in milliseconds to run the load test (optional if iterations is provided). */
  durationMs?: number;
  /** Ramp-up period in milliseconds to gradually scale concurrency (default: 0). */
  rampUpMs?: number;
  /** Target requests/operations per second to pace execution (optional). */
  targetRps?: number;
  /** Per-iteration timeout in milliseconds (optional). */
  timeoutMs?: number;
}

export interface LoadTestContext {
  /** 0-based worker index. */
  workerId: number;
  /** 0-based overall iteration index. */
  iteration: number;
  /** Timestamp when load test started. */
  startedAt: number;
}

export interface LoadTestIterationResult<T = unknown> {
  iteration: number;
  workerId: number;
  durationMs: number;
  success: boolean;
  value?: T;
  error?: Error;
}

export interface LatencyStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  p90: number;
  p95: number;
  p99: number;
  stdDev: number;
}

export interface LoadTestReport {
  name: string;
  totalIterations: number;
  successCount: number;
  failureCount: number;
  errorRate: number;
  durationMs: number;
  throughputRps: number;
  concurrency: number;
  latency: LatencyStats;
  errorBreakdown: Record<string, number>;
}

export type LoadTestEventMap<T = unknown> = {
  start: (options: LoadTestOptions) => void;
  progress: (completed: number, total: number, currentRps: number) => void;
  iterationStart: (context: LoadTestContext) => void;
  iterationEnd: (result: LoadTestIterationResult<T>) => void;
  error: (error: Error, context: LoadTestContext) => void;
  complete: (report: LoadTestReport) => void;
};

export type LoadTestEventType = keyof LoadTestEventMap;

/**
 * Calculates statistical metrics and percentiles from an array of numeric durations.
 */
export function computeLatencyStats(durationsMs: number[]): LatencyStats {
  if (durationsMs.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      stdDev: 0,
    };
  }

  const sorted = [...durationsMs].sort((a, b) => a - b);
  const n = sorted.length;
  const min = sorted[0]!;
  const max = sorted[n - 1]!;
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const mean = sum / n;

  const getPercentile = (p: number): number => {
    const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
    return sorted[idx]!;
  };

  const variance =
    sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  return {
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    mean: Number(mean.toFixed(2)),
    median: Number(getPercentile(50).toFixed(2)),
    p90: Number(getPercentile(90).toFixed(2)),
    p95: Number(getPercentile(95).toFixed(2)),
    p99: Number(getPercentile(99).toFixed(2)),
    stdDev: Number(stdDev.toFixed(2)),
  };
}

/**
 * High-performance load testing engine with event dispatch and percentile reporting.
 */
export class LoadTester {
  private readonly listeners: {
    [K in LoadTestEventType]?: Array<LoadTestEventMap[K]>;
  } = {};

  /** Register an event listener. */
  on<K extends LoadTestEventType>(event: K, listener: LoadTestEventMap[K]): this {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event]!.push(listener);
    return this;
  }

  /** Remove an event listener. */
  off<K extends LoadTestEventType>(event: K, listener: LoadTestEventMap[K]): this {
    const arr = this.listeners[event];
    if (arr) {
      this.listeners[event] = arr.filter((fn) => fn !== listener) as any;
    }
    return this;
  }

  /** Emit an event to all registered listeners. */
  private emit<K extends LoadTestEventType>(
    event: K,
    ...args: Parameters<LoadTestEventMap[K]>
  ): void {
    const arr = this.listeners[event];
    if (arr) {
      for (const listener of arr) {
        try {
          (listener as any)(...args);
        } catch {
          // Prevent listener errors from aborting the load test
        }
      }
    }
  }

  /**
   * Run a load testing scenario.
   *
   * @param options - Load test execution options
   * @param task    - Asynchronous workload to execute per iteration
   */
  async run<T>(
    options: LoadTestOptions,
    task: (context: LoadTestContext) => Promise<T>
  ): Promise<LoadTestReport> {
    const name = options.name ?? "SDK Load Test";
    const concurrency = Math.max(1, options.concurrency ?? 1);
    const targetIterations = options.iterations ?? (options.durationMs ? Infinity : 100);
    const durationMs = options.durationMs ?? Infinity;
    const rampUpMs = options.rampUpMs ?? 0;
    const timeoutMs = options.timeoutMs;
    const minIntervalMs = options.targetRps ? 1000 / options.targetRps : 0;

    this.emit("start", options);

    const startTime = performance.now();
    const durationsMs: number[] = [];
    let successCount = 0;
    let failureCount = 0;
    const errorBreakdown: Record<string, number> = {};

    let currentIteration = 0;
    let stopRequested = false;

    const executeIteration = async (
      workerId: number,
      iterIndex: number
    ): Promise<void> => {
      const context: LoadTestContext = {
        workerId,
        iteration: iterIndex,
        startedAt: startTime,
      };

      this.emit("iterationStart", context);
      const iterStart = performance.now();

      let success = false;
      let value: T | undefined;
      let error: Error | undefined;

      try {
        if (timeoutMs) {
          let timer: NodeJS.Timeout;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Iteration timed out after ${timeoutMs}ms`)),
              timeoutMs
            );
          });
          value = await Promise.race([task(context), timeoutPromise]);
          clearTimeout(timer!);
        } else {
          value = await task(context);
        }
        success = true;
        successCount++;
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
        failureCount++;
        const errMsg = error.message;
        errorBreakdown[errMsg] = (errorBreakdown[errMsg] ?? 0) + 1;
        this.emit("error", error, context);
      }

      const iterDuration = performance.now() - iterStart;
      durationsMs.push(iterDuration);

      this.emit("iterationEnd", {
        iteration: iterIndex,
        workerId,
        durationMs: iterDuration,
        success,
        value,
        error,
      });
    };

    // Worker loop
    const runWorker = async (workerId: number): Promise<void> => {
      // Handle ramp up delay for this worker
      if (rampUpMs > 0 && concurrency > 1) {
        const workerRampDelay = (workerId / concurrency) * rampUpMs;
        await new Promise((r) => setTimeout(r, workerRampDelay));
      }

      while (!stopRequested) {
        const iterIndex = currentIteration++;
        if (iterIndex >= targetIterations) {
          break;
        }

        const elapsed = performance.now() - startTime;
        if (elapsed >= durationMs) {
          stopRequested = true;
          break;
        }

        const paceStart = performance.now();
        await executeIteration(workerId, iterIndex);

        if (minIntervalMs > 0) {
          const paceElapsed = performance.now() - paceStart;
          const sleepMs = minIntervalMs - paceElapsed;
          if (sleepMs > 0) {
            await new Promise((r) => setTimeout(r, sleepMs));
          }
        }
      }
    };

    // Run workers concurrently
    const workers = Array.from({ length: concurrency }, (_, id) => runWorker(id));
    await Promise.all(workers);

    const totalDurationMs = performance.now() - startTime;
    const totalIterations = successCount + failureCount;
    const errorRate = totalIterations === 0 ? 0 : failureCount / totalIterations;
    const throughputRps =
      totalDurationMs === 0 ? 0 : Number(((totalIterations / totalDurationMs) * 1000).toFixed(2));

    const latency = computeLatencyStats(durationsMs);

    const report: LoadTestReport = {
      name,
      totalIterations,
      successCount,
      failureCount,
      errorRate: Number(errorRate.toFixed(4)),
      durationMs: Number(totalDurationMs.toFixed(2)),
      throughputRps,
      concurrency,
      latency,
      errorBreakdown,
    };

    this.emit("complete", report);
    return report;
  }
}

/**
 * Format a human-readable load test report table.
 */
export function formatLoadTestReport(report: LoadTestReport): string {
  return [
    `════════════════════════════════════════════════════════════════`,
    `  ${report.name}`,
    `════════════════════════════════════════════════════════════════`,
    `Total Operations: ${report.totalIterations} (${report.successCount} passed, ${report.failureCount} failed)`,
    `Error Rate:       ${(report.errorRate * 100).toFixed(2)}%`,
    `Duration:         ${report.durationMs}ms`,
    `Throughput:       ${report.throughputRps} ops/sec`,
    `Concurrency:      ${report.concurrency}`,
    `Latency (ms):`,
    `  min:    ${report.latency.min} ms`,
    `  median: ${report.latency.median} ms`,
    `  mean:   ${report.latency.mean} ms`,
    `  p90:    ${report.latency.p90} ms`,
    `  p95:    ${report.latency.p95} ms`,
    `  p99:    ${report.latency.p99} ms`,
    `  max:    ${report.latency.max} ms`,
    `  stdDev: ${report.latency.stdDev} ms`,
    `════════════════════════════════════════════════════════════════`,
  ].join("\n");
}
