/**
 * Staking integration for yield generation.
 *
 * Models staking pools and user positions, calculates yield, and provides
 * staking / unstaking flows with reward tracking and analytics.
 */

export interface StakingPool {
  /** Unique pool identifier. */
 id: string;
  /** Human readable pool name. */
  name: string;
  /** Token symbol that is staked. */
  token: string;
  /** Annual percentage yield, expressed as a decimal (e.g. 0.12 = 12%). */
  apy: number;
  /** Minimum amount that can be staked. */
  minStake: number;
  /** Optional lock-up period in seconds. 0 means no lock-up. */
  lockupSeconds: number;
}

export interface StakingPosition {
  poolId: string;
  /** Amount of tokens currently staked. */
  staked: number;
  /** Accrued but unclaimed rewards. */
  rewards: number;
  /** Unix timestamp (ms) when the position was opened. */
  stakedAt: number;
  /** Unix timestamp (ms) of the last reward accrual. */
  lastAccruedAt: number;
}

export interface StakingAnalytics {
  poolId: string;
  staked: number;
  rewards: number;
  /** Estimated rewards per year based on current stake and APY. */
  projectedAnnualYield: number;
  /** Seconds remaining until the position can be unstaked (0 if unlocked). */
  lockupRemainingSeconds: number;
}

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/**
 * Calculate yield accrued over a period for a given principal and APY.
 * Uses simple (non-compounding) interest, which is the common model for
 * staking reward accrual.
 */
export function calculateYield(
  principal: number,
  apy: number,
  elapsedMs: number,
): number {
  if (principal <= 0 || apy <= 0 || elapsedMs <= 0) {
    return 0;
  }
  return principal * apy * (elapsedMs / MS_PER_YEAR);
}

/**
 * In-memory staking manager. Tracks pools and positions and exposes the
 * staking / unstaking flows plus reward tracking and analytics.
 */
export class StakingManager {
  private readonly pools = new Map<string, StakingPool>();
  private readonly positions = new Map<string, StakingPosition>();

  constructor(pools: StakingPool[] = []) {
    for (const pool of pools) {
      this.pools.set(pool.id, pool);
    }
  }

  /** Register a staking pool. */
  addPool(pool: StakingPool): void {
    this.pools.set(pool.id, pool);
  }

  /** Retrieve a pool by id. */
  getPool(poolId: string): StakingPool | undefined {
    return this.pools.get(poolId);
  }

  /** Retrieve the current position for a pool, if any. */
  getPosition(poolId: string): StakingPosition | undefined {
    return this.positions.get(poolId);
  }

  /**
   * Stake tokens into a pool. Accrues any pending rewards on an existing
   * position before increasing the staked amount.
   */
  stake(poolId: string, amount: number, now: number = Date.now()): StakingPosition {
    const pool = this.requirePool(poolId);
    if (amount <= 0) {
      throw new Error('Stake amount must be greater than zero');
    }

    const existing = this.positions.get(poolId);
    if (!existing) {
      if (amount < pool.minStake) {
        throw new Error(`Amount below minimum stake of ${pool.minStake}`);
      }
      const position: StakingPosition = {
        poolId,
        staked: amount,
        rewards: 0,
        stakedAt: now,
        lastAccruedAt: now,
      };
      this.positions.set(poolId, position);
      return { ...position };
    }

    this.accrue(existing, pool, now);
    existing.staked += amount;
    return { ...existing };
  }

  /**
   * Unstake tokens from a pool. Accrues pending rewards, then withdraws the
   * requested amount (or the full stake when amount is omitted).
   */
  unstake(poolId: string, amount?: number, now: number = Date.now()): StakingPosition {
    const pool = this.requirePool(poolId);
    const position = this.positions.get(poolId);
    if (!position) {
      throw new Error(`No staking position for pool ${poolId}`);
    }

    this.accrue(position, pool, now);

    const lockupRemaining = this.lockupRemaining(position, pool, now);
    if (lockupRemaining > 0) {
      throw new Error(`Position locked for another ${lockupRemaining} seconds`);
    }

    const withdraw = amount === undefined ? position.staked : amount;
    if (withdraw <= 0) {
      throw new Error('Unstake amount must be greater than zero');
    }
    if (withdraw > position.staked) {
      throw new Error('Unstake amount exceeds staked balance');
    }

    position.staked -= withdraw;
    if (position.staked === 0) {
      this.positions.delete(poolId);
    }
    return { ...position };
  }

  /** Claim accrued rewards without unstaking. */
  claimRewards(poolId: string, now: number = Date.now()): number {
    const pool = this.requirePool(poolId);
    const position = this.positions.get(poolId);
    if (!position) {
      throw new Error(`No staking position for pool ${poolId}`);
    }
    this.accrue(position, pool, now);
    const claimed = position.rewards;
    position.rewards = 0;
    return claimed;
  }

  /** Compute analytics for a pool position. */
  getAnalytics(poolId: string, now: number = Date.now()): StakingAnalytics {
    const pool = this.requirePool(poolId);
    const position = this.positions.get(poolId);
    if (!position) {
      return {
        poolId,
        staked: 0,
        rewards: 0,
        projectedAnnualYield: 0,
        lockupRemainingSeconds: 0,
      };
    }

    const accrued = calculateYield(position.staked, pool.apy, now - position.lastAccruedAt);
    return {
      poolId,
      staked: position.staked,
      rewards: position.rewards + accrued,
      projectedAnnualYield: position.staked * pool.apy,
      lockupRemainingSeconds: this.lockupRemaining(position, pool, now),
    };
  }

  private requirePool(poolId: string): StakingPool {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error(`Unknown staking pool ${poolId}`);
    }
    return pool;
  }

  private accrue(position: StakingPosition, pool: StakingPool, now: number): void {
    if (now <= position.lastAccruedAt) {
      return;
    }
    position.rewards += calculateYield(
      position.staked,
      pool.apy,
      now - position.lastAccruedAt,
    );
    position.lastAccruedAt = now;
  }

  private lockupRemaining(position: StakingPosition, pool: StakingPool, now: number): number {
    if (pool.lockupSeconds <= 0) {
      return 0;
    }
    const unlockAt = position.stakedAt + pool.lockupSeconds * 1000;
    return Math.max(0, Math.ceil((unlockAt - now) / 1000));
  }
}
