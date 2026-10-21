export interface PaymentRouteCandidate {
  id: string;
  fee: number;
  successProbability: number;
  latencyMs: number;
  liquidity: number;
  path?: readonly string[];
}

export interface PaymentRouteWeights {
  fee: number;
  reliability: number;
  latency: number;
  liquidity: number;
}

export interface PaymentRouteConstraints {
  maxFee?: number;
  minSuccessProbability?: number;
  maxLatencyMs?: number;
  minLiquidity?: number;
}

export interface PaymentRouteOptimizerOptions {
  weights?: Partial<PaymentRouteWeights>;
  constraints?: PaymentRouteConstraints;
}

export interface ScoredPaymentRoute extends PaymentRouteCandidate {
  score: number;
  componentScores: PaymentRouteWeights;
}

export interface RejectedPaymentRoute {
  id: string;
  reason: string;
}

export interface PaymentRouteOptimization {
  ranked: ScoredPaymentRoute[];
  recommended: ScoredPaymentRoute | null;
  rejected: RejectedPaymentRoute[];
  evaluatedCount: number;
}

export interface PaymentRouteOptimizerEvents {
  optimized: PaymentRouteOptimization;
  error: Error;
}

type PaymentRouteOptimizerEvent = keyof PaymentRouteOptimizerEvents;
type PaymentRouteOptimizerListener = (payload: PaymentRouteOptimization | Error) => void;

const DEFAULT_WEIGHTS: PaymentRouteWeights = {
  fee: 0.3,
  reliability: 0.35,
  latency: 0.15,
  liquidity: 0.2,
};

/** Ranks feasible payment routes across cost, reliability, latency, and depth. */
export class PaymentRouteOptimizer {
  private readonly weights: PaymentRouteWeights;
  private readonly constraints: PaymentRouteConstraints;
  private readonly listeners = new Map<PaymentRouteOptimizerEvent, Set<PaymentRouteOptimizerListener>>();

  constructor(options: PaymentRouteOptimizerOptions = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    this.constraints = options.constraints ?? {};

    const weightTotal = Object.values(this.weights).reduce((sum, weight) => sum + weight, 0);
    if (
      Object.values(this.weights).some((weight) => !Number.isFinite(weight) || weight < 0) ||
      weightTotal <= 0
    ) {
      throw new RangeError("Route weights must be finite, non-negative, and have a positive total");
    }
    this.validateConstraints();
  }

  on<K extends PaymentRouteOptimizerEvent>(
    event: K,
    listener: (payload: PaymentRouteOptimizerEvents[K]) => void,
  ): () => void {
    const listeners = this.listeners.get(event) ?? new Set<PaymentRouteOptimizerListener>();
    listeners.add(listener as PaymentRouteOptimizerListener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener as PaymentRouteOptimizerListener);
  }

  optimize(candidates: readonly PaymentRouteCandidate[]): PaymentRouteOptimization {
    try {
      this.validateCandidates(candidates);
      const rejected: RejectedPaymentRoute[] = [];
      const eligible = candidates.filter((candidate) => {
        const reason = this.rejectionReason(candidate);
        if (reason) rejected.push({ id: candidate.id, reason });
        return reason === null;
      });

      const ranges = this.ranges(eligible);
      const ranked = eligible
        .map((candidate, index) => ({ candidate, index }))
        .map(({ candidate, index }) => {
          const componentScores = {
            fee: this.normalized(candidate.fee, ranges.fee, false),
            reliability: candidate.successProbability,
            latency: this.normalized(candidate.latencyMs, ranges.latencyMs, false),
            liquidity: this.normalized(candidate.liquidity, ranges.liquidity, true),
          };
          const totalWeight = Object.values(this.weights).reduce((sum, weight) => sum + weight, 0);
          const score = Object.entries(this.weights).reduce(
            (sum, [component, weight]) =>
              sum + componentScores[component as keyof PaymentRouteWeights] * weight,
            0,
          ) / totalWeight;
          return { candidate: { ...candidate, score, componentScores }, index };
        })
        .sort((left, right) => right.candidate.score - left.candidate.score || left.index - right.index)
        .map(({ candidate }) => candidate);

      const result: PaymentRouteOptimization = {
        ranked,
        recommended: ranked[0] ?? null,
        rejected,
        evaluatedCount: candidates.length,
      };
      this.emit("optimized", result);
      return result;
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.emit("error", normalizedError);
      throw normalizedError;
    }
  }

  private validateConstraints(): void {
    const { maxFee, minSuccessProbability, maxLatencyMs, minLiquidity } = this.constraints;
    if (maxFee !== undefined && (!Number.isFinite(maxFee) || maxFee < 0)) {
      throw new RangeError("maxFee must be finite and non-negative");
    }
    if (
      minSuccessProbability !== undefined &&
      (!Number.isFinite(minSuccessProbability) || minSuccessProbability < 0 || minSuccessProbability > 1)
    ) {
      throw new RangeError("minSuccessProbability must be in [0, 1]");
    }
    if (maxLatencyMs !== undefined && (!Number.isFinite(maxLatencyMs) || maxLatencyMs < 0)) {
      throw new RangeError("maxLatencyMs must be finite and non-negative");
    }
    if (minLiquidity !== undefined && (!Number.isFinite(minLiquidity) || minLiquidity < 0)) {
      throw new RangeError("minLiquidity must be finite and non-negative");
    }
  }

  private validateCandidates(candidates: readonly PaymentRouteCandidate[]): void {
    const ids = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate.id.trim() || ids.has(candidate.id)) {
        throw new TypeError("Route candidate IDs must be non-empty and unique");
      }
      if (
        !Number.isFinite(candidate.fee) || candidate.fee < 0 ||
        !Number.isFinite(candidate.successProbability) || candidate.successProbability < 0 || candidate.successProbability > 1 ||
        !Number.isFinite(candidate.latencyMs) || candidate.latencyMs < 0 ||
        !Number.isFinite(candidate.liquidity) || candidate.liquidity < 0
      ) {
        throw new RangeError(`Route candidate metrics are invalid: ${candidate.id}`);
      }
      ids.add(candidate.id);
    }
  }

  private rejectionReason(candidate: PaymentRouteCandidate): string | null {
    const { maxFee, minSuccessProbability, maxLatencyMs, minLiquidity } = this.constraints;
    if (maxFee !== undefined && candidate.fee > maxFee) return "fee exceeds maxFee";
    if (minSuccessProbability !== undefined && candidate.successProbability < minSuccessProbability) {
      return "success probability is below minSuccessProbability";
    }
    if (maxLatencyMs !== undefined && candidate.latencyMs > maxLatencyMs) return "latency exceeds maxLatencyMs";
    if (minLiquidity !== undefined && candidate.liquidity < minLiquidity) return "liquidity is below minLiquidity";
    return null;
  }

  private ranges(candidates: readonly PaymentRouteCandidate[]) {
    const range = (values: number[]) => ({ min: Math.min(...values), max: Math.max(...values) });
    return {
      fee: range(candidates.map((candidate) => candidate.fee)),
      latencyMs: range(candidates.map((candidate) => candidate.latencyMs)),
      liquidity: range(candidates.map((candidate) => candidate.liquidity)),
    };
  }

  private normalized(value: number, range: { min: number; max: number }, higherIsBetter: boolean): number {
    if (range.max === range.min) return 1;
    const score = (value - range.min) / (range.max - range.min);
    return higherIsBetter ? score : 1 - score;
  }

  private emit<K extends PaymentRouteOptimizerEvent>(
    event: K,
    payload: PaymentRouteOptimizerEvents[K],
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload as PaymentRouteOptimization | Error);
    }
  }
}