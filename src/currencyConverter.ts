/**
 * Currency Conversion Utilities for StellarSplit SDK.
 *
 * Provides utilities for converting between different currencies and tokens,
 * supporting oracle exchange rates, cross-currency conversion, rigorous validation,
 * and high-performance TTL caching.
 *
 * Issue #1031
 */

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { OraclePriceError, NoReturnValueError, ValidationError } from "./errors.js";
import { RateCache } from "./rateCache.js";

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export interface ConvertedAmount {
  original: bigint;
  converted: bigint;
  rate: bigint;
  fromToken: string;
  toDisplayCurrency: string;
}

/** Result of converting a fiat-denominated invoice amount to an on-chain asset. */
export interface FiatConversion {
  /** The requested fiat amount. */
  fiatAmount: number;
  /** The fiat currency code the amount was denominated in (e.g. "USD"). */
  fiatCurrency: string;
  /** The equivalent amount in the target asset. */
  assetAmount: number;
  /** The asset code the amount was converted to (e.g. "XLM"). */
  assetCode: string;
  /** The base/quote rate used for the conversion (units of `fiatCurrency` per 1 `assetCode`). */
  rate: number;
}

/** Pluggable adapter interface for price oracles. */
export interface PriceOracleAdapter {
  getPrice(base: string, quote: string): Promise<number>;
}

export type ExchangeRateProvider = (from: string, to: string) => Promise<number>;

export interface ConversionRequest {
  amount: number | bigint;
  from: string;
  to: string;
  rate?: number;
  precision?: number;
}

export interface ConversionResult {
  amount: number;
  convertedAmount: number;
  from: string;
  to: string;
  rate: number;
  timestamp: number;
  cached: boolean;
}

export interface CurrencyConverterOptions {
  /** Default cache TTL for exchange rates in milliseconds. Default: 60,000ms. */
  defaultTtlMs?: number;
  /** External rate provider (oracle or API). */
  rateProvider?: ExchangeRateProvider | PriceOracleAdapter;
  /** Base currency for triangulation when direct pair is missing (e.g., "USD" or "XLM"). */
  triangulationCurrency?: string;
}

interface CachedRateEntry {
  rate: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// CurrencyConverter Class
// ---------------------------------------------------------------------------

export class CurrencyConverter {
  private readonly defaultTtlMs: number;
  private readonly rateProvider?: ExchangeRateProvider;
  private readonly triangulationCurrency: string;
  private readonly cache = new Map<string, CachedRateEntry>();
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(options: CurrencyConverterOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 60_000;
    this.triangulationCurrency = options.triangulationCurrency?.toUpperCase() ?? "USD";

    if (options.rateProvider) {
      if (typeof options.rateProvider === "function") {
        this.rateProvider = options.rateProvider;
      } else if (typeof (options.rateProvider as PriceOracleAdapter).getPrice === "function") {
        const adapter = options.rateProvider as PriceOracleAdapter;
        this.rateProvider = (from, to) => adapter.getPrice(from, to);
      }
    }
  }

  /**
   * Set or pre-seed an exchange rate for a currency pair with an optional custom TTL.
   */
  setRate(from: string, to: string, rate: number, ttlMs?: number): this {
    const normFrom = this.validateCurrency(from, "from");
    const normTo = this.validateCurrency(to, "to");
    this.validateRate(rate);

    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = Date.now() + Math.max(1, ttl);
    this.cache.set(this.pairKey(normFrom, normTo), { rate, expiresAt });
    return this;
  }

  /**
   * Look up a rate from cache without invoking the remote rate provider.
   */
  getCachedRate(from: string, to: string): number | undefined {
    const key = this.pairKey(from.toUpperCase().trim(), to.toUpperCase().trim());
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.rate;
  }

  /**
   * Resolve exchange rate between `from` and `to`.
   * Checks direct pair -> inverse pair -> rateProvider -> triangulation.
   */
  async getRate(from: string, to: string): Promise<{ rate: number; cached: boolean }> {
    const normFrom = this.validateCurrency(from, "from");
    const normTo = this.validateCurrency(to, "to");

    if (normFrom === normTo) {
      return { rate: 1.0, cached: true };
    }

    const key = this.pairKey(normFrom, normTo);
    const cachedEntry = this.cache.get(key);
    if (cachedEntry && Date.now() <= cachedEntry.expiresAt) {
      this.cacheHits++;
      return { rate: cachedEntry.rate, cached: true };
    }

    // Check inverse rate in cache
    const inverseKey = this.pairKey(normTo, normFrom);
    const inverseEntry = this.cache.get(inverseKey);
    if (inverseEntry && Date.now() <= inverseEntry.expiresAt && inverseEntry.rate > 0) {
      this.cacheHits++;
      const derivedRate = 1 / inverseEntry.rate;
      return { rate: derivedRate, cached: true };
    }

    this.cacheMisses++;

    if (!this.rateProvider) {
      throw new OraclePriceError(`No exchange rate found for pair ${normFrom}/${normTo} and no rate provider configured.`);
    }

    // Try fetching direct pair
    try {
      const fetchedRate = await this.rateProvider(normFrom, normTo);
      this.validateRate(fetchedRate);
      this.setRate(normFrom, normTo, fetchedRate);
      return { rate: fetchedRate, cached: false };
    } catch (err) {
      // Try fetching inverse pair
      try {
        const inverseRate = await this.rateProvider(normTo, normFrom);
        this.validateRate(inverseRate);
        const derivedRate = 1 / inverseRate;
        this.setRate(normFrom, normTo, derivedRate);
        return { rate: derivedRate, cached: false };
      } catch {
        // Try triangulation via base currency if neither was the base currency
        if (normFrom !== this.triangulationCurrency && normTo !== this.triangulationCurrency) {
          try {
            const { rate: rateFromBase } = await this.getRate(normFrom, this.triangulationCurrency);
            const { rate: rateBaseTo } = await this.getRate(this.triangulationCurrency, normTo);
            const triangulatedRate = rateFromBase * rateBaseTo;
            this.setRate(normFrom, normTo, triangulatedRate);
            return { rate: triangulatedRate, cached: false };
          } catch {
            // triangulation also failed, propagate original error
          }
        }
        throw err instanceof Error ? err : new OraclePriceError(`Failed to fetch exchange rate for ${normFrom}/${normTo}`);
      }
    }
  }

  /**
   * Convert an amount from one currency/token to another.
   */
  async convert(request: ConversionRequest): Promise<ConversionResult> {
    const { from, to, precision } = request;
    const normFrom = this.validateCurrency(from, "from");
    const normTo = this.validateCurrency(to, "to");
    const numAmount = this.validateAmount(request.amount);

    let rate: number;
    let cached = false;

    if (request.rate !== undefined) {
      this.validateRate(request.rate);
      rate = request.rate;
      cached = false;
    } else {
      const rateInfo = await this.getRate(normFrom, normTo);
      rate = rateInfo.rate;
      cached = rateInfo.cached;
    }

    let convertedAmount = numAmount * rate;
    if (precision !== undefined) {
      if (!Number.isInteger(precision) || precision < 0) {
        throw new ValidationError("precision must be a non-negative integer", { precision });
      }
      convertedAmount = Number(convertedAmount.toFixed(precision));
    }

    return {
      amount: numAmount,
      convertedAmount,
      from: normFrom,
      to: normTo,
      rate,
      timestamp: Date.now(),
      cached,
    };
  }

  /**
   * Convert a batch of conversion requests concurrently.
   */
  async batchConvert(requests: ConversionRequest[]): Promise<ConversionResult[]> {
    if (!Array.isArray(requests)) {
      throw new ValidationError("requests must be an array");
    }
    return Promise.all(requests.map((req) => this.convert(req)));
  }

  /**
   * Invalidate a single pair from cache.
   */
  invalidate(from: string, to: string): void {
    const key = this.pairKey(from.toUpperCase().trim(), to.toUpperCase().trim());
    this.cache.delete(key);
  }

  /**
   * Invalidate all cached exchange rates.
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /**
   * Get cache hit and miss statistics.
   */
  getCacheStats(): { size: number; hits: number; misses: number } {
    return {
      size: this.cache.size,
      hits: this.cacheHits,
      misses: this.cacheMisses,
    };
  }

  private pairKey(from: string, to: string): string {
    return `${from}:${to}`;
  }

  private validateCurrency(code: unknown, field: string): string {
    if (typeof code !== "string" || code.trim().length === 0) {
      throw new ValidationError(`Invalid currency identifier for '${field}': must be a non-empty string`, { [field]: code });
    }
    return code.trim().toUpperCase();
  }

  private validateAmount(amount: unknown): number {
    if (typeof amount === "bigint") {
      if (amount < 0n) {
        throw new ValidationError("Amount cannot be negative", { amount: amount.toString() });
      }
      return Number(amount);
    }
    if (typeof amount !== "number" || !Number.isFinite(amount) || Number.isNaN(amount)) {
      throw new ValidationError("Amount must be a finite number", { amount });
    }
    if (amount < 0) {
      throw new ValidationError("Amount cannot be negative", { amount });
    }
    return amount;
  }

  private validateRate(rate: unknown): void {
    if (typeof rate !== "number" || !Number.isFinite(rate) || Number.isNaN(rate) || rate <= 0) {
      throw new ValidationError(`Exchange rate must be a positive number, got: ${rate}`, { rate });
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience functional utilities
// ---------------------------------------------------------------------------

/**
 * Pure arithmetic currency converter.
 */
export function convertCurrency(
  amount: number,
  rate: number,
  precision?: number,
): number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new ValidationError("amount must be a non-negative finite number", { amount });
  }
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new ValidationError("rate must be a positive finite number", { rate });
  }
  const result = amount * rate;
  return precision !== undefined ? Number(result.toFixed(precision)) : result;
}

// ---------------------------------------------------------------------------
// Legacy display-only oracle conversion (backward-compatibility)
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_TTL_MS = 10_000;
const rateCachesByOracle = new Map<string, RateCache<bigint>>();

function getRateCache(
  oracleAddress: string,
  server: SorobanRpc.Server,
  networkPassphrase: string,
  ttlMs: number,
): RateCache<bigint> {
  let cache = rateCachesByOracle.get(oracleAddress);
  if (!cache) {
    cache = new RateCache<bigint>(
      (from, to) => fetchOraclePrice(from, to, oracleAddress, server, networkPassphrase),
      { ttlMs },
    );
    rateCachesByOracle.set(oracleAddress, cache);
  }
  return cache;
}

export function clearPriceCache(): void {
  for (const cache of rateCachesByOracle.values()) {
    cache.stop();
    cache.invalidateAll();
  }
  rateCachesByOracle.clear();
}

async function fetchOraclePrice(
  fromToken: string,
  toDisplayCurrency: string,
  oracleAddress: string,
  server: SorobanRpc.Server,
  networkPassphrase: string,
): Promise<bigint> {
  const contract = new Contract(oracleAddress);
  const operation = contract.call(
    "get_price",
    nativeToScVal(fromToken, { type: "symbol" }),
    nativeToScVal(toDisplayCurrency, { type: "symbol" }),
  );

  const sourceAccount = {
    accountId: () => oracleAddress,
    sequenceNumber: () => "0",
    incrementSequenceNumber: () => {},
  } as any;

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new OraclePriceError(`Oracle simulation failed: ${simResult.error}`);
  }

  const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!returnVal) throw new NoReturnValueError("oracle get_price");

  return BigInt(scValToNative(returnVal));
}

export async function convertAmount(
  amount: bigint,
  fromToken: string,
  toDisplayCurrency: string,
  oracleAddress: string,
  server: SorobanRpc.Server,
  networkPassphrase: string,
  priceCacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
): Promise<ConvertedAmount> {
  const cache = getRateCache(oracleAddress, server, networkPassphrase, priceCacheTtlMs);
  const rate = await cache.getRate(fromToken, toDisplayCurrency);

  // rate is assumed to be in fixed-point with 18 decimals (1e18 = 1.0)
  const converted = (amount * rate) / 1_000_000_000_000_000_000n;

  return {
    original: amount,
    converted,
    rate,
    fromToken,
    toDisplayCurrency,
  };
}

export async function convertFiatToAsset(
  fiatAmount: number,
  fiatCurrency: string,
  assetCode: string,
  oracle: PriceOracleAdapter,
): Promise<FiatConversion> {
  const rate = await oracle.getPrice(assetCode, fiatCurrency);
  if (!(rate > 0)) {
    throw new OraclePriceError(`Invalid oracle rate for ${assetCode}/${fiatCurrency}: ${rate}`);
  }

  return {
    fiatAmount,
    fiatCurrency,
    assetAmount: fiatAmount / rate,
    assetCode,
    rate,
  };
}