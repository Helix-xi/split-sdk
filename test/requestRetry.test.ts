import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RequestTimeoutError,
  MaxRetriesExceededError,
  calculateBackoffDelay,
  isRetryableError,
  executeWithTimeoutAndRetry,
  RequestRetryManager,
} from "../src/requestRetry.js";

describe("calculateBackoffDelay", () => {
  it("computes deterministic exponential backoff when jitter is false", () => {
    const opts = { baseDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 2000, jitter: false };
    expect(calculateBackoffDelay(1, opts)).toBe(100);
    expect(calculateBackoffDelay(2, opts)).toBe(200);
    expect(calculateBackoffDelay(3, opts)).toBe(400);
    expect(calculateBackoffDelay(4, opts)).toBe(800);
    expect(calculateBackoffDelay(5, opts)).toBe(1600);
    expect(calculateBackoffDelay(6, opts)).toBe(2000); // capped at maxDelayMs
  });

  it("applies proportional jitter within bounds", () => {
    const opts = { baseDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 10_000, jitter: 0.1 };
    for (let i = 0; i < 20; i++) {
      const delay = calculateBackoffDelay(1, opts);
      // with 0.1 jitter on 1000ms: expected in [900, 1100]
      expect(delay).toBeGreaterThanOrEqual(900);
      expect(delay).toBeLessThanOrEqual(1100);
    }
  });

  it("applies full jitter between 0 and raw delay", () => {
    const opts = { baseDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 10_000, jitter: true };
    for (let i = 0; i < 20; i++) {
      const delay = calculateBackoffDelay(1, opts);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1000);
    }
  });
});

describe("isRetryableError", () => {
  it("identifies RequestTimeoutError as retryable", () => {
    expect(isRetryableError(new RequestTimeoutError(5000))).toBe(true);
  });

  it("identifies transient HTTP status codes as retryable", () => {
    expect(isRetryableError({ status: 503 })).toBe(true);
    expect(isRetryableError({ statusCode: 502 })).toBe(true);
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError({ status: 504 })).toBe(true);
  });

  it("identifies client errors as non-retryable", () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 401 })).toBe(false);
    expect(isRetryableError({ status: 403 })).toBe(false);
    expect(isRetryableError({ status: 404 })).toBe(false);
    expect(isRetryableError({ status: 422 })).toBe(false);
  });

  it("inspects error message for transient keywords", () => {
    expect(isRetryableError(new Error("fetch failed: ECONNRESET"))).toBe(true);
    expect(isRetryableError(new Error("Connection reset by peer"))).toBe(true);
    expect(isRetryableError(new Error("ETIMEDOUT: connect timed out"))).toBe(true);
    expect(isRetryableError(new Error("Validation failed for input"))).toBe(false);
    expect(isRetryableError(new Error("Resource not found"))).toBe(false);
  });
});

describe("executeWithTimeoutAndRetry", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("returns value immediately when operation succeeds on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await executeWithTimeoutAndRetry(fn, {
      defaultTimeoutMs: 1000,
      maxRetries: 2,
    });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries after transient failure and returns when subsequent attempt succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error 503"))
      .mockResolvedValueOnce("recovered");

    const onRetry = vi.fn();
    const result = await executeWithTimeoutAndRetry(fn, {
      defaultTimeoutMs: 1000,
      baseDelayMs: 10,
      maxDelayMs: 50,
      jitter: false,
      onRetry,
    });

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), 10);
  });

  it("enforces retry limits and throws MaxRetriesExceededError", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("503 Service Unavailable"));
    const onRetry = vi.fn();

    await expect(
      executeWithTimeoutAndRetry(fn, {
        defaultTimeoutMs: 1000,
        maxRetries: 2,
        baseDelayMs: 5,
        jitter: false,
        onRetry,
      }),
    ).rejects.toThrow(MaxRetriesExceededError);

    expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("aborts and retries when operation exceeds timeout", async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(async (signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("operation aborted"));
          });
        });
      }
      return "done after timeout";
    });

    const onTimeout = vi.fn();
    const result = await executeWithTimeoutAndRetry(fn, {
      defaultTimeoutMs: 50,
      baseDelayMs: 10,
      maxRetries: 2,
      jitter: false,
      onTimeout,
    });

    expect(result).toBe("done after timeout");
    expect(callCount).toBe(2);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not retry when error is not retryable", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Validation error: invalid address"));

    await expect(
      executeWithTimeoutAndRetry(fn, {
        defaultTimeoutMs: 1000,
        maxRetries: 3,
        baseDelayMs: 10,
      }),
    ).rejects.toThrow("Validation error");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honors custom retryIf predicate", async () => {
    const customErr = new Error("custom fatal error");
    const fn = vi.fn().mockRejectedValue(customErr);
    const retryIf = vi.fn().mockReturnValue(false);

    await expect(
      executeWithTimeoutAndRetry(fn, {
        defaultTimeoutMs: 1000,
        maxRetries: 3,
        retryIf,
      }),
    ).rejects.toThrow(customErr);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(retryIf).toHaveBeenCalledWith(customErr, 1);
  });
});

describe("RequestRetryManager", () => {
  it("resolves default and per-method timeouts", () => {
    const manager = new RequestRetryManager({
      defaultTimeoutMs: 5000,
      methodTimeouts: {
        getLeaderboard: 30000,
        fastPing: 1000,
      },
    });

    expect(manager.getTimeout("getLeaderboard")).toBe(30000);
    expect(manager.getTimeout("fastPing")).toBe(1000);
    expect(manager.getTimeout("getInvoice")).toBe(5000);
  });

  it("executes operations with per-method overrides", async () => {
    const manager = new RequestRetryManager({
      defaultTimeoutMs: 500,
      baseDelayMs: 5,
      maxRetries: 1,
      jitter: false,
    });

    const fn = vi.fn().mockResolvedValue(123);
    const result = await manager.execute(fn, "myMethod");
    expect(result).toBe(123);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
