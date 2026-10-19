import { describe, expect, it, vi, beforeEach } from "vitest";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import {
  CurrencyConverter,
  convertCurrency,
  convertAmount,
  convertFiatToAsset,
  clearPriceCache,
} from "../src/currencyConverter.js";
import { ValidationError } from "../src/errors.js";

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    Contract: class MockContract {
      constructor(_id: string) {}
      call(..._args: any[]) { return {}; }
    },
    TransactionBuilder: class MockTxBuilder {
      constructor(_source: any, _opts: any) {}
      addOperation(_op: any) { return this; }
      setTimeout(_s: number) { return this; }
      build() { return {}; }
    },
    scValToNative: vi.fn((_val: any) => _val?.value ?? "0"),
    nativeToScVal: vi.fn((...args: any[]) => args[0]),
  };
});

const NETWORK = "Test SDF Network ; September 2015";
const ORACLE = "GORACLE_ADDR";

function mockServer(rate: bigint) {
  return {
    simulateTransaction: vi.fn().mockResolvedValue({
      result: {
        retval: { value: rate.toString() },
      },
    } as unknown as SorobanRpc.Api.SimulateTransactionSuccessResponse),
  } as unknown as SorobanRpc.Server;
}

describe("currencyConverter (legacy oracle)", () => {
  beforeEach(() => {
    clearPriceCache();
  });

  it("converts amount using oracle rate", async () => {
    const rate = 2_000_000_000_000_000_000n;
    const server = mockServer(rate);

    const result = await convertAmount(
      1000n, "XLM", "USD", ORACLE, server, NETWORK,
    );

    expect(result.original).toBe(1000n);
    expect(result.converted).toBe(2000n);
    expect(result.rate).toBe(rate);
    expect(result.fromToken).toBe("XLM");
    expect(result.toDisplayCurrency).toBe("USD");
  });

  it("caches oracle price lookups within TTL", async () => {
    const rate = 1_500_000_000_000_000_000n;
    const server = mockServer(rate);

    await convertAmount(100n, "XLM", "USD", ORACLE, server, NETWORK, 10_000);
    await convertAmount(200n, "XLM", "USD", ORACLE, server, NETWORK, 10_000);

    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when cache TTL expires", async () => {
    const rate = 1_000_000_000_000_000_000n;
    const server = mockServer(rate);

    await convertAmount(100n, "XLM", "USD", ORACLE, server, NETWORK, 0);
    await convertAmount(200n, "XLM", "USD", ORACLE, server, NETWORK, 0);

    expect(server.simulateTransaction).toHaveBeenCalledTimes(2);
  });

  it("handles fractional conversion correctly", async () => {
    const rate = 500_000_000_000_000_000n;
    const server = mockServer(rate);

    const result = await convertAmount(1000n, "USDC", "EUR", ORACLE, server, NETWORK);
    expect(result.converted).toBe(500n);
  });

  it("returns bigint zero for zero amount", async () => {
    const rate = 2_000_000_000_000_000_000n;
    const server = mockServer(rate);

    const result = await convertAmount(0n, "XLM", "USD", ORACLE, server, NETWORK);
    expect(result.converted).toBe(0n);
  });
});

describe("convertFiatToAsset", () => {
  it("converts fiat amount to crypto asset using oracle adapter", async () => {
    const mockOracle = {
      getPrice: vi.fn().mockResolvedValue(0.125), // 1 XLM = $0.125
    };

    const res = await convertFiatToAsset(100, "USD", "XLM", mockOracle);
    expect(res.fiatAmount).toBe(100);
    expect(res.fiatCurrency).toBe("USD");
    expect(res.assetCode).toBe("XLM");
    expect(res.rate).toBe(0.125);
    expect(res.assetAmount).toBe(800); // 100 / 0.125 = 800 XLM
  });

  it("throws OraclePriceError when oracle returns non-positive rate", async () => {
    const mockOracle = {
      getPrice: vi.fn().mockResolvedValue(0),
    };
    await expect(convertFiatToAsset(100, "USD", "XLM", mockOracle)).rejects.toThrow();
  });
});

describe("CurrencyConverter class (#1031)", () => {
  it("converts with direct rate and respects precision", async () => {
    const converter = new CurrencyConverter();
    converter.setRate("XLM", "USD", 0.125);

    const result = await converter.convert({
      amount: 400,
      from: "XLM",
      to: "USD",
      precision: 2,
    });

    expect(result.amount).toBe(400);
    expect(result.convertedAmount).toBe(50);
    expect(result.rate).toBe(0.125);
    expect(result.from).toBe("XLM");
    expect(result.to).toBe("USD");
    expect(result.cached).toBe(true);
  });

  it("handles identical from and to currency with 1.0 rate", async () => {
    const converter = new CurrencyConverter();
    const result = await converter.convert({
      amount: 100,
      from: "USDC",
      to: "USDC",
    });
    expect(result.convertedAmount).toBe(100);
    expect(result.rate).toBe(1.0);
  });

  it("automatically derives inverse exchange rates", async () => {
    const converter = new CurrencyConverter();
    converter.setRate("EUR", "USD", 1.10); // 1 EUR = 1.10 USD

    const result = await converter.convert({
      amount: 110,
      from: "USD",
      to: "EUR",
      precision: 4,
    });

    expect(result.convertedAmount).toBeCloseTo(100, 2);
  });

  it("fetches rate using rateProvider and caches result within TTL", async () => {
    const rateProvider = vi.fn().mockResolvedValue(0.15);
    const converter = new CurrencyConverter({ rateProvider, defaultTtlMs: 5000 });

    // First call fetches from provider
    const res1 = await converter.convert({ amount: 100, from: "XLM", to: "USD" });
    expect(res1.convertedAmount).toBe(15);
    expect(res1.cached).toBe(false);
    expect(rateProvider).toHaveBeenCalledTimes(1);

    // Second call serves from cache
    const res2 = await converter.convert({ amount: 200, from: "XLM", to: "USD" });
    expect(res2.convertedAmount).toBe(30);
    expect(res2.cached).toBe(true);
    expect(rateProvider).toHaveBeenCalledTimes(1);

    const stats = converter.getCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it("supports triangulation across intermediate base currency", async () => {
    const rateProvider = vi.fn().mockImplementation(async (from: string, to: string) => {
      if (from === "XLM" && to === "USD") return 0.10;
      if (from === "EUR" && to === "USD") return 1.20;
      throw new Error(`Direct pair ${from}/${to} not found`);
    });

    const converter = new CurrencyConverter({ rateProvider, triangulationCurrency: "USD" });
    // Convert XLM to EUR via USD: 1 XLM = 0.10 USD, 1 EUR = 1.20 USD -> 1 XLM = 0.10 / 1.20 EUR = 0.08333 EUR
    const res = await converter.convert({
      amount: 1200,
      from: "XLM",
      to: "EUR",
      precision: 2,
    });

    expect(res.convertedAmount).toBeCloseTo(100, 1);
  });

  it("supports batch conversions", async () => {
    const converter = new CurrencyConverter();
    converter.setRate("XLM", "USD", 0.10);
    converter.setRate("BTC", "USD", 60000);

    const results = await converter.batchConvert([
      { amount: 100, from: "XLM", to: "USD" },
      { amount: 1, from: "BTC", to: "USD" },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]?.convertedAmount).toBe(10);
    expect(results[1]?.convertedAmount).toBe(60000);
  });

  it("invalidates and clears cache correctly", async () => {
    const converter = new CurrencyConverter();
    converter.setRate("XLM", "USD", 0.10);
    expect(converter.getCachedRate("XLM", "USD")).toBe(0.10);

    converter.invalidate("XLM", "USD");
    expect(converter.getCachedRate("XLM", "USD")).toBeUndefined();

    converter.setRate("XLM", "USD", 0.10);
    converter.setRate("EUR", "USD", 1.10);
    expect(converter.getCacheStats().size).toBe(2);

    converter.clearCache();
    expect(converter.getCacheStats().size).toBe(0);
  });

  describe("Validation", () => {
    const converter = new CurrencyConverter();

    it("rejects negative amounts", async () => {
      await expect(converter.convert({ amount: -5, from: "XLM", to: "USD", rate: 0.1 })).rejects.toThrow(ValidationError);
      await expect(converter.convert({ amount: -1n, from: "XLM", to: "USD", rate: 0.1 })).rejects.toThrow(ValidationError);
    });

    it("rejects NaN or non-finite amounts", async () => {
      await expect(converter.convert({ amount: Number.NaN, from: "XLM", to: "USD", rate: 0.1 })).rejects.toThrow(ValidationError);
      await expect(converter.convert({ amount: Number.POSITIVE_INFINITY, from: "XLM", to: "USD", rate: 0.1 })).rejects.toThrow(ValidationError);
    });

    it("rejects empty currency codes", async () => {
      await expect(converter.convert({ amount: 10, from: "", to: "USD", rate: 0.1 })).rejects.toThrow(ValidationError);
      await expect(converter.convert({ amount: 10, from: "XLM", to: "   ", rate: 0.1 })).rejects.toThrow(ValidationError);
    });

    it("rejects zero or negative exchange rates", () => {
      expect(() => converter.setRate("XLM", "USD", 0)).toThrow(ValidationError);
      expect(() => converter.setRate("XLM", "USD", -0.5)).toThrow(ValidationError);
    });
  });
});

describe("convertCurrency helper", () => {
  it("converts accurately with precision", () => {
    expect(convertCurrency(100, 1.2345, 2)).toBe(123.45);
    expect(convertCurrency(0, 5)).toBe(0);
  });

  it("validates input", () => {
    expect(() => convertCurrency(-1, 2)).toThrow(ValidationError);
    expect(() => convertCurrency(10, -2)).toThrow(ValidationError);
  });
});
