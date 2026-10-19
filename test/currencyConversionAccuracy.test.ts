/**
 * Test Suite: Currency Conversion Accuracy (#1043)
 *
 * Requirements:
 * - Test conversions: Oracle price conversions, rate calculation, fiat-to-asset conversion
 * - Test precision: Decimal preservation across XLM (7 decimals) and custom token precisions
 * - Test rounding: Largest-remainder split division, exact sum invariants, and overflow thresholds
 * - Test edge cases: Zero amounts, single stroop, large BigInt values, repeating decimals
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { Asset, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import {
  convertAmount,
  convertFiatToAsset,
  clearPriceCache,
} from "../src/currencyConverter.js";
import {
  normalizeAmount,
  toOnChainAmount,
  registerAssetPrecision,
  getAssetPrecision,
  verifyRoundTrip,
} from "../src/currencyNormalizer.js";
import { auditSplitRounding, RoundingOverflowError } from "../src/invoice/rounding.js";
import { OraclePriceError, PrecisionError } from "../src/errors.js";
import type { SplitLine } from "../src/types.js";

const TEST_NETWORK = "Test SDF Network ; September 2015";
const TEST_ORACLE_ADDR = "GORACLE_ADDR";

function createMockRpcServer(rate: bigint): SorobanRpc.Server {
  return {
    simulateTransaction: vi.fn().mockResolvedValue({
      result: {
        retval: { value: rate.toString() },
      },
    } as unknown as SorobanRpc.Api.SimulateTransactionSuccessResponse),
  } as unknown as SorobanRpc.Server;
}

describe("Currency Conversion Accuracy (#1043)", () => {
  beforeEach(() => {
    clearPriceCache();
    vi.restoreAllMocks();
  });

  describe("Requirement: Test conversions", () => {
    it("accurately converts asset amount using 18-decimal fixed-point oracle rate (> 1.0)", async () => {
      // Rate: 2.50 USD per token -> 2.5 * 10^18 = 2_500_000_000_000_000_000n
      const rate = 2_500_000_000_000_000_000n;
      const server = createMockRpcServer(rate);

      // Convert 10,000,000 stroops (1 XLM)
      const inputAmount = 10_000_000n;
      const result = await convertAmount(
        inputAmount,
        "XLM",
        "USD",
        TEST_ORACLE_ADDR,
        server,
        TEST_NETWORK
      );

      expect(result.original).toBe(inputAmount);
      // 10_000_000n * 2.5 = 25_000_000n
      expect(result.converted).toBe(25_000_000n);
      expect(result.rate).toBe(rate);
      expect(result.fromToken).toBe("XLM");
      expect(result.toDisplayCurrency).toBe("USD");
    });

    it("accurately converts asset amount using fractional rate (< 1.0)", async () => {
      // Rate: 0.125 USD per token -> 0.125 * 10^18 = 125_000_000_000_000_000n
      const rate = 125_000_000_000_000_000n;
      const server = createMockRpcServer(rate);

      const inputAmount = 80_000_000n;
      const result = await convertAmount(
        inputAmount,
        "XLM",
        "USD",
        TEST_ORACLE_ADDR,
        server,
        TEST_NETWORK
      );

      // 80_000_000n * 0.125 = 10_000_000n
      expect(result.converted).toBe(10_000_000n);
    });

    it("accurately converts at exact 1:1 parity", async () => {
      // Rate: 1.000000000000000000 (10^18)
      const rate = 1_000_000_000_000_000_000n;
      const server = createMockRpcServer(rate);

      const inputAmount = 45_678_901n;
      const result = await convertAmount(
        inputAmount,
        "USDC",
        "USD",
        TEST_ORACLE_ADDR,
        server,
        TEST_NETWORK
      );

      expect(result.converted).toBe(inputAmount);
    });

    it("converts fiat amounts to crypto assets using price oracle adapter", async () => {
      const mockOracle = {
        getPrice: vi.fn().mockResolvedValue(0.25), // 1 XLM = $0.25 USD
      };

      const result = await convertFiatToAsset(100, "USD", "XLM", mockOracle);

      expect(result.fiatAmount).toBe(100);
      expect(result.fiatCurrency).toBe("USD");
      expect(result.assetAmount).toBe(400); // $100 / $0.25 = 400 XLM
      expect(result.assetCode).toBe("XLM");
      expect(result.rate).toBe(0.25);
    });

    it("rejects non-positive oracle conversion rates with OraclePriceError", async () => {
      const zeroRateOracle = {
        getPrice: vi.fn().mockResolvedValue(0),
      };
      await expect(convertFiatToAsset(100, "USD", "XLM", zeroRateOracle)).rejects.toThrow(
        OraclePriceError
      );

      const negativeRateOracle = {
        getPrice: vi.fn().mockResolvedValue(-1.5),
      };
      await expect(convertFiatToAsset(100, "USD", "XLM", negativeRateOracle)).rejects.toThrow(
        OraclePriceError
      );
    });
  });

  describe("Requirement: Test precision", () => {
    it("maintains exact 7-decimal precision for native XLM without floating point drift", () => {
      expect(normalizeAmount(10_000_000n, Asset.native())).toBe("1.0000000");
      expect(normalizeAmount(1n, Asset.native())).toBe("0.0000001");
      expect(normalizeAmount(12_345_678n, Asset.native())).toBe("1.2345678");
      expect(normalizeAmount(100_000_000n, Asset.native())).toBe("10.0000000");
    });

    it("converts display format back to on-chain stroops precisely", () => {
      expect(toOnChainAmount("1.0000000", Asset.native())).toBe("10000000");
      expect(toOnChainAmount("0.0000001", Asset.native())).toBe("1");
      expect(toOnChainAmount("1.5", Asset.native())).toBe("15000000");
      expect(toOnChainAmount("100", Asset.native())).toBe("1000000000");
    });

    it("supports custom token precisions (6 decimals for USDC, 2 for fiat, 0 for points)", () => {
      registerAssetPrecision("USDC_CANONICAL", 6);
      registerAssetPrecision("FIAT_CENT", 2);
      registerAssetPrecision("REWARD_POINTS", 0);

      expect(getAssetPrecision("USDC_CANONICAL")).toBe(6);
      expect(getAssetPrecision("FIAT_CENT")).toBe(2);
      expect(getAssetPrecision("REWARD_POINTS")).toBe(0);

      expect(normalizeAmount(1_500_000n, "USDC_CANONICAL")).toBe("1.500000");
      expect(toOnChainAmount("1.5", "USDC_CANONICAL")).toBe("1500000");

      expect(normalizeAmount(250n, "FIAT_CENT")).toBe("2.50");
      expect(toOnChainAmount("2.50", "FIAT_CENT")).toBe("250");

      expect(normalizeAmount(100n, "REWARD_POINTS")).toBe("100");
      expect(toOnChainAmount("100", "REWARD_POINTS")).toBe("100");
    });

    it("verifies lossless round-trip accuracy across a wide range of amounts", () => {
      expect(verifyRoundTrip("1.5000000", Asset.native())).toBe(true);
      expect(verifyRoundTrip("0.0000001", Asset.native())).toBe(true);
      expect(verifyRoundTrip("999999.9999999", Asset.native())).toBe(true);
      expect(verifyRoundTrip("42", Asset.native())).toBe(true);
    });

    it("rejects input amounts with fractional precision exceeding asset capacity", () => {
      // XLM supports up to 7 decimal digits; 8 digits must throw PrecisionError
      expect(() => toOnChainAmount("1.12345678", Asset.native())).toThrow(PrecisionError);
      expect(verifyRoundTrip("1.12345678", Asset.native())).toBe(false);

      // USDC supports 6 decimal digits; 7 digits must throw PrecisionError
      expect(() => toOnChainAmount("1.1234567", "USDC_CANONICAL")).toThrow(PrecisionError);
    });

    it("throws PrecisionError for unregistered custom assets", () => {
      expect(() => getAssetPrecision("UNKNOWN_TOKEN")).toThrow(PrecisionError);
      expect(() => normalizeAmount(100n, "UNKNOWN_TOKEN")).toThrow(PrecisionError);
    });
  });

  describe("Requirement: Test rounding", () => {
    it("handles exact division with zero rounding adjustments", () => {
      const splits: SplitLine[] = [
        { recipientId: "G_A", ratio: 0.5 },
        { recipientId: "G_B", ratio: 0.5 },
      ];

      const result = auditSplitRounding(100n, splits);
      expect(result.total).toBe(100n);
      expect(result.amounts["G_A"]).toBe(50n);
      expect(result.amounts["G_B"]).toBe(50n);
      expect(result.adjustments).toHaveLength(0);
    });

    it("uses largest-remainder method for uneven 3-way split preserving exact total sum", () => {
      // 100 stroops among 3 recipients with 1/3 ratio each
      // Floor: 33 + 33 + 33 = 99 (1 stroop remainder to distribute)
      const splits: SplitLine[] = [
        { recipientId: "G_A", ratio: 0.3333333 },
        { recipientId: "G_B", ratio: 0.3333333 },
        { recipientId: "G_C", ratio: 0.3333334 }, // has highest ratio/remainder
      ];

      const result = auditSplitRounding(100n, splits);
      const sum = Object.values(result.amounts).reduce((a, b) => a + b, 0n);

      expect(sum).toBe(100n);
      expect(result.total).toBe(100n);
      // Highest remainder gets 34, others get 33
      expect(result.amounts["G_C"]).toBe(34n);
      expect(result.amounts["G_A"]).toBe(33n);
      expect(result.amounts["G_B"]).toBe(33n);
      expect(result.adjustments).toHaveLength(1);
      expect(result.adjustments[0]?.recipientId).toBe("G_C");
      expect(result.adjustments[0]?.delta).toBe(1n);
    });

    it("handles minimal 1-stroop total distributed among 3 recipients", () => {
      const splits: SplitLine[] = [
        { recipientId: "G_1", ratio: 0.4 },
        { recipientId: "G_2", ratio: 0.3 },
        { recipientId: "G_3", ratio: 0.3 },
      ];

      const result = auditSplitRounding(1n, splits);
      const sum = Object.values(result.amounts).reduce((a, b) => a + b, 0n);

      expect(sum).toBe(1n);
      expect(result.amounts["G_1"]).toBe(1n);
      expect(result.amounts["G_2"]).toBe(0n);
      expect(result.amounts["G_3"]).toBe(0n);
    });

    it("throws RoundingOverflowError when cumulative adjustment exceeds threshold", () => {
      // Bad ratios that do not sum close to 1.0 (sum = 1.6)
      const splits: SplitLine[] = [
        { recipientId: "G_A", ratio: 0.8 },
        { recipientId: "G_B", ratio: 0.8 },
      ];

      expect(() => auditSplitRounding(1000n, splits)).toThrow(RoundingOverflowError);
    });
  });

  describe("Requirement: Test edge cases", () => {
    it("handles zero amount cleanly across all conversion and normalization methods", async () => {
      const server = createMockRpcServer(2_000_000_000_000_000_000n);
      const converted = await convertAmount(0n, "XLM", "USD", TEST_ORACLE_ADDR, server, TEST_NETWORK);
      expect(converted.converted).toBe(0n);

      expect(normalizeAmount(0n, Asset.native())).toBe("0.0000000");
      expect(toOnChainAmount("0", Asset.native())).toBe("0");

      const splits: SplitLine[] = [
        { recipientId: "G_A", ratio: 0.6 },
        { recipientId: "G_B", ratio: 0.4 },
      ];
      const rounded = auditSplitRounding(0n, splits);
      expect(rounded.total).toBe(0n);
      expect(rounded.amounts["G_A"]).toBe(0n);
      expect(rounded.amounts["G_B"]).toBe(0n);
    });

    it("handles 1 stroop conversion and normalization", async () => {
      const server = createMockRpcServer(1_000_000_000_000_000_000n); // 1.0x rate
      const converted = await convertAmount(1n, "XLM", "USD", TEST_ORACLE_ADDR, server, TEST_NETWORK);
      expect(converted.converted).toBe(1n);

      expect(normalizeAmount(1n, Asset.native())).toBe("0.0000001");
      expect(toOnChainAmount("0.0000001", Asset.native())).toBe("1");
    });

    it("accurately handles very large amounts without BigInt or float overflow", async () => {
      // 100 billion XLM = 100_000_000_000 * 10^7 = 10^18 stroops
      const hugeAmount = 1_000_000_000_000_000_000n;
      const rate = 3_000_000_000_000_000_000n; // 3.0x rate
      const server = createMockRpcServer(rate);

      const converted = await convertAmount(hugeAmount, "XLM", "USD", TEST_ORACLE_ADDR, server, TEST_NETWORK);
      expect(converted.converted).toBe(3_000_000_000_000_000_000n);

      const normalized = normalizeAmount(hugeAmount, Asset.native());
      expect(normalized).toBe("100000000000.0000000");
      expect(toOnChainAmount(normalized, Asset.native())).toBe(hugeAmount.toString());
    });

    it("handles integer truncation correctly for tiny fractional values", async () => {
      // 1 stroop with 0.5x rate -> (1n * 5e17) / 1e18 = 0n (integer floor)
      const server = createMockRpcServer(500_000_000_000_000_000n);
      const converted = await convertAmount(1n, "XLM", "USD", TEST_ORACLE_ADDR, server, TEST_NETWORK);
      expect(converted.converted).toBe(0n);
    });
  });
});
