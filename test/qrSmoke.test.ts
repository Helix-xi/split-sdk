import { describe, expect, it } from "vitest";
import { encode, matrixToString } from "../src/qr/qrMatrix.js";

describe("QR encode smoke", () => {
  it("should encode a short payload", () => {
    const r = encode("Hello QR World");
    expect(r.version).toBeGreaterThanOrEqual(1);
    expect(r.width).toBeGreaterThan(20);
    expect(r.svg).toContain("<svg");
    expect(r.svg).toContain("<rect");
  });
  it("should respect label", () => {
    const r = encode("Test", "M", { label: "Hello" });
    expect(r.svg).toContain("Hello");
  });
  it("should throw on unsupported EC", () => {
    expect(() => encode("x", "Z" as any)).toThrow();
  });
});
