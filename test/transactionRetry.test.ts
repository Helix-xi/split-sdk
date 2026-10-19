import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { withRetry } from "../src/retry.js";
import { executeWithRetry, isRetryable } from "../src/retryPolicy.js";
import type { RetryOptions } from "../src/retryPolicy.js";
import { StellarSplitClient } from "../src/client.js";
import {
  InvoiceNotFoundError,
  ValidationError,
  WalletNotConnectedError,
  RpcError,
} from "../src/errors.js";

const validContractId = StrKey.encodeContract(Keypair.random().rawPublicKey());
const validNetworkPassphrase = "Test SDF Network ; September 2015";
const randomAddress = () => Keypair.random().publicKey();

describe("Transaction Retry Logic (#1039)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Timeout Failure Scenarios
  // =========================================================================
  describe("Timeout Handling", () => {
    it("retries on operation timeout and succeeds once recovered", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("timed out waiting for response"))
        .mockResolvedValueOnce({ txHash: "tx-recovered" });

      const promise = withRetry(fn, 3, 50);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ txHash: "tx-recovered" });
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("retries on AbortError representing request timeout", async () => {
      const abortErr = new Error("The operation was aborted");
      abortErr.name = "AbortError";

      const fn = vi
        .fn()
        .mockRejectedValueOnce(abortErr)
        .mockResolvedValueOnce({ txHash: "tx-after-abort" });

      const promise = executeWithRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
      });

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ txHash: "tx-after-abort" });
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("enforces timeout and marks error as retryExhausted when all timeout retries fail", async () => {
      const timeoutErr = new Error("network timeout");
      const fn = vi.fn().mockRejectedValue(timeoutErr);

      let caught: any;
      const promise = executeWithRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
      }).catch((e) => {
        caught = e;
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(fn).toHaveBeenCalledTimes(3);
      expect(caught).toBeDefined();
      expect(caught.retryExhausted).toBe(true);
      expect(caught.message).toContain("network timeout");
    });
  });

  // =========================================================================
  // 2. Network Error Scenarios
  // =========================================================================
  describe("Network Errors", () => {
    it.each([
      ["ECONNRESET", new Error("read ECONNRESET")],
      ["ECONNREFUSED", new Error("connect ECONNREFUSED 127.0.0.1:8000")],
      ["failed to fetch", new Error("TypeError: failed to fetch")],
      ["503 service unavailable", new RpcError("Service Unavailable", 503, "https://rpc.stellar.org")],
      ["502 bad gateway", new Error("HTTP 502 Bad Gateway")],
      ["504 gateway timeout", new Error("HTTP 504 Gateway Timeout")],
    ])("retries transient network error: %s", async (_label, error) => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ txHash: "tx-success" });

      const promise = executeWithRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 50,
        maxDelayMs: 500,
      });

      await vi.runAllTimersAsync();
      const res = await promise;

      expect(res).toEqual({ txHash: "tx-success" });
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["ValidationError", new ValidationError("Invalid amount parameter")],
      ["InvoiceNotFoundError", new InvoiceNotFoundError("999")],
      ["WalletNotConnectedError", new WalletNotConnectedError()],
      ["HTTP 404", new RpcError("Contract not found", 404, "https://rpc.stellar.org")],
    ])("does NOT retry non-transient error: %s", async (_label, error) => {
      const fn = vi.fn().mockRejectedValue(error);

      await expect(
        executeWithRetry(fn, { maxAttempts: 4, baseDelayMs: 50, maxDelayMs: 500 })
      ).rejects.toThrow();

      // Immediately fails on first attempt without retrying
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // 3. Backoff Scenarios
  // =========================================================================
  describe("Exponential Backoff", () => {
    it("computes exponential backoff correctly: delay = baseDelayMs * 2^(attempt - 1)", async () => {
      const delays: number[] = [];
      const origSetTimeout = globalThis.setTimeout;

      vi.spyOn(globalThis, "setTimeout").mockImplementation(
        (cb: any, ms: number, ...args: any[]) => {
          if (ms > 0) delays.push(ms);
          return origSetTimeout(cb, 0, ...args);
        }
      );

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("503"))
        .mockRejectedValueOnce(new Error("503"))
        .mockRejectedValueOnce(new Error("503"))
        .mockResolvedValueOnce({ txHash: "done" });

      const promise = withRetry(fn, 4, 100);
      await vi.runAllTimersAsync();
      await promise;

      expect(delays).toHaveLength(3);
      // Attempt 1 -> 2: 100 * 2^0 = 100ms
      expect(delays[0]).toBe(100);
      // Attempt 2 -> 3: 100 * 2^1 = 200ms
      expect(delays[1]).toBe(200);
      // Attempt 3 -> 4: 100 * 2^2 = 400ms
      expect(delays[2]).toBe(400);
    });

    it("respects maxDelayMs cap so backoff never exceeds ceiling", async () => {
      const delays: number[] = [];
      const origSetTimeout = globalThis.setTimeout;

      vi.spyOn(globalThis, "setTimeout").mockImplementation(
        (cb: any, ms: number, ...args: any[]) => {
          if (ms > 0) delays.push(ms);
          return origSetTimeout(cb, 0, ...args);
        }
      );

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("network timeout"))
        .mockRejectedValueOnce(new Error("network timeout"))
        .mockResolvedValueOnce({ txHash: "done" });

      const promise = executeWithRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 2000,
        maxDelayMs: 1500, // cap is lower than baseDelay * 2^0
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(delays.length).toBe(2);
      expect(delays[0]).toBeLessThanOrEqual(1500);
      expect(delays[1]).toBeLessThanOrEqual(1500);
    });
  });

  // =========================================================================
  // 4. Max Retries Scenarios
  // =========================================================================
  describe("Max Retries Limits", () => {
    it("respects maxAttempts limit and does not exceed configured ceiling", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("connection reset"));

      let caught: any;
      const promise = withRetry(fn, 5, 20).catch((e) => {
        caught = e;
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(fn).toHaveBeenCalledTimes(5);
      expect(caught).toBeDefined();
      expect(caught.message).toContain("connection reset");
    });

    it("invokes onRetry hook with attempt index, error, and delay for each retry", async () => {
      const hookCalls: Array<{ attempt: number; error: Error; delayMs: number }> = [];

      const err = new Error("network timeout");
      const fn = vi
        .fn()
        .mockRejectedValueOnce(err)
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ txHash: "ok" });

      const promise = executeWithRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        onRetry: (attempt, error, delayMs) => {
          hookCalls.push({ attempt, error: error as Error, delayMs });
        },
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(hookCalls).toHaveLength(2);
      expect(hookCalls[0].attempt).toBe(1);
      expect(hookCalls[0].error).toBe(err);
      expect(hookCalls[0].delayMs).toBeGreaterThanOrEqual(100);

      expect(hookCalls[1].attempt).toBe(2);
      expect(hookCalls[1].error).toBe(err);
      expect(hookCalls[1].delayMs).toBeGreaterThanOrEqual(200);
    });

    it("integrates with StellarSplitClient.pay retry configuration", async () => {
      const retryAttempts: number[] = [];

      const client = new StellarSplitClient({
        rpcUrl: "http://localhost:8000",
        networkPassphrase: validNetworkPassphrase,
        contractId: validContractId,
        retry: {
          maxAttempts: 3,
          baseDelayMs: 50,
          maxDelayMs: 200,
          onRetry: (attempt) => retryAttempts.push(attempt),
        },
      });

      let callCount = 0;
      vi.spyOn(client as any, "_submitTx").mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          throw new RpcError("503 Service Unavailable", 503, "http://localhost:8000");
        }
        return {
          txHash: "client-retry-tx",
          returnValue: { value: () => 100n },
        };
      });

      const promise = client.pay({
        invoiceId: "1",
        amount: 100n,
        payer: randomAddress(),
      });

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.txHash).toBe("client-retry-tx");
      expect(callCount).toBe(3);
      expect(retryAttempts).toEqual([1, 2]);
    });
  });
});
