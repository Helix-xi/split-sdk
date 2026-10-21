import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PaymentOrchestrator,
  type PaymentParams,
  type PaymentResult,
  type QueuedPayment,
  type PaymentOrchestratorOptions,
  type PaymentExecutor,
} from "../src/paymentOrchestrator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayment(overrides?: Partial<PaymentParams>): PaymentParams {
  return {
    invoiceId: 1n,
    payer: "GABC123XYZ",
    amount: 100_000_000n,
    ...overrides,
  };
}

function successExecutor(txHash = "txhash-abc"): PaymentExecutor {
  return vi.fn().mockResolvedValue({ txHash });
}

function failExecutor(error: Error | string = new Error("rpc error")): PaymentExecutor {
  const err = typeof error === "string" ? new Error(error) : error;
  return vi.fn().mockRejectedValue(err);
}

// ---------------------------------------------------------------------------
// queue()
// ---------------------------------------------------------------------------

describe("PaymentOrchestrator — queue()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("returns a stable payment ID", () => {
    const orch = new PaymentOrchestrator(successExecutor());
    const id = orch.queue(makePayment());
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("respects a caller-supplied id", () => {
    const orch = new PaymentOrchestrator(successExecutor());
    const id = orch.queue(makePayment({ id: "my-custom-id" }));
    expect(id).toBe("my-custom-id");
  });

  it("each call produces a distinct auto-generated ID", () => {
    const orch = new PaymentOrchestrator(successExecutor());
    const ids = [
      orch.queue(makePayment()),
      orch.queue(makePayment()),
      orch.queue(makePayment()),
    ];
    const unique = new Set(ids);
    expect(unique.size).toBe(3);
  });

  it("increments queued counter in getStatus()", () => {
    const orch = new PaymentOrchestrator(successExecutor());
    orch.queue(makePayment());
    orch.queue(makePayment());
    const status = orch.getStatus();
    expect(status.queued).toBe(2);
    expect(status.total).toBe(2);
  });

  it("emits payment:queued synchronously with the queued payment", () => {
    const orch = new PaymentOrchestrator(successExecutor());
    const events: QueuedPayment[] = [];
    orch.on("payment:queued", ({ payment }) => events.push(payment));

    orch.queue(makePayment({ id: "q1" }));
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("q1");
    expect(events[0].status).toBe("queued");
    expect(events[0].invoiceId).toBe(1n);
    expect(events[0].amount).toBe(100_000_000n);
  });

  it("queued payment has attempts = 0 initially", () => {
    const orch = new PaymentOrchestrator(successExecutor());
    const events: QueuedPayment[] = [];
    orch.on("payment:queued", ({ payment }) => events.push(payment));
    orch.queue(makePayment());
    expect(events[0].attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// process() — success path
// ---------------------------------------------------------------------------

describe("PaymentOrchestrator — process() success", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("calls the executor for each queued payment", async () => {
    const executor = successExecutor("txhash-1");
    const orch = new PaymentOrchestrator(executor);
    orch.queue(makePayment({ invoiceId: 1n }));
    orch.queue(makePayment({ invoiceId: 2n }));

    await orch.process();

    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("emits payment:processing before payment:completed", async () => {
    const orch = new PaymentOrchestrator(successExecutor("txhash-ok"));
    const order: string[] = [];
    orch.on("payment:processing", () => order.push("processing"));
    orch.on("payment:completed", () => order.push("completed"));

    orch.queue(makePayment());
    await orch.process();

    expect(order).toEqual(["processing", "completed"]);
  });

  it("completed event carries the txHash from the executor", async () => {
    const orch = new PaymentOrchestrator(successExecutor("TX-HASH-123"));
    const completed: string[] = [];
    orch.on("payment:completed", ({ txHash }) => completed.push(txHash));

    orch.queue(makePayment());
    await orch.process();

    expect(completed).toEqual(["TX-HASH-123"]);
  });

  it("moves payments to completed bucket", async () => {
    const orch = new PaymentOrchestrator(successExecutor());
    orch.queue(makePayment());
    orch.queue(makePayment());

    await orch.process();

    const status = orch.getStatus();
    expect(status.completed).toBe(2);
    expect(status.queued).toBe(0);
    expect(status.failed).toBe(0);
  });

  it("processes payments in queue order", async () => {
    const order: bigint[] = [];
    const executor: PaymentExecutor = vi.fn().mockImplementation(async (p) => {
      order.push(p.invoiceId);
      return { txHash: "tx" };
    });

    const orch = new PaymentOrchestrator(executor);
    orch.queue(makePayment({ invoiceId: 10n }));
    orch.queue(makePayment({ invoiceId: 20n }));
    orch.queue(makePayment({ invoiceId: 30n }));

    await orch.process();

    expect(order).toEqual([10n, 20n, 30n]);
  });

  it("getStatus returns processing=1 while a payment is in flight", async () => {
    let resolvePayment!: (r: PaymentResult) => void;
    const executor: PaymentExecutor = vi.fn().mockImplementation(
      () => new Promise<PaymentResult>((resolve) => { resolvePayment = resolve; }),
    );

    const orch = new PaymentOrchestrator(executor);
    orch.queue(makePayment());

    const processPromise = orch.process();

    // Yield once so the executor is called
    await Promise.resolve();

    const snap = orch.getStatus();
    expect(snap.processing).toBe(1);

    resolvePayment({ txHash: "tx" });
    await processPromise;

    expect(orch.getStatus().processing).toBe(0);
  });

  it("passes the full QueuedPayment to the executor", async () => {
    const received: QueuedPayment[] = [];
    const executor: PaymentExecutor = vi.fn().mockImplementation(async (p) => {
      received.push({ ...p });
      return { txHash: "tx" };
    });

    const orch = new PaymentOrchestrator(executor);
    orch.queue({ invoiceId: 42n, payer: "GPAYER", amount: 500n, id: "p-42" });

    await orch.process();

    expect(received[0].invoiceId).toBe(42n);
    expect(received[0].payer).toBe("GPAYER");
    expect(received[0].amount).toBe(500n);
    expect(received[0].id).toBe("p-42");
  });
});

// ---------------------------------------------------------------------------
// process() — retry logic
// ---------------------------------------------------------------------------

describe("PaymentOrchestrator — retry logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("retries up to maxRetries times then marks as failed", async () => {
    const executor = failExecutor(new Error("always fails"));
    const orch = new PaymentOrchestrator(executor, {
      maxRetries: 3,
      baseRetryDelayMs: 10,
    });

    orch.queue(makePayment());

    const processPromise = orch.process();
    // Fast-forward all timers to bypass backoff delays
    await vi.runAllTimersAsync();
    await processPromise;

    // 1 initial + 3 retries = 4 calls total
    expect(executor).toHaveBeenCalledTimes(4);

    const status = orch.getStatus();
    expect(status.failed).toBe(1);
    expect(status.completed).toBe(0);
  });

  it("succeeds on the second attempt after one failure", async () => {
    const executor: PaymentExecutor = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ txHash: "tx-recovered" });

    const orch = new PaymentOrchestrator(executor, { maxRetries: 3, baseRetryDelayMs: 10 });

    orch.queue(makePayment());

    const processPromise = orch.process();
    await vi.runAllTimersAsync();
    await processPromise;

    expect(executor).toHaveBeenCalledTimes(2);

    const status = orch.getStatus();
    expect(status.completed).toBe(1);
    expect(status.failed).toBe(0);
  });

  it("emits payment:failed with willRetry=true before eventual success", async () => {
    const executor: PaymentExecutor = vi
      .fn()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce({ txHash: "tx-ok" });

    const failEvents: Array<{ willRetry: boolean }> = [];
    const orch = new PaymentOrchestrator(executor, { maxRetries: 3, baseRetryDelayMs: 10 });

    orch.on("payment:failed", ({ willRetry }) => failEvents.push({ willRetry }));
    orch.queue(makePayment());

    const processPromise = orch.process();
    await vi.runAllTimersAsync();
    await processPromise;

    expect(failEvents).toHaveLength(1);
    expect(failEvents[0].willRetry).toBe(true);
  });

  it("emits payment:failed with willRetry=false on final attempt", async () => {
    const executor = failExecutor(new Error("permanent"));
    const failEvents: Array<{ willRetry: boolean }> = [];

    const orch = new PaymentOrchestrator(executor, { maxRetries: 2, baseRetryDelayMs: 10 });
    orch.on("payment:failed", ({ willRetry }) => failEvents.push({ willRetry }));

    orch.queue(makePayment());

    const processPromise = orch.process();
    await vi.runAllTimersAsync();
    await processPromise;

    // Last failure should have willRetry=false
    const lastEvent = failEvents[failEvents.length - 1];
    expect(lastEvent.willRetry).toBe(false);
  });

  it("records the error on the payment entry after failure", async () => {
    const err = new Error("boom");
    const executor = failExecutor(err);
    const payments: QueuedPayment[] = [];

    const orch = new PaymentOrchestrator(executor, { maxRetries: 1, baseRetryDelayMs: 10 });
    orch.on("payment:failed", ({ payment }) => payments.push({ ...payment }));

    orch.queue(makePayment());

    const processPromise = orch.process();
    await vi.runAllTimersAsync();
    await processPromise;

    const lastSnapshot = payments[payments.length - 1];
    expect(lastSnapshot.lastError?.message).toBe("boom");
  });

  it("wraps non-Error rejections into an Error object", async () => {
    const executor: PaymentExecutor = vi.fn().mockRejectedValue("string-error");
    const failures: Error[] = [];

    const orch = new PaymentOrchestrator(executor, { maxRetries: 0, baseRetryDelayMs: 10 });
    orch.on("payment:failed", ({ error }) => failures.push(error));

    orch.queue(makePayment());

    const processPromise = orch.process();
    await vi.runAllTimersAsync();
    await processPromise;

    expect(failures[0]).toBeInstanceOf(Error);
    expect(failures[0].message).toContain("string-error");
  });

  it("increments attempts on the payment entry with each try", async () => {
    const executor = failExecutor(new Error("always fails"));
    const attemptSnapshots: number[] = [];

    const orch = new PaymentOrchestrator(executor, { maxRetries: 2, baseRetryDelayMs: 10 });
    orch.on("payment:failed", ({ payment }) => attemptSnapshots.push(payment.attempts));

    orch.queue(makePayment());

    const processPromise = orch.process();
    await vi.runAllTimersAsync();
    await processPromise;

    // Attempts should be 1, 2, 3 across the three failures
    expect(attemptSnapshots).toEqual([1, 2, 3]);
  });

  it("uses maxRetries=3 by default", async () => {
    const executor = failExecutor(new Error("fail"));
    const orch = new PaymentOrchestrator(executor, { baseRetryDelayMs: 1 });

    orch.queue(makePayment());

    const processPromise = orch.process();
    await vi.runAllTimersAsync();
    await processPromise;

    // Default maxRetries=3 ⇒ 4 total calls
    expect(executor).toHaveBeenCalledTimes(4);
  });

  it("emits payment:processing once per attempt including retries", async () => {
    const executor: PaymentExecutor = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ txHash: "tx" });

    const processingCount = { count: 0 };
    const orch = new PaymentOrchestrator(executor, { maxRetries: 3, baseRetryDelayMs: 10 });
    orch.on("payment:processing", () => processingCount.count++);

    orch.queue(makePayment());

    const processPromise = orch.process();
    await vi.runAllTimersAsync();
    await processPromise;

    // 2 failures + 1 success = 3 processing events
    expect(processingCount.count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getStatus()
// ---------------------------------------------------------------------------

describe("PaymentOrchestrator — getStatus()", () => {
  it("starts with all-zero counters", () => {
    const orch = new PaymentOrchestrator(successExecutor());
    expect(orch.getStatus()).toEqual({
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      total: 0,
    });
  });

  it("total equals sum of all buckets", async () => {
    vi.useFakeTimers();

    const executor: PaymentExecutor = vi
      .fn()
      .mockResolvedValueOnce({ txHash: "t1" })
      .mockResolvedValueOnce({ txHash: "t2" })
      .mockRejectedValue(new Error("fail"));

    const orch = new PaymentOrchestrator(executor, { maxRetries: 0, baseRetryDelayMs: 1 });
    orch.queue(makePayment());
    orch.queue(makePayment());
    orch.queue(makePayment());

    const p = orch.process();
    await vi.runAllTimersAsync();
    await p;

    const s = orch.getStatus();
    expect(s.total).toBe(s.queued + s.processing + s.completed + s.failed);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// drain()
// ---------------------------------------------------------------------------

describe("PaymentOrchestrator — drain()", () => {
  it("removes all queued payments and returns them", () => {
    const orch = new PaymentOrchestrator(successExecutor());
    orch.queue(makePayment({ id: "a" }));
    orch.queue(makePayment({ id: "b" }));

    const drained = orch.drain();

    expect(drained).toHaveLength(2);
    expect(drained.map((p) => p.id)).toEqual(["a", "b"]);
    expect(orch.getStatus().queued).toBe(0);
  });

  it("returns empty array when queue is already empty", () => {
    const orch = new PaymentOrchestrator(successExecutor());
    const drained = orch.drain();
    expect(drained).toEqual([]);
  });

  it("process() after drain() is a no-op", async () => {
    const executor = successExecutor();
    const orch = new PaymentOrchestrator(executor);
    orch.queue(makePayment());

    orch.drain();
    await orch.process();

    expect(executor).not.toHaveBeenCalled();
    expect(orch.getStatus().completed).toBe(0);
  });

  it("payments added after drain() are unaffected", () => {
    const orch = new PaymentOrchestrator(successExecutor());
    orch.queue(makePayment({ id: "before" }));
    orch.drain();
    orch.queue(makePayment({ id: "after" }));

    expect(orch.getStatus().queued).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// on() / off()
// ---------------------------------------------------------------------------

describe("PaymentOrchestrator — on() / off()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("on() returns an unsubscribe function that stops further events", async () => {
    const orch = new PaymentOrchestrator(successExecutor("tx"));
    const received: string[] = [];

    const unsub = orch.on("payment:completed", ({ txHash }) => received.push(txHash));

    orch.queue(makePayment());
    await orch.process();

    expect(received).toHaveLength(1);

    unsub();

    orch.queue(makePayment());
    await orch.process();

    // Should still be 1 — no second event delivered
    expect(received).toHaveLength(1);
  });

  it("off() removes a specific handler", () => {
    const orch = new PaymentOrchestrator(successExecutor());
    const counts = { a: 0, b: 0 };

    const handlerA = () => { counts.a++; };
    const handlerB = () => { counts.b++; };

    orch.on("payment:queued", handlerA);
    orch.on("payment:queued", handlerB);

    orch.queue(makePayment());
    expect(counts.a).toBe(1);
    expect(counts.b).toBe(1);

    orch.off("payment:queued", handlerA);

    orch.queue(makePayment());
    expect(counts.a).toBe(1);  // not incremented
    expect(counts.b).toBe(2);  // still incremented
  });

  it("multiple listeners for the same event all fire", () => {
    const orch = new PaymentOrchestrator(successExecutor());
    const calls: number[] = [];

    orch.on("payment:queued", () => calls.push(1));
    orch.on("payment:queued", () => calls.push(2));
    orch.on("payment:queued", () => calls.push(3));

    orch.queue(makePayment());

    expect(calls).toHaveLength(3);
  });

  it("off() is a no-op for an unregistered handler", () => {
    const orch = new PaymentOrchestrator(successExecutor());
    expect(() => orch.off("payment:queued", () => {})).not.toThrow();
  });

  it("unsubscribe from the same unsub twice is safe", async () => {
    const orch = new PaymentOrchestrator(successExecutor());
    const unsub = orch.on("payment:completed", () => {});
    unsub();
    expect(() => unsub()).not.toThrow();

    orch.queue(makePayment());
    await orch.process();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("PaymentOrchestrator — edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("process() on empty queue is a no-op and resolves immediately", async () => {
    const executor = successExecutor();
    const orch = new PaymentOrchestrator(executor);
    await orch.process();
    expect(executor).not.toHaveBeenCalled();
  });

  it("multiple process() calls process each payment only once", async () => {
    const executor = successExecutor();
    const orch = new PaymentOrchestrator(executor);

    orch.queue(makePayment());

    const p1 = orch.process();
    const p2 = orch.process();

    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);

    // The payment should be processed exactly once
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("payments queued after process() starts are NOT picked up by that call", async () => {
    const executor: PaymentExecutor = vi
      .fn()
      .mockResolvedValue({ txHash: "tx" });

    const orch = new PaymentOrchestrator(executor);

    orch.queue(makePayment({ id: "first" }));

    const processPromise = orch.process();

    // Add another payment after process() already started
    orch.queue(makePayment({ id: "second" }));

    await vi.runAllTimersAsync();
    await processPromise;

    // Only "first" was in the batch
    expect(executor).toHaveBeenCalledTimes(1);
    // "second" should still be in the queue
    expect(orch.getStatus().queued).toBe(1);
  });

  it("maxRetries=0 means no retries; 1 call then fail", async () => {
    const executor = failExecutor();
    const orch = new PaymentOrchestrator(executor, { maxRetries: 0, baseRetryDelayMs: 1 });

    orch.queue(makePayment());

    const p = orch.process();
    await vi.runAllTimersAsync();
    await p;

    expect(executor).toHaveBeenCalledTimes(1);
    expect(orch.getStatus().failed).toBe(1);
  });

  it("handles bigint invoiceId and amount correctly through the executor", async () => {
    const received: Array<{ invoiceId: bigint; amount: bigint }> = [];
    const executor: PaymentExecutor = vi.fn().mockImplementation(async (p) => {
      received.push({ invoiceId: p.invoiceId, amount: p.amount });
      return { txHash: "tx" };
    });

    const orch = new PaymentOrchestrator(executor);
    orch.queue({ invoiceId: 99999999999999n, payer: "GPAYER", amount: 9007199254740993n });

    await orch.process();

    expect(received[0].invoiceId).toBe(99999999999999n);
    expect(received[0].amount).toBe(9007199254740993n);
  });

  it("payment:processing event carries the current attempt number", async () => {
    const executor: PaymentExecutor = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ txHash: "tx" });

    const attemptNumbers: number[] = [];
    const orch = new PaymentOrchestrator(executor, { maxRetries: 3, baseRetryDelayMs: 10 });
    orch.on("payment:processing", ({ attempt }) => attemptNumbers.push(attempt));

    orch.queue(makePayment());

    const p = orch.process();
    await vi.runAllTimersAsync();
    await p;

    expect(attemptNumbers).toEqual([1, 2]);
  });

  it("drain() does not affect already-processing or completed payments", async () => {
    let resolveExec!: (r: PaymentResult) => void;
    const executor: PaymentExecutor = vi.fn().mockImplementation(
      () => new Promise<PaymentResult>((res) => { resolveExec = res; }),
    );

    const orch = new PaymentOrchestrator(executor);
    orch.queue(makePayment({ id: "inflight" }));

    const processPromise = orch.process();
    // yield so executor is called
    await Promise.resolve();

    // Drain should not affect the in-flight payment
    const drained = orch.drain();
    expect(drained).toHaveLength(0);

    resolveExec({ txHash: "tx" });
    await processPromise;

    expect(orch.getStatus().completed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

describe("PaymentOrchestrator — options", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("accepts custom maxRetries", async () => {
    const executor = failExecutor();
    const orch = new PaymentOrchestrator(executor, { maxRetries: 5, baseRetryDelayMs: 1 });

    orch.queue(makePayment());

    const p = orch.process();
    await vi.runAllTimersAsync();
    await p;

    expect(executor).toHaveBeenCalledTimes(6); // 1 initial + 5 retries
  });

  it("constructor defaults: maxRetries=3", async () => {
    const executor = failExecutor();
    const orch = new PaymentOrchestrator(executor, { baseRetryDelayMs: 1 });

    orch.queue(makePayment());

    const p = orch.process();
    await vi.runAllTimersAsync();
    await p;

    expect(executor).toHaveBeenCalledTimes(4);
  });
});
