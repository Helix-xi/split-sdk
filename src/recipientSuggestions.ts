/**
 * Recipient suggestions API — issue #1051
 *
 * Suggests recipients to pay based on past payment history and a contact
 * list.  The scorer combines a frequency signal (how often a recipient has
 * been paid) with a recency signal (how recently they were last paid) into a
 * deterministic [0, 1] score.  Callers can filter results by excluding
 * addresses and/or applying a minimum score threshold, and results are ranked
 * highest-score first with stable address-based tie-breaking.
 *
 * The suggester is intentionally stateless: callers supply the history and
 * candidate contacts on each call, so the SDK does not need to own a
 * persistence layer for contact data.
 */

import type { Recipient } from "./types.js";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A recorded interaction with a recipient (e.g. a past payment). */
export interface RecipientInteraction {
  /** Stellar address of the recipient. */
  address: string;
  /** Amount sent in the interaction, in stroops. */
  amount: bigint;
  /** Unix timestamp in seconds when the interaction occurred. */
  timestamp: number;
}

/** A single suggested recipient with its composite score and rationale. */
export interface RecipientSuggestion {
  /** Stellar address of the suggested recipient. */
  address: string;
  /** Composite score in the range [0, 1]; higher is a stronger match. */
  score: number;
  /** Human-readable explanation for why this recipient was suggested. */
  reason: string;
  /** Number of past interactions with this recipient. */
  interactionCount: number;
  /** Unix timestamp of the most recent interaction, if any. */
  lastInteraction?: number;
}

/** Input candidates for a suggestion run. */
export interface SuggestRecipientsOptions {
  /**
   * Contact addresses eligible for suggestion.  When omitted, candidates are
   * derived from the supplied history.
   */
  candidates?: string[];
  /** Past interactions used by the matcher to learn recipient preferences. */
  history: RecipientInteraction[];
  /** Addresses that must never be suggested. */
  exclude?: string[];
  /**
   * Minimum composite score [0, 1] required to be included in results.
   * @default 0
   */
  minScore?: number;
  /** Maximum number of suggestions to return. @default 10 */
  limit?: number;
  /**
   * Unix timestamp in seconds representing "now" for recency scoring.
   * Defaults to Date.now() / 1000.
   */
  nowSeconds?: number;
}

/** Weight applied to the frequency signal in the composite score. */
const FREQUENCY_WEIGHT = 0.6;
/** Weight applied to the recency signal in the composite score. */
const RECENCY_WEIGHT = 0.4;

/**
 * Default maximum number of suggestions returned per call.
 */
export const DEFAULT_SUGGESTION_LIMIT = 10;

/**
 * Default recency half-life in seconds: a recipient last paid this long ago
 * scores 0.5 on the recency signal (before weighting).
 */
const RECENCY_HALF_LIFE_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Build ranked recipient suggestions from history and optional contacts.
 *
 * Implements matcher (frequency + recency scoring), filtering (exclude list
 * and min-score threshold) and ranking (score-descending, stable tie-break).
 */
export function suggestRecipients(
  options: SuggestRecipientsOptions,
): RecipientSuggestion[] {
  if (!options.history || !Array.isArray(options.history)) {
    throw new ValidationError("options.history must be an array");
  }

  const nowSeconds = options.nowSeconds ?? Date.now() / 1000;
  const exclude = new Set(options.exclude ?? []);
  const limit = options.limit ?? DEFAULT_SUGGESTION_LIMIT;
  const minScore = options.minScore ?? 0;

  // Derive the candidate set: explicit contacts restrict the pool; when none
  // are provided, candidates are derived from the supplied history.
  const candidateSet = new Set<string>();
  if (options.candidates?.length) {
    for (const c of options.candidates) {
      if (typeof c === "string" && c.length > 0) candidateSet.add(c);
    }
  } else {
    for (const h of options.history) {
      if (typeof h.address === "string" && h.address.length > 0) {
        candidateSet.add(h.address);
      }
    }
  }

  // First pass: score every candidate and track the max frequency for
  // normalizing the frequency signal across candidates.
  const perCandidate: Array<{
    address: string;
    interactionCount: number;
    lastInteraction?: number;
    recencyScore: number;
  }> = [];

  let maxFrequency = 0;
  for (const address of candidateSet) {
    if (exclude.has(address)) continue;

    const interactions = options.history.filter((h) => h.address === address);
    const interactionCount = interactions.length;
    if (interactionCount === 0) continue; // no history → not a suggestion

    const timestamps = interactions.map((h) => h.timestamp);
    const lastInteraction = Math.max(...timestamps);
    const ageSeconds = Math.max(0, nowSeconds - lastInteraction);
    const recencyScore = 1 / (1 + ageSeconds / RECENCY_HALF_LIFE_SECONDS);

    if (interactionCount > maxFrequency) maxFrequency = interactionCount;

    perCandidate.push({
      address,
      interactionCount,
      lastInteraction,
      recencyScore,
    });
  }

  // Second pass: normalize frequency, combine with recency, filter, rank.
  const scored: RecipientSuggestion[] = perCandidate.map((c) => {
    const frequencyScore =
      maxFrequency > 0 ? c.interactionCount / maxFrequency : 0; // (0, 1]
    const score =
      FREQUENCY_WEIGHT * frequencyScore + RECENCY_WEIGHT * c.recencyScore;

    let reason: string;
    if (c.interactionCount === 1) {
      reason = "Paid once previously";
    } else {
      reason = `Paid ${c.interactionCount} times`;
    }

    return {
      address: c.address,
      score: Math.min(1, Math.max(0, score)),
      reason,
      interactionCount: c.interactionCount,
      lastInteraction: c.lastInteraction,
    };
  });

  const filtered = scored.filter((s) => s.score >= minScore);

  // Sort descending by score; break ties by address for determinism.
  filtered.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  });

  return filtered.slice(0, limit);
}

/**
 * Convert a {@link Recipient} (as used in invoice creation) into a
 * {@link RecipientInteraction} suitable for recording in suggestion history.
 */
export function interactionFromRecipient(
  recipient: Recipient,
  timestamp: number,
): RecipientInteraction {
  return {
    address: recipient.address,
    amount: recipient.amount,
    timestamp,
  };
}

