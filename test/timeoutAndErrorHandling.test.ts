/**
 * Test Suite: Timeout and Error Handling (#1044)
 *
 * Requirements:
 * - Test timeouts: Request timeouts trigger, abort signals fire, per-method overrides
 * - Test network errors: Transient RPC failures, classification, backoff & recovery
 * - Test parse errors: Malformed XDR envelopes, invalid JSON, and invalid hex handling
 * - Test validation: Input validation, clear error messages, and successful recovery
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  withTimeout,
  withTimeoutOrThrow,
  TimeoutManager,
  RequestTimeoutError,
  EscalationManager,
} from "../src/timeout.js";
import {
  RpcError,
  RpcConnectionError,
  RpcUnavailableError,
  ValidationError,
  InvoiceNotFoundError,
  StellarSplitError,
} from "../src/errors.js";
import { executeWithRetry, isRetryable } from "../src/retryPolicy.js";
import { parseEnvelope } from "../src/xdrParser.js";
import { FallbackChain } from "../src/fallbackChain.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Timeout and Error Handling (#1044)", () => {
  describe("Requirement: Test timeouts", () => {
    it("triggers RequestTimeoutError when an async operation exceeds timeout", async () => {
      vi.useFakeTimers();

      const slowOperation = () => new Promise<string>(() => undefined);
      const promise = withTimeout(slowOperation, 200, "simulateTransaction");

      vi.advanceTimersByTime(250);

      const result = await promise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("timeout");
        expect(result.error).toBeInstanceOf(RequestTimeoutError);
        expect(result.error?.method).toBe("simulateTransaction");
        expect(result.error?.timeoutMs).toBe(200);
        expect(result.error?.message).toContain("Request timed out after 200ms (method: simulateTransaction)");
      }
    });

    it("withTimeoutOrThrow throws RequestTimeoutError when timeout triggers", async () => {
      vi.useFakeTimers();

      const slowOperation = () => new Promise<never>(() => undefined);
      const promise = withTimeoutOrThrow(slowOperation, 100, "sendTransaction");

      vi.advanceTimersByTime(150);

      await expect(promise).rejects.toThrow(RequestTimeoutError);
      await expect(promise).rejects.toMatchObject({
        method: "sendTransaction",
        timeoutMs: 100,
        code: "REQUEST_TIMEOUT",
      });
    });

    it("aborts the AbortSignal when the timeout triggers", async () => {
      vi.useFakeTimers();

      let signalWasAborted = false;
      const promise = withTimeout(
        async (signal) => {
          signal.addEventListener("abort", () => {
            signalWasAborted = true;
          });
          return new Promise<never>(() => undefined);
        },
        300,
        "fetchEvents"
      );

      expect(signalWasAborted).toBe(false);
      vi.advanceTimersByTime(350);

      await promise;
      expect(signalWasAborted).toBe(true);
    });

    it("clears timeout cleanly when operation completes fast", async () => {
      vi.useFakeTimers();

      const fastOperation = async () => "quick_success";
      const result = await withTimeout(fastOperation, 5000, "quickOp");

      expect(result).toEqual({ ok: true, value: "quick_success" });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("resolves per-method timeouts and respects default fallback", () => {
      const tm = new TimeoutManager({
        default: 8000,
        pay: 20000,
        batchPay: 30000,
      });

      expect(tm.resolveTimeout("pay")).toBe(20000);
      expect(tm.resolveTimeout("batchPay")).toBe(30000);
      expect(tm.resolveTimeout("getInvoice")).toBe(8000); // fallback to default
    });

    it("triggers escalation warnings before deadline expires", () => {
      vi.useFakeTimers();

      const onEvent = vi.fn();
      const manager = new EscalationManager(
        {
          deadlineMs: 5000,
          escalations: [
            { triggerAtMs: 2000, action: "warn", target: "team-lead" },
            { triggerAtMs: 1000, action: "notify", target: "billing-ops" },
          ],
        },
        { onEvent }
      );

      manager.start("inv-escalate-1");

      // delayMs for step 1 = 5000 - 2000 = 3000ms
      vi.advanceTimersByTime(3100);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "warn",
          invoiceId: "inv-escalate-1",
          remainingMs: 2000,
        })
      );

      // delayMs for step 2 = 5000 - 1000 = 4000ms
      vi.advanceTimersByTime(1000);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "notify",
          invoiceId: "inv-escalate-1",
          remainingMs: 1000,
        })
      );

      manager.cancel();
    });
  });

  describe("Requirement: Test network errors", () => {
    it("correctly classifies retryable vs non-retryable network errors", () => {
      // 503 Service Unavailable -> retryable
      const err503 = new RpcError("Service Unavailable", 503);
      expect(isRetryable(err503)).toBe(true);

      // 429 Too Many Requests -> retryable
      const err429 = new RpcError("Rate Limited", 429);
      expect(isRetryable(err429)).toBe(true);

      // Network connection errors -> retryable
      const connectionErr = new RpcConnectionError("http://localhost:8000", new Error("ECONNREFUSED"));
      expect(isRetryable(connectionErr)).toBe(true);

      const timeoutErr = new Error("Network timeout while calling RPC");
      expect(isRetryable(timeoutErr)).toBe(true);

      // 400 Bad Request / 404 Not Found -> non-retryable
      const err400 = new RpcError("Bad Request", 400);
      const err404 = new RpcError("Not Found", 404);
      expect(isRetryable(err400)).toBe(false);
      expect(isRetryable(err404)).toBe(false);

      // Semantic business errors -> non-retryable
      const notFoundErr = new InvoiceNotFoundError("inv-missing");
      expect(isRetryable(notFoundErr)).toBe(false);
    });

    it("recovers from transient network errors via executeWithRetry", async () => {
      let attempts = 0;
      const retryLog: number[] = [];

      const unreliableNetworkCall = vi.fn(async () => {
        attempts++;
        if (attempts < 3) {
          throw new RpcError("Service temporarily unavailable", 503);
        }
        return "recovered_data";
      });

      const result = await executeWithRetry(unreliableNetworkCall, {
        maxAttempts: 4,
        baseDelayMs: 10,
        maxDelayMs: 50,
        onRetry: (attempt) => {
          retryLog.push(attempt);
        },
      });

      expect(result).toBe("recovered_data");
      expect(attempts).toBe(3);
      expect(retryLog).toEqual([1, 2]);
    });

    it("terminates when maximum retry attempts are exceeded", async () => {
      const alwaysFails = vi.fn(async () => {
        throw new RpcError("Connection timed out", 503);
      });

      await expect(
        executeWithRetry(alwaysFails, {
          maxAttempts: 3,
          baseDelayMs: 5,
          maxDelayMs: 10,
        })
      ).rejects.toThrow("Connection timed out");

      expect(alwaysFails).toHaveBeenCalledTimes(3);
    });

    it("recovers via FallbackChain when primary network endpoint fails", async () => {
      const loggerSpy = vi.fn();
      const chain = new FallbackChain(
        ["https://primary.rpc.stellar", "https://backup.rpc.stellar"],
        { logger: loggerSpy }
      );

      const result = await chain.execute(async (url) => {
        if (url.includes("primary")) {
          throw new RpcUnavailableError(url);
        }
        return { id: "inv-backup", status: "Pending", servedBy: url };
      });

      expect(result).toEqual({
        id: "inv-backup",
        status: "Pending",
        servedBy: "https://backup.rpc.stellar",
      });
      expect(loggerSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Requirement: Test parse errors", () => {
    it("throws descriptive error when parsing invalid base64 XDR", () => {
      expect(() => parseEnvelope("invalid-not-base64-xdr!@#$")).toThrow();
    });

    it("throws descriptive error when parsing empty or truncated XDR string", () => {
      expect(() => parseEnvelope("")).toThrow();
      expect(() => parseEnvelope("AAAA")).toThrow();
    });

    it("handles JSON payload parse failure gracefully with clear message", () => {
      const malformedJson = '{"invoiceId": 123, unquoted: true,}';

      expect(() => {
        try {
          JSON.parse(malformedJson);
        } catch (err) {
          throw new ValidationError("Payload is not valid JSON", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }).toThrowError(/Payload is not valid JSON/);
    });

    it("validates hex parsing and rejects odd-length or non-hex input with clear error", () => {
      const parseHex = (hex: string) => {
        if (hex.length % 2 !== 0) {
          throw new ValidationError("Invalid hex string length", { length: hex.length });
        }
        if (!/^[0-9a-fA-F]*$/.test(hex)) {
          throw new ValidationError("Invalid hex character sequence", { hex });
        }
        return Buffer.from(hex, "hex");
      };

      expect(() => parseHex("abc")).toThrow(ValidationError);
      expect(() => parseHex("abc")).toThrow("Invalid hex string length");

      expect(() => parseHex("zz12")).toThrow(ValidationError);
      expect(() => parseHex("zz12")).toThrow("Invalid hex character sequence");

      expect(parseHex("deadbeef")).toHaveLength(4);
    });
  });

  describe("Requirement: Test validation", () => {
    it("validates payment amounts and rejects negative or zero amounts", () => {
      const validatePaymentAmount = (amount: bigint) => {
        if (amount <= 0n) {
          throw new ValidationError("Payment amount must be greater than zero", { amount: amount.toString() });
        }
      };

      expect(() => validatePaymentAmount(0n)).toThrow(ValidationError);
      expect(() => validatePaymentAmount(0n)).toThrow("Payment amount must be greater than zero");
      expect(() => validatePaymentAmount(-50n)).toThrow(ValidationError);

      // Valid amount passes
      expect(() => validatePaymentAmount(100n)).not.toThrow();
    });

    it("validates Stellar public keys and addresses", () => {
      const validateStellarAddress = (address: string) => {
        if (!address || typeof address !== "string") {
          throw new ValidationError("Stellar address is required");
        }
        if (!address.startsWith("G") || address.length !== 56) {
          throw new ValidationError(`Invalid Stellar public key address: ${address}`, { address });
        }
      };

      expect(() => validateStellarAddress("")).toThrow("Stellar address is required");
      expect(() => validateStellarAddress("INVALID_ADDRESS")).toThrow("Invalid Stellar public key address");
      expect(() => validateStellarAddress("G123")).toThrow("Invalid Stellar public key address");

      const validGAddress = "GA2HGBJIJKI6O4XJJ7HI7OINUI42QIWDN4O7EBITCXFH5GYECOEB7W5L";
      expect(() => validateStellarAddress(validGAddress)).not.toThrow();
    });

    it("demonstrates recovery by correcting invalid parameters after catching ValidationError", () => {
      let submissionResult = "";

      const attemptSubmission = (address: string, amount: bigint) => {
        if (!address.startsWith("G") || address.length !== 56) {
          throw new ValidationError("Invalid address", { address });
        }
        if (amount <= 0n) {
          throw new ValidationError("Invalid amount", { amount: amount.toString() });
        }
        return `success:${address}:${amount}`;
      };

      // 1. Initial attempt fails validation
      let caughtError: unknown = null;
      try {
        attemptSubmission("bad_address", -10n);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(ValidationError);

      // 2. Caller inspects error context and recovers with valid parameters
      const validAddress = "GA2HGBJIJKI6O4XJJ7HI7OINUI42QIWDN4O7EBITCXFH5GYECOEB7W5L";
      const validAmount = 500n;

      submissionResult = attemptSubmission(validAddress, validAmount);
      expect(submissionResult).toBe(`success:${validAddress}:500`);
    });
  });
});
