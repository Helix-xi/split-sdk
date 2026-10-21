/**
 * Tests for #963 — Smart Contract Interface Builder
 *
 * Verifies:
 * - fluent builder API (method + param chaining)
 * - event emission (before:build, after:build)
 * - spec registration and retrieval
 * - operation recording
 * - error handling for missing method
 * - factory function
 */

import { describe, it, expect, vi } from "vitest";
import {
  ContractInterfaceBuilder,
  createStellarSplitInterfaceBuilder,
} from "../src/contractInterfaceBuilder.js";

// A valid-format contract ID (starts with CA, 56 chars).
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

// Minimal public key lookalike
const PUBLIC_KEY = "GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB";

// ---------------------------------------------------------------------------
// Fluent API
// ---------------------------------------------------------------------------

describe("ContractInterfaceBuilder — fluent API", () => {
  it("builds an operation without throwing", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    const op = builder.method("create_invoice").param("creator", PUBLIC_KEY).param("deadline", 9999999n).build();
    expect(op).toBeDefined();
  });

  it("resets method and params after build()", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    builder.method("create_invoice").param("creator", PUBLIC_KEY).build();

    // Should throw because no method has been set after build resets state
    expect(() => builder.build()).toThrow(/no method selected/);
  });

  it("throws when .param() is called before .method()", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    expect(() => builder.param("creator", PUBLIC_KEY)).toThrow(
      /call .method\(\) before .param\(\)/,
    );
  });

  it("throws when .build() is called without selecting a method", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    expect(() => builder.build()).toThrow(/no method selected/);
  });

  it("allows chaining multiple params", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    expect(() =>
      builder
        .method("pay")
        .param("payer", PUBLIC_KEY)
        .param("invoice_id", 1n)
        .param("amount", 1000n)
        .build(),
    ).not.toThrow();
  });

  it("supports building different methods sequentially", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    const op1 = builder.method("create_invoice").param("creator", PUBLIC_KEY).build();
    const op2 = builder.method("pay").param("payer", PUBLIC_KEY).build();
    expect(op1).toBeDefined();
    expect(op2).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("ContractInterfaceBuilder — events", () => {
  it("emits before:build with method name and params", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    const handler = vi.fn();
    builder.on("before:build", handler);

    builder.method("release").param("invoice_id", 42n).build();

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0][0];
    expect(payload.method).toBe("release");
    expect(payload.params).toHaveLength(1);
    expect(payload.params[0].name).toBe("invoice_id");
  });

  it("emits after:build with method name and the produced operation", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    const handler = vi.fn();
    builder.on("after:build", handler);

    builder.method("refund").param("invoice_id", 7n).build();

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0][0];
    expect(payload.method).toBe("refund");
    expect(payload.operation).toBeDefined();
  });

  it("emits both before:build and after:build per build() call", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    const before = vi.fn();
    const after = vi.fn();
    builder.on("before:build", before);
    builder.on("after:build", after);

    builder.method("create_invoice").build();
    builder.method("pay").build();

    expect(before).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe stops handler from receiving further events", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    const handler = vi.fn();
    const unsub = builder.on("before:build", handler);

    builder.method("create_invoice").build();
    unsub();
    builder.method("create_invoice").build();

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Spec registration
// ---------------------------------------------------------------------------

describe("ContractInterfaceBuilder — spec registration", () => {
  it("registers and retrieves a spec", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    builder.registerSpec({
      name: "custom_method",
      description: "Does something custom",
      params: [{ name: "arg1", description: "First argument" }],
    });

    const spec = builder.getSpec("custom_method");
    expect(spec).toBeDefined();
    expect(spec?.description).toBe("Does something custom");
    expect(spec?.params).toHaveLength(1);
  });

  it("returns undefined for unknown spec", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    expect(builder.getSpec("nonexistent")).toBeUndefined();
  });

  it("listSpecs returns all registered specs", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    builder.registerSpec({ name: "a", params: [] });
    builder.registerSpec({ name: "b", params: [] });

    const specs = builder.listSpecs();
    expect(specs).toHaveLength(2);
    expect(specs.map((s) => s.name)).toContain("a");
    expect(specs.map((s) => s.name)).toContain("b");
  });

  it("registerSpec is chainable", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    const returned = builder.registerSpec({ name: "x", params: [] });
    expect(returned).toBe(builder);
  });
});

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

describe("ContractInterfaceBuilder — recording", () => {
  it("records operations when record: true", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    builder.method("create_invoice").build({ record: true });
    builder.method("pay").build({ record: true });

    const ops = builder.getBuiltOperations();
    expect(ops).toHaveLength(2);
  });

  it("does not record when record is omitted/false", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    builder.method("create_invoice").build();
    builder.method("pay").build({ record: false });

    expect(builder.getBuiltOperations()).toHaveLength(0);
  });

  it("clearBuiltOperations empties the recording", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    builder.method("create_invoice").build({ record: true });
    builder.clearBuiltOperations();
    expect(builder.getBuiltOperations()).toHaveLength(0);
  });

  it("getBuiltOperations returns a copy, not the internal array", () => {
    const builder = new ContractInterfaceBuilder(CONTRACT_ID);
    builder.method("create_invoice").build({ record: true });
    const ops = builder.getBuiltOperations();
    ops.splice(0);
    expect(builder.getBuiltOperations()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe("createStellarSplitInterfaceBuilder", () => {
  it("returns a ContractInterfaceBuilder instance", () => {
    const builder = createStellarSplitInterfaceBuilder(CONTRACT_ID);
    expect(builder).toBeInstanceOf(ContractInterfaceBuilder);
  });

  it("pre-registers the four core StellarSplit method specs", () => {
    const builder = createStellarSplitInterfaceBuilder(CONTRACT_ID);
    expect(builder.getSpec("create_invoice")).toBeDefined();
    expect(builder.getSpec("pay")).toBeDefined();
    expect(builder.getSpec("release")).toBeDefined();
    expect(builder.getSpec("refund")).toBeDefined();
  });

  it("can build a create_invoice operation via the factory builder", () => {
    const builder = createStellarSplitInterfaceBuilder(CONTRACT_ID);
    expect(() =>
      builder
        .method("create_invoice")
        .param("creator", PUBLIC_KEY)
        .param("deadline", BigInt(Math.floor(Date.now() / 1000) + 86400))
        .build(),
    ).not.toThrow();
  });
});
