import { describe, it, expect } from "vitest";
import { encode, matrixToString, isErrorCorrectionLevel } from "../src/qr/qrMatrix.js";

describe("QR code generation (Issue #1047)", () => {
  it("should accept valid error correction levels", () => {
    expect(isErrorCorrectionLevel("L")).toBe(true);
    expect(isErrorCorrectionLevel("M")).toBe(true);
    expect(isErrorCorrectionLevel("Q")).toBe(true);
    expect(isErrorCorrectionLevel("H")).toBe(true);
    expect(isErrorCorrectionLevel("X")).toBe(false);
  });

  it("should encode a short payload", () => {
    const r = encode("Hello QR World");
    expect(r.version).toBeGreaterThanOrEqual(1);
    expect(r.width).toBeGreaterThanOrEqual(21);
    expect(r.svg).toContain("<svg");
    expect(r.svg).toContain("<rect");
  });

  it("should respect label option", () => {
    const r = encode("Test", "M", { label: "Hello" });
    expect(r.svg).toContain("Hello");
  });

  it("should use custom scale", () => {
    const r = encode("Test", "M", { scale: 20 });
    expect(r.svg).toContain("<svg");
  });

  it("should throw on unsupported EC level", () => {
    expect(() => encode("x", "Z" as any)).toThrow();
  });

  it("should encode longer payloads (performance)", () => {
    const long = "A".repeat(500);
    const start = Date.now();
    const r = encode(long);
    const ms = Date.now() - start;
    expect(ms).toBeLessThan(1000);
    expect(r.svg.length).toBeGreaterThan(0);
  });

  it("should produce scannable-consistent matrices (deterministic output)", () => {
    const a = encode("SCAN-ME-123");
    const b = encode("SCAN-ME-123");
    expect(a.svg).toBe(b.svg);
  });

  it("should throw for data too large", () => {
    const huge = "X".repeat(2000);
    expect(() => encode(huge)).toThrow();
  });

  it("should render matrix to string", () => {
    const r = encode("HI");
    const s = matrixToString(r.modules, r.width);
    expect(s).toContain("#");
    expect(s).toContain(".");
  });
});
