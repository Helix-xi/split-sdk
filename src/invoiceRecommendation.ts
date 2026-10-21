/**
 * InvoiceRecommendationEngine — issue #980
 *
 * Analyses a pool of invoices and produces ranked recommendations by
 * applying a set of weighted scoring signals. The engine supports custom
 * signal registration, event callbacks for scoring lifecycle events, and
 * deterministic tie-breaking so results are stable across runs.
 */

import type { Invoice, InvoiceStatus } from "./types.js";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single scoring signal applied to each candidate invoice. */
export interface RecommendationSignal {
  /** Unique name used to identify this signal. */
  name: string;
  /**
   * Weight applied to the signal score (positive number).
   * Higher weight → larger contribution to the final score.
   */
  weight: number;
  /**
   * Score function that returns a value in the range [0, 1].
   * 1 = perfect match, 0 = no match.
   */
  score(invoice: Invoice, context: RecommendationContext): number;
}

/** Contextual information provided to scoring signals. */
export interface RecommendationContext {
  /** Stellar address of the user requesting recommendations. */
  userId: string;
  /** Unix timestamp in seconds representing "now" (defaults to Date.now() / 1000). */
  nowSeconds?: number;
  /** Arbitrary extra data a caller may inject for custom signals. */
  [key: string]: unknown;
}

/** A single recommendation entry with its composite score and per-signal breakdown. */
export interface InvoiceRecommendation {
  invoice: Invoice;
  /** Weighted composite score in the range [0, 1]. */
  score: number;
  /** Per-signal raw scores (before weighting). */
  breakdown: Record<string, number>;
}

/** Options for configuring the recommendation engine. */
export interface RecommendationEngineOptions {
  /**
   * Maximum number of recommendations to return.
   * @default 10
   */
  topK?: number;
  /**
   * Minimum composite score threshold — invoices scoring below this value
   * are excluded from results.
   * @default 0
   */
  minScore?: number;
  /**
   * Statuses that are eligible for recommendation.
   * @default ["Pending"]
   */
  eligibleStatuses?: InvoiceStatus[];
}

/** Events emitted by the recommendation engine. */
export type RecommendationEventMap = {
  /** Fired after all invoices have been scored, before sorting/truncation. */
  scored: InvoiceRecommendation[];
  /** Fired after the final ranked list has been produced. */
  recommended: InvoiceRecommendation[];
  /** Fired when scoring a single invoice throws an error. */
  error: { invoice: Invoice; error: unknown };
};

type RecommendationEventHandler<K extends keyof RecommendationEventMap> = (
  payload: RecommendationEventMap[K]
) => void;

// ---------------------------------------------------------------------------
// Built-in signals
// ---------------------------------------------------------------------------

/**
 * Boost invoices whose deadline is approaching soon.
 * Invoices expiring within 24 h score 1.0, those expiring beyond 7 days score 0.
 */
const urgencySignal: RecommendationSignal = {
  name: "urgency",
  weight: 1.5,
  score(invoice, ctx) {
    const now = ctx.nowSeconds ?? Date.now() / 1000;
    const secondsLeft = invoice.deadline - now;
    if (secondsLeft <= 0) return 0;
    const oneDaySeconds = 86_400;
    const sevenDaySeconds = 604_800;
    if (secondsLeft <= oneDaySeconds) return 1;
    if (secondsLeft >= sevenDaySeconds) return 0;
    // Linear interpolation between 1 day and 7 days
    return 1 - (secondsLeft - oneDaySeconds) / (sevenDaySeconds - oneDaySeconds);
  },
};

/**
 * Reward invoices that are already well funded — they are close to releasing.
 * The target amount is derived as the sum of all recipient amounts.
 * fundedRatio = funded / totalRecipientAmount, clamped to [0, 1].
 */
const fundingProgressSignal: RecommendationSignal = {
  name: "fundingProgress",
  weight: 1.0,
  score(invoice) {
    const target = invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);
    if (target === 0n) return 0;
    const ratio = Number(invoice.funded) / Number(target);
    return Math.min(1, Math.max(0, ratio));
  },
};

/**
 * Prefer invoices that the requesting user is directly involved in
 * (as creator or recipient).
 */
const userRelevanceSignal: RecommendationSignal = {
  name: "userRelevance",
  weight: 2.0,
  score(invoice, ctx) {
    if (invoice.creator === ctx.userId) return 1;
    if (invoice.recipients.some((r) => r.address === ctx.userId)) return 0.8;
    return 0;
  },
};

/** Default signal set used when no custom signals are registered. */
const DEFAULT_SIGNALS: RecommendationSignal[] = [
  urgencySignal,
  fundingProgressSignal,
  userRelevanceSignal,
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * InvoiceRecommendationEngine scores and ranks invoices for a given user
 * context using configurable weighted signals.
 *
 * @example
 * ```ts
 * const engine = new InvoiceRecommendationEngine();
 * const recs = engine.recommend(invoices, { userId: "GABC..." });
 * console.log(recs[0].invoice.id, recs[0].score);
 * ```
 */
export class InvoiceRecommendationEngine {
  private signals: RecommendationSignal[] = [...DEFAULT_SIGNALS];
  private readonly options: Required<RecommendationEngineOptions>;
  private readonly listeners = new Map<
    keyof RecommendationEventMap,
    Array<RecommendationEventHandler<keyof RecommendationEventMap>>
  >();

  constructor(options: RecommendationEngineOptions = {}) {
    this.options = {
      topK: options.topK ?? 10,
      minScore: options.minScore ?? 0,
      eligibleStatuses: options.eligibleStatuses ?? ["Pending"],
    };

    if (this.options.topK < 1) {
      throw new ValidationError("topK must be at least 1");
    }
    if (this.options.minScore < 0 || this.options.minScore > 1) {
      throw new ValidationError("minScore must be in the range [0, 1]");
    }
  }

  // ---- Signal management --------------------------------------------------

  /**
   * Register a custom scoring signal.
   * Replaces any existing signal with the same name.
   */
  registerSignal(signal: RecommendationSignal): this {
    if (!signal.name || signal.name.trim() === "") {
      throw new ValidationError("Signal name must be a non-empty string");
    }
    if (signal.weight <= 0) {
      throw new ValidationError(`Signal "${signal.name}" weight must be positive`);
    }

    const idx = this.signals.findIndex((s) => s.name === signal.name);
    if (idx >= 0) {
      this.signals[idx] = signal;
    } else {
      this.signals.push(signal);
    }
    return this;
  }

  /** Remove a registered signal by name. No-op if the signal does not exist. */
  removeSignal(name: string): this {
    this.signals = this.signals.filter((s) => s.name !== name);
    return this;
  }

  /** Return a copy of the currently registered signals. */
  getSignals(): RecommendationSignal[] {
    return [...this.signals];
  }

  /** Reset signals back to the built-in defaults. */
  resetSignals(): this {
    this.signals = [...DEFAULT_SIGNALS];
    return this;
  }

  // ---- Event handling -----------------------------------------------------

  on<K extends keyof RecommendationEventMap>(
    event: K,
    handler: RecommendationEventHandler<K>
  ): this {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners
      .get(event)!
      .push(handler as RecommendationEventHandler<keyof RecommendationEventMap>);
    return this;
  }

  off<K extends keyof RecommendationEventMap>(
    event: K,
    handler: RecommendationEventHandler<K>
  ): this {
    const handlers = this.listeners.get(event);
    if (!handlers) return this;
    const idx = handlers.indexOf(
      handler as RecommendationEventHandler<keyof RecommendationEventMap>
    );
    if (idx >= 0) handlers.splice(idx, 1);
    return this;
  }

  private emit<K extends keyof RecommendationEventMap>(
    event: K,
    payload: RecommendationEventMap[K]
  ): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      (h as RecommendationEventHandler<K>)(payload);
    }
  }

  // ---- Core recommendation ------------------------------------------------

  /**
   * Score and rank the provided invoices for the given context.
   *
   * @param invoices - Pool of invoices to consider.
   * @param context  - User and environmental context for scoring.
   * @returns Ranked list of at most `topK` recommendations.
   */
  recommend(
    invoices: Invoice[],
    context: RecommendationContext
  ): InvoiceRecommendation[] {
    if (!context.userId || context.userId.trim() === "") {
      throw new ValidationError("context.userId must be a non-empty string");
    }

    const totalWeight = this.signals.reduce((sum, s) => sum + s.weight, 0);

    const eligible = invoices.filter((inv) =>
      (this.options.eligibleStatuses as string[]).includes(inv.status)
    );

    const scored: InvoiceRecommendation[] = [];

    for (const invoice of eligible) {
      try {
        const breakdown: Record<string, number> = {};
        let weightedSum = 0;

        for (const signal of this.signals) {
          const raw = signal.score(invoice, context);
          const clamped = Math.min(1, Math.max(0, raw));
          breakdown[signal.name] = clamped;
          weightedSum += clamped * signal.weight;
        }

        const compositeScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

        if (compositeScore >= this.options.minScore) {
          scored.push({ invoice, score: compositeScore, breakdown });
        }
      } catch (error) {
        this.emit("error", { invoice, error });
      }
    }

    this.emit("scored", scored);

    // Sort descending by score; break ties by invoice id for determinism.
    scored.sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      return String(a.invoice.id) < String(b.invoice.id) ? -1 : 1;
    });

    const result = scored.slice(0, this.options.topK);
    this.emit("recommended", result);
    return result;
  }
}
