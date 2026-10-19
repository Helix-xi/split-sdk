/**
 * SDK price oracle integration helpers.
 *
 * Provides a small, dependency-free abstraction for fetching and parsing
 * oracle prices, plus an event emitter for price updates.
 */

export interface OraclePrice {
  /** Asset symbol, e.g. "XLM" or "USDC". */
  symbol: string;
  /** Price expressed in the oracle's quote currency. */
  price: number;
  /** Unix timestamp (ms) when the price was observed. */
  timestamp: number;
}

/**
 * Minimal shape of a raw oracle response. Real oracles vary, so we accept a
 * permissive record and normalize it in {@link parseOraclePrice}.
 */
export type RawOracleResponse = Record<string, unknown>;

/**
 * Fetches a raw price payload for a symbol. Implementations may hit an HTTP
 * endpoint, a contract, or a cache.
 */
export type OracleFetcher = (symbol: string) => Promise<RawOracleResponse>;

export type PriceUpdateListener = (price: OraclePrice) => void;

/**
 * Parse a raw oracle response into a normalized {@link OraclePrice}.
 *
 * Accepts common field aliases (`price`/`value`/`amount`, `timestamp`/`time`)
 * and throws when a usable numeric price cannot be found.
 */
export function parseOraclePrice(
  symbol: string,
  raw: RawOracleResponse,
): OraclePrice {
  const rawPrice = raw.price ?? raw.value ?? raw.amount;
  const price = typeof rawPrice === "string" ? Number(rawPrice) : rawPrice;

  if (typeof price !== "number" || !Number.isFinite(price)) {
    throw new Error(`Invalid oracle price for ${symbol}`);
  }

  const rawTimestamp = raw.timestamp ?? raw.time ?? raw.updatedAt;
  const timestamp =
    typeof rawTimestamp === "number"
      ? rawTimestamp
      : typeof rawTimestamp === "string"
        ? Date.parse(rawTimestamp)
        : Date.now();

  return {
    symbol,
    price,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
  };
}

export interface PriceOracleClientInstance {
  onPriceUpdate(listener: PriceUpdateListener): () => void;
  getCachedPrice(symbol: string): OraclePrice | undefined;
  fetchPrice(symbol: string): Promise<OraclePrice>;
  fetchPrices(symbols: string[]): Promise<OraclePrice[]>;
}

export interface PriceOracleConstructor {
  new (fetcher: OracleFetcher): PriceOracleClientInstance;
}

/**
 * Price oracle client that fetches, parses, and emits price updates.
 */
export class PriceOracleClient implements PriceOracleClientInstance {
  private readonly fetcher: OracleFetcher;
  private readonly listeners = new Set<PriceUpdateListener>();
  private readonly cache = new Map<string, OraclePrice>();

  constructor(fetcher: OracleFetcher) {
    this.fetcher = fetcher;
  }

  /** Subscribe to price updates. Returns an unsubscribe function. */
  onPriceUpdate(listener: PriceUpdateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Return the last cached price for a symbol, if any. */
  getCachedPrice(symbol: string): OraclePrice | undefined {
    return this.cache.get(symbol);
  }

  /**
   * Fetch and parse the current price for a symbol, caching the result and
   * notifying listeners.
   */
  async fetchPrice(symbol: string): Promise<OraclePrice> {
    const raw = await this.fetcher(symbol);
    const price = parseOraclePrice(symbol, raw);
    this.cache.set(symbol, price);
    this.emit(price);
    return price;
  }

  /** Fetch prices for multiple symbols, preserving input order. */
  async fetchPrices(symbols: string[]): Promise<OraclePrice[]> {
    return Promise.all(symbols.map((symbol) => this.fetchPrice(symbol)));
  }

  private emit(price: OraclePrice): void {
    for (const listener of this.listeners) {
      listener(price);
    }
  }
}

/** Value constructor for price oracle client helpers. */
export const PriceOracle: PriceOracleConstructor = PriceOracleClient;

import { PriceOracleFetchError, RateLimitError } from "./errors.js";
import { RateCache } from "./rateCache.js";
import type { PriceOracleAdapter } from "./types.js";

/** Default asset-code -> CoinGecko coin-id mapping for common Stellar assets. */
const DEFAULT_COIN_IDS: Record<string, string> = {
  XLM: "stellar",
  USDC: "usd-coin",
};

export interface CoinGeckoPriceOracleOptions {
  /** Override the CoinGecko API base URL (e.g. for a proxy). Default: the public API. */
  apiBaseUrl?: string;
  /** Additional or overriding asset-code -> CoinGecko coin-id mappings. */
  coinIds?: Record<string, string>;
  /** Cache used to avoid redundant requests. Defaults to a private RateCache. */
  cache?: RateCache;
}

/**
 * Fetches fiat/asset conversion rates from CoinGecko's public price API,
 * caching results via {@link RateCache}.
 */
export class CoinGeckoPriceOracle implements PriceOracleAdapter {
  private readonly apiBaseUrl: string;
  private readonly coinIds: Record<string, string>;
  private readonly cache: RateCache;

  constructor(options: CoinGeckoPriceOracleOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.coingecko.com/api/v3";
    this.coinIds = { ...DEFAULT_COIN_IDS, ...options.coinIds };
    this.cache = options.cache ?? new RateCache();
  }

  /**
   * Resolve the price of one unit of `base` denominated in `quote`.
   * `base` may be any key in `coinIds` (defaults include "XLM", "USDC") or a
   * raw CoinGecko coin id; `quote` is a CoinGecko vs_currency code (e.g. "USD").
   */
  async getPrice(base: string, quote: string): Promise<number> {
    const cached = this.cache.get(base, quote);
    if (cached !== undefined) return cached;

    const coinId = this.coinIds[base.toUpperCase()] ?? base.toLowerCase();
    const vsCurrency = quote.toLowerCase();
    const url = `${this.apiBaseUrl}/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=${encodeURIComponent(vsCurrency)}`;

    const response = await fetch(url);

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("retry-after");
      throw new RateLimitError(
        `CoinGecko rate limit exceeded fetching ${base}/${quote}`,
        retryAfterHeader ? Number(retryAfterHeader) : undefined,
      );
    }
    if (!response.ok) {
      throw new PriceOracleFetchError(
        `CoinGecko request failed with status ${response.status} fetching ${base}/${quote}`,
      );
    }

    const payload = (await response.json()) as Record<string, Record<string, number>>;
    const rate = payload?.[coinId]?.[vsCurrency];
    if (typeof rate !== "number") {
      throw new PriceOracleFetchError(`CoinGecko response missing rate for ${base}/${quote}`);
    }

    this.cache.set(base, quote, rate);
    return rate;
  }
}

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { OraclePriceError, NoReturnValueError } from "./errors.js";

/** Resolves a conversion rate between two on-chain assets. */
export interface PriceOracle {
  /**
   * Fixed-point rate (1e18 = 1.0) to convert 1 unit of `fromAsset` into
   * `toAsset`, or `undefined` when no price is available for that pair.
   */
  getRate(fromAsset: string, toAsset: string): Promise<bigint | undefined>;
}

/** Soroban contract-backed price oracle. */
export class ContractPriceOracle implements PriceOracle {
  constructor(
    private readonly server: SorobanRpc.Server,
    private readonly oracleAddress: string,
    private readonly networkPassphrase: string
  ) {}

  async getRate(fromAsset: string, toAsset: string): Promise<bigint | undefined> {
    const contract = new Contract(this.oracleAddress);
    const operation = contract.call(
      "get_price",
      nativeToScVal(fromAsset, { type: "symbol" }),
      nativeToScVal(toAsset, { type: "symbol" })
    );

    const sourceAccount = {
      accountId: () => this.oracleAddress,
      sequenceNumber: () => "0",
      incrementSequenceNumber: () => {},
    } as any;

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      if (/no price|not found|unsupported/i.test(simResult.error)) {
        return undefined;
      }
      throw new OraclePriceError(`Oracle simulation failed: ${simResult.error}`);
    }

    const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
      ?.retval;
    if (!returnVal) throw new NoReturnValueError("oracle get_price");

    return BigInt(scValToNative(returnVal));
  }
}


