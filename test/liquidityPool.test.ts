import { describe, it, expect } from 'vitest';
import {
  LiquidityPoolClient,
  calculateSwapOutput,
  calculatePriceImpactBps,
  type LiquidityPool,
} from '../src/liquidityPool';

const makePool = (overrides: Partial<LiquidityPool> = {}): LiquidityPool => ({
  id: 'pool-abc',
  fee: 30, // 0.3%
  assetA: { code: 'XLM', amount: 1_000_000_000n },
  assetB: { code: 'USDC', amount: 500_000_000n },
  totalShares: 700_000_000n,
  lastUpdatedLedger: 12345,
  ...overrides,
});

describe('calculateSwapOutput', () => {
  it('returns positive output for valid inputs', () => {
    const out = calculateSwapOutput(1_000_000n, 1_000_000_000n, 500_000_000n, 30);
    expect(out).toBeGreaterThan(0n);
  });

  it('throws for zero input amount', () => {
    expect(() => calculateSwapOutput(0n, 1_000n, 1_000n, 30)).toThrow();
  });

  it('throws for zero reserves', () => {
    expect(() => calculateSwapOutput(100n, 0n, 1_000n, 30)).toThrow();
  });

  it('throws for invalid fee bps', () => {
    expect(() => calculateSwapOutput(100n, 1_000n, 1_000n, 10000)).toThrow();
  });

  it('higher fee results in less output', () => {
    const low = calculateSwapOutput(1_000_000n, 1_000_000_000n, 500_000_000n, 10);
    const high = calculateSwapOutput(1_000_000n, 1_000_000_000n, 500_000_000n, 100);
    expect(low).toBeGreaterThan(high);
  });
});

describe('calculatePriceImpactBps', () => {
  it('returns 0 for zero amounts', () => {
    expect(calculatePriceImpactBps(0n, 0n, 1000n, 1000n)).toBe(0);
  });

  it('large trade has higher impact than small trade', () => {
    const small = calculatePriceImpactBps(1_000n, 100_000n, 1_000_000n, 1_000_000n);
    const large = calculatePriceImpactBps(500_000n, 100_000n, 1_000_000n, 1_000_000n);
    expect(large).toBeGreaterThanOrEqual(small);
  });
});

describe('LiquidityPoolClient', () => {
  it('registers and retrieves a pool', () => {
    const client = new LiquidityPoolClient();
    const pool = makePool();
    client.registerPool(pool);
    expect(client.getPool('pool-abc')).toEqual(pool);
  });

  it('listPoolIds returns registered pool IDs', () => {
    const client = new LiquidityPoolClient();
    client.registerPool(makePool({ id: 'pool-1' }));
    client.registerPool(makePool({ id: 'pool-2' }));
    expect(client.listPoolIds()).toContain('pool-1');
    expect(client.listPoolIds()).toContain('pool-2');
  });

  it('estimateSwap returns valid estimate', () => {
    const client = new LiquidityPoolClient();
    client.registerPool(makePool());
    const est = client.estimateSwap('pool-abc', 'A', 1_000_000n);
    expect(est.outputAmount).toBeGreaterThan(0n);
    expect(est.fee).toBeGreaterThan(0n);
    expect(est.inputAsset).toBe('XLM');
    expect(est.outputAsset).toBe('USDC');
  });

  it('estimateSwap throws for unknown pool', () => {
    const client = new LiquidityPoolClient();
    expect(() => client.estimateSwap('no-pool', 'A', 100n)).toThrow('not found');
  });

  it('estimateSwap throws for high price impact', () => {
    const client = new LiquidityPoolClient({ maxPriceImpactBps: 1 });
    client.registerPool(makePool());
    // Very large trade will trigger price impact
    expect(() => client.estimateSwap('pool-abc', 'A', 900_000_000n)).toThrow();
  });

  it('estimateSwap throws when pool below liquidity threshold', () => {
    const client = new LiquidityPoolClient({ minLiquidityThreshold: 10_000_000_000n });
    client.registerPool(makePool());
    expect(() => client.estimateSwap('pool-abc', 'A', 1000n)).toThrow('liquidity');
  });

  it('simulateDeposit returns positive shares for initial deposit', () => {
    const client = new LiquidityPoolClient();
    client.registerPool(makePool({ totalShares: 0n }));
    const result = client.simulateDeposit('pool-abc', 1_000_000n, 500_000n);
    expect(result.sharesIssued).toBeGreaterThan(0n);
  });

  it('simulateDeposit returns pro-rata shares for existing pool', () => {
    const client = new LiquidityPoolClient();
    client.registerPool(makePool());
    const result = client.simulateDeposit('pool-abc', 100_000_000n, 50_000_000n);
    expect(result.sharesIssued).toBeGreaterThan(0n);
  });

  it('simulateWithdraw returns correct amounts', () => {
    const client = new LiquidityPoolClient();
    client.registerPool(makePool());
    const result = client.simulateWithdraw('pool-abc', 350_000_000n); // 50% of shares
    expect(result.receivedA).toBe(500_000_000n);
    expect(result.receivedB).toBe(250_000_000n);
  });

  it('simulateWithdraw throws for excessive shares', () => {
    const client = new LiquidityPoolClient();
    client.registerPool(makePool());
    expect(() => client.simulateWithdraw('pool-abc', 9_999_999_999n)).toThrow('exceed');
  });
});
