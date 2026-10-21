/**
 * Liquidity Pool Integration for StellarSplit SDK.
 *
 * Provides utilities to query Stellar AMM liquidity pool state,
 * calculate swap estimates, and manage pool participation.
 */

export interface LiquidityPoolAsset {
  code: string;
  issuer?: string;
  amount: bigint;
}

export interface LiquidityPool {
  id: string;
  fee: number; // basis points, e.g. 30 = 0.3%
  assetA: LiquidityPoolAsset;
  assetB: LiquidityPoolAsset;
  totalShares: bigint;
  lastUpdatedLedger: number;
}

export interface SwapEstimate {
  poolId: string;
  inputAsset: string;
  outputAsset: string;
  inputAmount: bigint;
  outputAmount: bigint;
  priceImpactBps: number;
  fee: bigint;
}

export interface PoolDepositResult {
  poolId: string;
  sharesIssued: bigint;
  depositedA: bigint;
  depositedB: bigint;
}

export interface PoolWithdrawResult {
  poolId: string;
  sharesRedeemed: bigint;
  receivedA: bigint;
  receivedB: bigint;
}

export interface LiquidityPoolClientOptions {
  /** Minimum liquidity (in stroops) required to consider a pool valid */
  minLiquidityThreshold?: bigint;
  /** Maximum price impact in basis points before the client warns */
  maxPriceImpactBps?: number;
}

/** Constant-product AMM invariant: k = reserveA * reserveB */
function invariant(reserveA: bigint, reserveB: bigint): bigint {
  return reserveA * reserveB;
}

/**
 * Calculate the output amount for a constant-product AMM swap.
 * Formula: outputAmount = (reserveOut * inputAmount * (10000 - feeBps)) /
 *                         (reserveIn * 10000 + inputAmount * (10000 - feeBps))
 */
export function calculateSwapOutput(
  inputAmount: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number
): bigint {
  if (inputAmount <= 0n) throw new RangeError('inputAmount must be positive');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new RangeError('reserves must be positive');
  if (feeBps < 0 || feeBps >= 10000) throw new RangeError('feeBps must be in [0, 10000)');

  const feeMultiplier = BigInt(10000 - feeBps);
  const numerator = reserveOut * inputAmount * feeMultiplier;
  const denominator = reserveIn * 10000n + inputAmount * feeMultiplier;
  return numerator / denominator;
}

/**
 * Calculate the price impact of a swap as basis points.
 * Price impact = ((spotPrice - executionPrice) / spotPrice) * 10000
 */
export function calculatePriceImpactBps(
  inputAmount: bigint,
  outputAmount: bigint,
  reserveIn: bigint,
  reserveOut: bigint
): number {
  if (inputAmount <= 0n || outputAmount <= 0n) return 0;
  // Spot price: reserveOut / reserveIn (in units of outputAsset per inputAsset)
  // Execution price: outputAmount / inputAmount
  // Impact = (spotPrice - executionPrice) / spotPrice
  const spotNumerator = reserveOut * inputAmount * 10000n;
  const spotDenominator = reserveIn * outputAmount;
  if (spotDenominator === 0n) return 0;
  const impactBps = spotNumerator / spotDenominator;
  const result = Number(impactBps) - 10000;
  return Math.max(0, result);
}

/**
 * LiquidityPoolClient manages interactions with Stellar AMM liquidity pools.
 */
export class LiquidityPoolClient {
  private readonly pools = new Map<string, LiquidityPool>();
  private readonly options: Required<LiquidityPoolClientOptions>;

  constructor(options: LiquidityPoolClientOptions = {}) {
    this.options = {
      minLiquidityThreshold: options.minLiquidityThreshold ?? 1_000_000n,
      maxPriceImpactBps: options.maxPriceImpactBps ?? 200,
    };
  }

  /**
   * Register a pool with the client (e.g. populated from Horizon).
   */
  registerPool(pool: LiquidityPool): void {
    this.pools.set(pool.id, pool);
  }

  /**
   * Retrieve a registered pool by ID.
   */
  getPool(poolId: string): LiquidityPool | undefined {
    return this.pools.get(poolId);
  }

  /**
   * List all registered pool IDs.
   */
  listPoolIds(): string[] {
    return Array.from(this.pools.keys());
  }

  /**
   * Estimate the output of swapping inputAmount of assetA for assetB in the given pool.
   * Throws if pool not found or liquidity is below threshold.
   */
  estimateSwap(poolId: string, inputAsset: 'A' | 'B', inputAmount: bigint): SwapEstimate {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error(`Pool ${poolId} not found`);

    const [reserveIn, reserveOut, inCode, outCode] =
      inputAsset === 'A'
        ? [pool.assetA.amount, pool.assetB.amount, pool.assetA.code, pool.assetB.code]
        : [pool.assetB.amount, pool.assetA.amount, pool.assetB.code, pool.assetA.code];

    const totalLiquidity = pool.assetA.amount + pool.assetB.amount;
    if (totalLiquidity < this.options.minLiquidityThreshold) {
      throw new Error(`Pool ${poolId} liquidity ${totalLiquidity} below threshold ${this.options.minLiquidityThreshold}`);
    }

    const outputAmount = calculateSwapOutput(inputAmount, reserveIn, reserveOut, pool.fee);
    const priceImpactBps = calculatePriceImpactBps(inputAmount, outputAmount, reserveIn, reserveOut);
    const feeAmount = (inputAmount * BigInt(pool.fee)) / 10000n;

    if (priceImpactBps > this.options.maxPriceImpactBps) {
      throw new Error(
        `Price impact ${priceImpactBps} bps exceeds maximum allowed ${this.options.maxPriceImpactBps} bps for pool ${poolId}`
      );
    }

    return {
      poolId,
      inputAsset: inCode,
      outputAsset: outCode,
      inputAmount,
      outputAmount,
      priceImpactBps,
      fee: feeAmount,
    };
  }

  /**
   * Simulate a deposit into the pool, returning the shares issued.
   * Amounts are deposited proportional to pool reserves.
   */
  simulateDeposit(
    poolId: string,
    amountA: bigint,
    amountB: bigint
  ): PoolDepositResult {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error(`Pool ${poolId} not found`);
    if (amountA <= 0n || amountB <= 0n) throw new RangeError('deposit amounts must be positive');

    let sharesIssued: bigint;
    if (pool.totalShares === 0n) {
      // Initial deposit: shares = sqrt(amountA * amountB)
      sharesIssued = bigintSqrt(amountA * amountB);
    } else {
      // Pro-rata shares: min of both sides
      const sharesA = (amountA * pool.totalShares) / pool.assetA.amount;
      const sharesB = (amountB * pool.totalShares) / pool.assetB.amount;
      sharesIssued = sharesA < sharesB ? sharesA : sharesB;
    }

    return { poolId, sharesIssued, depositedA: amountA, depositedB: amountB };
  }

  /**
   * Simulate a withdrawal, returning the amounts received.
   */
  simulateWithdraw(poolId: string, shares: bigint): PoolWithdrawResult {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error(`Pool ${poolId} not found`);
    if (shares <= 0n) throw new RangeError('shares must be positive');
    if (shares > pool.totalShares) throw new RangeError('shares exceed total supply');

    const receivedA = (shares * pool.assetA.amount) / pool.totalShares;
    const receivedB = (shares * pool.assetB.amount) / pool.totalShares;

    return { poolId, sharesRedeemed: shares, receivedA, receivedB };
  }
}

/** Integer square root for bigint */
function bigintSqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('sqrt of negative');
  if (n === 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
