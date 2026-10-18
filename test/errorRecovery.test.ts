/**
 * Tests for issue #1068 — Error recovery strategies
 *
 * Verifies exhaustive strategy mapping, plan composition (strategy +
 * suggestion), and the automatic retry executor.
 */
import { describe, it, expect, vi } from "vitest";
import {
  RECOVERY_STRATEGY_TABLE,
  getRecoveryStrategy,
  getRecoveryPlan,
  executeWithRecovery,
} from "../src/errorRecovery.js";
import {
  SdkError,
  SdkErrorCode,
  StellarSplitError,
  InvoiceNotFoundError,
} from "../src/errors.js";
import { getSuggestion } from "../src/errorSuggestions.js";

describe("RECOVERY_STRATEGY_TABLE (#1068)", () => {
  it("has an entry for every SdkErrorCode", () => {
    for (const code of Object.values(SdkErrorCode)) {
      expect(RECOVERY_STRATEGY_TABLE[code], `missing strategy for ${code}`).toBeDefined();
      expect(RECOVERY_STRATEGY_TABLE[code].description.length).toBeGreaterThan(10);
    }
  });

  it("marks retryable strategies with backoff parameters", () => {
    for (const [code, strategy] of Object.entries(RECOVERY_STRATEGY_TABLE)) {
      if (strategy.retryable) {
        expect(strategy.maxAttempts, `${code} missing maxAttempts`).toBeGreaterThan(1);
        expect(strategy.backoffMs, `${code} missing backoffMs`).toBeGreaterThan(0);
      }
    }
  });

  it("maps transient network codes to retry/backoff actions", () => {
    for (const code of [
      SdkErrorCode.NETWORK_TIMEOUT,
      SdkErrorCode.RATE_LIMITED,
      SdkErrorCode.RPC_FAILED,
    ]) {
      const strategy = RECOVERY_STRATEGY_TABLE[code];
      expect(strategy.retryable).toBe(true);
      expect(["retry", "retry_with_backoff", "use_fallback"]).toContain(strategy.action);
    }
  });

  it("maps input/state codes to non-retryable actions", () => {
    expect(RECOVERY_STRATEGY_TABLE[SdkErrorCode.INVALID_CONTRACT_ADDRESS].action).toBe(
      "correct_input",
    );
    expect(RECOVERY_STRATEGY_TABLE[SdkErrorCode.SEQUENCE_MISMATCH].action).toBe(
      "refresh_and_retry",
    );
    expect(RECOVERY_STRATEGY_TABLE[SdkErrorCode.SEQUENCE_MISMATCH].retryable).toBe(false);
    expect(RECOVERY_STRATEGY_TABLE[SdkErrorCode.CONTRACT_REJECTED].action).toBe("abort");
    expect(RECOVERY_STRATEGY_TABLE[SdkErrorCode.INVOICE_FROZEN].action).toBe(
      "wait_for_resolution",
    );
  });
});

describe("getRecoveryStrategy (#1068)", () => {
  it("resolves an SdkErrorCode enum value", () => {
    expect(getRecoveryStrategy(SdkErrorCode.RATE_LIMITED)).toBe(
      RECOVERY_STRATEGY_TABLE[SdkErrorCode.RATE_LIMITED],
    );
  });

  it("resolves a code string case-insensitively", () => {
    expect(getRecoveryStrategy("network_timeout")).toBe(
      RECOVERY_STRATEGY_TABLE[SdkErrorCode.NETWORK_TIMEOUT],
    );
  });

  it("resolves an SdkError instance via its code", () => {
    const err = new SdkError("limited", SdkErrorCode.RATE_LIMITED);
    expect(getRecoveryStrategy(err)).toBe(RECOVERY_STRATEGY_TABLE[SdkErrorCode.RATE_LIMITED]);
  });

  it("resolves other StellarSplitError instances via their code", () => {
    const err = new InvoiceNotFoundError("inv-1");
    expect(getRecoveryStrategy(err)).toBe(
      RECOVERY_STRATEGY_TABLE[SdkErrorCode.INVOICE_NOT_FOUND],
    );
  });

  it("falls back to a conservative strategy for unknown inputs", () => {
    const strategy = getRecoveryStrategy(new Error("boom"));
    expect(strategy.retryable).toBe(true);
    expect(strategy.action).toBe("retry_with_backoff");
    expect(getRecoveryStrategy("not_a_code").retryable).toBe(true);
  });

  it("returns the same object identity as the table entry", () => {
    const err = new SdkError("x", SdkErrorCode.SEQUENCE_MISMATCH);
    expect(getRecoveryStrategy(err)).toBe(RECOVERY_STRATEGY_TABLE[SdkErrorCode.SEQUENCE_MISMATCH]);
  });
});

describe("getRecoveryPlan (#1068)", () => {
  it("combines the mapped strategy with a suggestion for an SdkError", () => {
    const err = new SdkError("account missing", SdkErrorCode.ACCOUNT_NOT_FOUND);
    const plan = getRecoveryPlan(err);

    expect(plan.code).toBe(SdkErrorCode.ACCOUNT_NOT_FOUND);
    expect(plan.strategy).toBe(RECOVERY_STRATEGY_TABLE[SdkErrorCode.ACCOUNT_NOT_FOUND]);
    expect(plan.suggestion).toBe(getSuggestion(err));
    expect(plan.suggestion).toContain("account does not exist");
  });

  it("works for typed StellarSplitError subclasses too", () => {
    const plan = getRecoveryPlan(new InvoiceNotFoundError("inv-9"));
    expect(plan.code).toBe(SdkErrorCode.INVOICE_NOT_FOUND);
    expect(plan.strategy.action).toBe("correct_input");
    expect(plan.suggestion).toContain("does not exist on-chain");
  });

  it("returns code=null for unrecognized errors", () => {
    const plan = getRecoveryPlan(new Error("mystery"));
    expect(plan.code).toBeNull();
    expect(plan.strategy.retryable).toBe(true);
    expect(plan.suggestion.length).toBeGreaterThan(0);
  });

  it("accepts raw code strings", () => {
    const plan = getRecoveryPlan("rate_limited");
    expect(plan.code).toBe(SdkErrorCode.RATE_LIMITED);
    expect(plan.strategy.retryable).toBe(true);
  });
});

describe("executeWithRecovery (#1068)", () => {
  const noSleep = () => Promise.resolve();

  it("returns the first successful result without retrying", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    await expect(executeWithRecovery(op, { sleep: noSleep })).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable error code until it succeeds", async () => {
    const err = new SdkError("timed out", SdkErrorCode.NETWORK_TIMEOUT);
    const op = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue("recovered");

    const onRetry = vi.fn();
    const result = await executeWithRecovery(op, { sleep: noSleep, onRetry });

    expect(result).toBe("recovered");
    expect(op).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenLastCalledWith(2, RECOVERY_STRATEGY_TABLE[SdkErrorCode.NETWORK_TIMEOUT]);
  });

  it("throws immediately for non-retryable error codes", async () => {
    const err = new SdkError("bad sequence", SdkErrorCode.SEQUENCE_MISMATCH);
    const op = vi.fn().mockRejectedValue(err);

    await expect(executeWithRecovery(op, { sleep: noSleep })).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("stops after the strategy's maxAttempts and rethrows the last error", async () => {
    const err = new SdkError("limited", SdkErrorCode.RATE_LIMITED);
    const op = vi.fn().mockRejectedValue(err);
    const strategy = RECOVERY_STRATEGY_TABLE[SdkErrorCode.RATE_LIMITED];

    await expect(executeWithRecovery(op, { sleep: noSleep })).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(strategy.maxAttempts!);
  });

  it("uses exponential backoff derived from the strategy", async () => {
    const err = new SdkError("timed out", SdkErrorCode.NETWORK_TIMEOUT);
    const op = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("done");
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };

    // First call rejects, second resolves; only one backoff delay is applied.
    await executeWithRecovery(op, { sleep });
    const base = RECOVERY_STRATEGY_TABLE[SdkErrorCode.NETWORK_TIMEOUT].backoffMs!;
    expect(sleeps).toEqual([base]);
  });

  it("treats plain errors as retryable (generic strategy) with a bounded attempt count", async () => {
    const op = vi.fn().mockRejectedValue(new Error("mystery"));
    await expect(executeWithRecovery(op, { sleep: noSleep })).rejects.toThrow("mystery");
    expect(op).toHaveBeenCalledTimes(3); // generic maxAttempts
  });

  it("honors an explicit code option for plain errors", async () => {
    const op = vi.fn().mockRejectedValue(new Error("wallet closed"));
    await expect(
      executeWithRecovery(op, { sleep: noSleep, code: SdkErrorCode.UNAUTHORIZED }),
    ).rejects.toThrow("wallet closed");
    expect(op).toHaveBeenCalledTimes(1); // UNAUTHORIZED is not retryable
  });

  it("stops retrying when the abort signal is set", async () => {
    const err = new SdkError("timed out", SdkErrorCode.NETWORK_TIMEOUT);
    const op = vi.fn().mockRejectedValue(err);
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeWithRecovery(op, { sleep: noSleep, signal: controller.signal }),
    ).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
  });
});

