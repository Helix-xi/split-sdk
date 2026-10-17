import { describe, it, expect, vi } from "vitest";
import {
  WebhookClient,
  WebhookVerificationError,
  WebhookTimestampError,
  WebhookPayloadMalformedError,
} from "../src/webhookClient.js";
import { EventEmitter } from "events";
import type { IncomingMessage, ServerResponse } from "http";

describe("Webhook Client (#1035)", () => {
  const secret = "whsec_test_secret_1234567890abcdef";

  describe("Verification", () => {
    it("successfully verifies valid signature and timestamp", () => {
      const client = new WebhookClient({ secret, toleranceSeconds: 300 });
      const payload = JSON.stringify({ event: "payment", invoiceId: "inv-1", amount: "100" });
      const { signature, timestamp } = client.computeSignature(payload);

      const verification = client.verify(payload, signature, String(timestamp));
      expect(verification.valid).toBe(true);
      expect(verification.timestamp).toBe(timestamp);
    });

    it("verifies combined t=...,v1=... signature header format", () => {
      const client = new WebhookClient({ secret });
      const payload = JSON.stringify({ event: "released", invoiceId: "inv-2" });
      const { signature, timestamp } = client.computeSignature(payload);

      const header = `t=${timestamp},v1=${signature}`;
      const verification = client.verify(payload, header);
      expect(verification.valid).toBe(true);
      expect(verification.timestamp).toBe(timestamp);
    });

    it("rejects tampered payload", () => {
      const client = new WebhookClient({ secret });
      const payload = JSON.stringify({ event: "payment", amount: "100" });
      const { signature, timestamp } = client.computeSignature(payload);

      const tampered = JSON.stringify({ event: "payment", amount: "1000" });
      const verification = client.verify(tampered, signature, String(timestamp));
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain("Signature mismatch");
    });

    it("rejects wrong secret key", () => {
      const client = new WebhookClient({ secret: "correct_secret" });
      const badClient = new WebhookClient({ secret: "wrong_secret" });
      const payload = JSON.stringify({ event: "payment" });
      const { signature, timestamp } = badClient.computeSignature(payload);

      const verification = client.verify(payload, signature, String(timestamp));
      expect(verification.valid).toBe(false);
    });

    it("rejects timestamps outside tolerance window (replay attack prevention)", () => {
      const client = new WebhookClient({ secret, toleranceSeconds: 60 });
      const payload = JSON.stringify({ event: "payment" });
      const oldTimestamp = Math.floor(Date.now() / 1000) - 120; // 2 minutes ago
      const { signature } = client.computeSignature(payload, oldTimestamp);

      const verification = client.verify(payload, signature, String(oldTimestamp));
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain("outside tolerance");
    });
  });

  describe("Event Processing & Handlers", () => {
    it("dispatches events to registered event-specific handler", async () => {
      const client = new WebhookClient({ secret });
      const paymentHandler = vi.fn();
      const releaseHandler = vi.fn();

      client.on("payment", paymentHandler);
      client.on("released", releaseHandler);

      const payload = JSON.stringify({
        event: "payment",
        invoiceId: "inv-42",
        data: { amount: "50" },
      });
      const { signature, timestamp } = client.computeSignature(payload);

      const result = await client.process(payload, {
        "x-stellar-split-signature": signature,
        "x-stellar-split-timestamp": String(timestamp),
      });

      expect(result.success).toBe(true);
      expect(result.handlersExecuted).toBe(1);
      expect(paymentHandler).toHaveBeenCalledTimes(1);
      expect(paymentHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "payment",
          invoiceId: "inv-42",
          data: { amount: "50" },
        }),
      );
      expect(releaseHandler).not.toHaveBeenCalled();
    });

    it("dispatches events to wildcard '*' handlers", async () => {
      const client = new WebhookClient({ secret });
      const wildcardHandler = vi.fn();
      client.on("*", wildcardHandler);

      const payload = JSON.stringify({ event: "refunded", invoiceId: "inv-99" });
      const { signature, timestamp } = client.computeSignature(payload);

      const result = await client.process(payload, {
        "x-stellar-split-signature": signature,
        "x-stellar-split-timestamp": String(timestamp),
      });

      expect(result.handlersExecuted).toBe(1);
      expect(wildcardHandler).toHaveBeenCalledWith(
        expect.objectContaining({ event: "refunded", invoiceId: "inv-99" }),
      );
    });

    it("executes once() handlers only once", async () => {
      const client = new WebhookClient({ secret });
      const onceHandler = vi.fn();
      client.once("payment", onceHandler);

      const payload = JSON.stringify({ event: "payment" });
      const { signature, timestamp } = client.computeSignature(payload);
      const headers = {
        "x-stellar-split-signature": signature,
        "x-stellar-split-timestamp": String(timestamp),
      };

      await client.process(payload, headers);
      await client.process(payload, headers);

      expect(onceHandler).toHaveBeenCalledTimes(1);
    });

    it("unregisters handlers via off()", async () => {
      const client = new WebhookClient({ secret });
      const handler = vi.fn();
      client.on("payment", handler);
      client.off("payment", handler);

      const payload = JSON.stringify({ event: "payment" });
      const { signature, timestamp } = client.computeSignature(payload);
      await client.process(payload, {
        "x-stellar-split-signature": signature,
        "x-stellar-split-timestamp": String(timestamp),
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it("executes middleware pipeline before handlers", async () => {
      const client = new WebhookClient({ secret });
      const order: string[] = [];

      client.use(async (payload, next) => {
        order.push("middleware-1-before");
        await next();
        order.push("middleware-1-after");
      });

      client.on("payment", () => {
        order.push("handler");
      });

      const payload = JSON.stringify({ event: "payment" });
      const { signature, timestamp } = client.computeSignature(payload);
      await client.process(payload, {
        "x-stellar-split-signature": signature,
        "x-stellar-split-timestamp": String(timestamp),
      });

      expect(order).toEqual(["middleware-1-before", "handler", "middleware-1-after"]);
    });
  });

  describe("Error Handling", () => {
    it("throws WebhookVerificationError on missing signature", async () => {
      const client = new WebhookClient({ secret });
      const payload = JSON.stringify({ event: "payment" });

      await expect(client.process(payload, {})).rejects.toThrow(WebhookVerificationError);
    });

    it("throws WebhookTimestampError on expired timestamp", async () => {
      const client = new WebhookClient({ secret, toleranceSeconds: 10 });
      const payload = JSON.stringify({ event: "payment" });
      const oldTime = Math.floor(Date.now() / 1000) - 30;
      const { signature } = client.computeSignature(payload, oldTime);

      await expect(
        client.process(payload, {
          "x-stellar-split-signature": signature,
          "x-stellar-split-timestamp": String(oldTime),
        }),
      ).rejects.toThrow(WebhookTimestampError);
    });

    it("throws WebhookPayloadMalformedError on invalid JSON", async () => {
      const client = new WebhookClient({ secret });
      const invalidJson = "{ invalid json: true";
      const { signature, timestamp } = client.computeSignature(invalidJson);

      await expect(
        client.process(invalidJson, {
          "x-stellar-split-signature": signature,
          "x-stellar-split-timestamp": String(timestamp),
        }),
      ).rejects.toThrow(WebhookPayloadMalformedError);
    });

    it("returns error result without throwing when throwOnError is false", async () => {
      const client = new WebhookClient({ secret, throwOnError: false });
      const result = await client.process("invalid", {});

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(WebhookVerificationError);
    });

    it("notifies onError callback on failures", async () => {
      const client = new WebhookClient({ secret, throwOnError: false });
      const onError = vi.fn();
      client.onError(onError);

      await client.process("{}", {});

      expect(onError).toHaveBeenCalledWith(
        expect.any(WebhookVerificationError),
        "{}",
        {},
      );
    });
  });

  describe("HTTP Request Adapter", () => {
    it("handles mock IncomingMessage and responds with 200 on success", async () => {
      const client = new WebhookClient({ secret });
      const handler = vi.fn();
      client.on("invoice.created", handler);

      const httpHandler = client.createHttpHandler();

      const payload = JSON.stringify({ event: "invoice.created", id: "10" });
      const { signature, timestamp } = client.computeSignature(payload);

      const req = new EventEmitter() as unknown as IncomingMessage;
      req.headers = {
        "x-stellar-split-signature": signature,
        "x-stellar-split-timestamp": String(timestamp),
      };

      const res = {
        writeHead: vi.fn(),
        end: vi.fn(),
      } as unknown as ServerResponse;

      const promise = httpHandler(req, res);

      req.emit("data", Buffer.from(payload));
      req.emit("end");

      await promise;

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(handler).toHaveBeenCalled();
    });

    it("responds with 400 when signature verification fails", async () => {
      const client = new WebhookClient({ secret });
      const httpHandler = client.createHttpHandler();

      const req = new EventEmitter() as unknown as IncomingMessage;
      req.headers = {};

      const res = {
        writeHead: vi.fn(),
        end: vi.fn(),
      } as unknown as ServerResponse;

      const promise = httpHandler(req, res);
      req.emit("data", Buffer.from("{}"));
      req.emit("end");

      await promise;

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });
  });
});
