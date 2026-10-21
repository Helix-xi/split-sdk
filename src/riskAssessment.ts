export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskSubject {
  id: string;
  type: string;
  attributes: Readonly<Record<string, unknown>>;
}

export interface RiskRuleResult {
  /** Normalized risk contribution in the range [0, 1]. */
  score: number;
  reason: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface RiskRule {
  id: string;
  /** Relative contribution of this rule to the combined score. Must be > 0. */
  weight: number;
  assess(subject: RiskSubject, context: RiskRuleContext): RiskRuleResult | null;
}

export interface RiskRuleContext {
  now: number;
}

export interface RiskFactor {
  id: string;
  weight: number;
  score: number;
  reason: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface RiskAssessmentResult {
  subject: RiskSubject;
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
  assessedAt: number;
}

export interface RiskAssessmentOptions {
  rules?: readonly RiskRule[];
  /** Inclusive score at which the medium risk band begins. Default: 0.3. */
  mediumThreshold?: number;
  /** Inclusive score at which the high risk band begins. Default: 0.6. */
  highThreshold?: number;
  /** Inclusive score at which the critical risk band begins. Default: 0.85. */
  criticalThreshold?: number;
  now?: () => number;
}

export interface RiskAssessmentEventMap {
  assessed: RiskAssessmentResult;
  highRisk: RiskAssessmentResult;
}

type RiskAssessmentEvent = keyof RiskAssessmentEventMap;
type RiskAssessmentListener = (assessment: RiskAssessmentResult) => void;

/**
 * Combines application-defined risk rules into a normalized, explainable score.
 * Rule scores and thresholds use [0, 1]; weights are relative, not percentages.
 */
export class RiskAssessmentEngine {
  private readonly rules: readonly RiskRule[];
  private readonly mediumThreshold: number;
  private readonly highThreshold: number;
  private readonly criticalThreshold: number;
  private readonly now: () => number;
  private readonly listeners = new Map<RiskAssessmentEvent, Set<RiskAssessmentListener>>();

  constructor(options: RiskAssessmentOptions = {}) {
    this.rules = options.rules ?? [];
    this.mediumThreshold = options.mediumThreshold ?? 0.3;
    this.highThreshold = options.highThreshold ?? 0.6;
    this.criticalThreshold = options.criticalThreshold ?? 0.85;
    this.now = options.now ?? Date.now;

    if (
      !Number.isFinite(this.mediumThreshold) ||
      !Number.isFinite(this.highThreshold) ||
      !Number.isFinite(this.criticalThreshold) ||
      this.mediumThreshold < 0 ||
      this.mediumThreshold >= this.highThreshold ||
      this.highThreshold >= this.criticalThreshold ||
      this.criticalThreshold > 1
    ) {
      throw new RangeError("Risk thresholds must satisfy 0 <= medium < high < critical <= 1");
    }

    const ids = new Set<string>();
    for (const rule of this.rules) {
      if (!rule.id.trim() || ids.has(rule.id)) {
        throw new TypeError("Risk rule IDs must be non-empty and unique");
      }
      if (!Number.isFinite(rule.weight) || rule.weight <= 0) {
        throw new RangeError(`Risk rule weight must be positive and finite: ${rule.id}`);
      }
      ids.add(rule.id);
    }
  }

  assess(subject: RiskSubject): RiskAssessmentResult {
    if (!subject.id.trim() || !subject.type.trim()) {
      throw new TypeError("Risk subject id and type must be non-empty");
    }

    const assessedAt = this.now();
    if (!Number.isFinite(assessedAt)) {
      throw new RangeError("Risk assessment clock must return a finite number");
    }

    const factors: RiskFactor[] = [];
    const context = { now: assessedAt };
    for (const rule of this.rules) {
      const result = rule.assess(subject, context);
      if (result === null) continue;
      if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1) {
        throw new RangeError(`Risk rule score must be in [0, 1]: ${rule.id}`);
      }
      factors.push({
        id: rule.id,
        weight: rule.weight,
        score: result.score,
        reason: result.reason,
        ...(result.details ? { details: result.details } : {}),
      });
    }

    const totalWeight = factors.reduce((total, factor) => total + factor.weight, 0);
    const score = totalWeight === 0
      ? 0
      : factors.reduce((total, factor) => total + factor.score * factor.weight, 0) / totalWeight;
    const level = this.classify(score);
    const assessment: RiskAssessmentResult = {
      subject,
      score,
      level,
      factors,
      assessedAt,
    };

    this.emit("assessed", assessment);
    if (level === "high" || level === "critical") this.emit("highRisk", assessment);
    return assessment;
  }

  on<K extends RiskAssessmentEvent>(
    event: K,
    listener: (assessment: RiskAssessmentEventMap[K]) => void,
  ): () => void {
    const listeners = this.listeners.get(event) ?? new Set<RiskAssessmentListener>();
    listeners.add(listener as RiskAssessmentListener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener as RiskAssessmentListener);
  }

  off<K extends RiskAssessmentEvent>(
    event: K,
    listener: (assessment: RiskAssessmentEventMap[K]) => void,
  ): void {
    this.listeners.get(event)?.delete(listener as RiskAssessmentListener);
  }

  private emit(event: RiskAssessmentEvent, assessment: RiskAssessmentResult): void {
    for (const listener of this.listeners.get(event) ?? []) listener(assessment);
  }

  private classify(score: number): RiskLevel {
    if (score >= this.criticalThreshold) return "critical";
    if (score >= this.highThreshold) return "high";
    if (score >= this.mediumThreshold) return "medium";
    return "low";
  }
}