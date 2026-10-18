import { describe, it, expect } from "vitest";
import {
  suggestRecipients,
  interactionFromRecipient,
  type RecipientInteraction,
} from "../src/recipientSuggestions.js";
import type { Recipient } from "../src/types.js";

const now = 1_700_000_000;

function interaction(
  address: string,
  offsetSeconds: number,
  amount = 100n,
): RecipientInteraction {
  return { address, amount, timestamp: now - offsetSeconds };
}

describe("suggestRecipients", () => {
  it("returns suggestions derived from payment history", () => {
    const history = [
      interaction("GAAA", 1000),
      interaction("GAAA", 2000),
      interaction("GBBB", 5000),
    ];

    const suggestions = suggestRecipients({ history, nowSeconds: now });

    expect(suggestions.map((s) => s.address)).toEqual(["GAAA", "GBBB"]);
    expect(suggestions[0]!.score).toBeGreaterThan(suggestions[1]!.score);
    expect(suggestions[0]!.interactionCount).toBe(2);
    expect(suggestions[1]!.interactionCount).toBe(1);
  });

  it("ranks frequent recipients higher (matcher accuracy)", () => {
    const history = [
      interaction("GAAA", 1000),
      interaction("GAAA", 2000),
      interaction("GAAA", 3000),
      interaction("GBBB", 1000),
    ];

    const suggestions = suggestRecipients({ history, nowSeconds: now });

    expect(suggestions[0]!.address).toBe("GAAA");
    expect(suggestions[0]!.interactionCount).toBe(3);
    expect(suggestions[1]!.address).toBe("GBBB");
  });

  it("ranks recently paid recipients higher (recency signal)", () => {
    const history = [
      interaction("GAAA", 1000), // recent
      interaction("GBBB", 1_000_000_000), // ancient
    ];

    const suggestions = suggestRecipients({ history, nowSeconds: now });

    expect(suggestions[0]!.address).toBe("GAAA");
  });

  it("excludes addresses listed in options.exclude", () => {
    const history = [
      interaction("GAAA", 1000),
      interaction("GBBB", 1000),
    ];

    const suggestions = suggestRecipients({
      history,
      nowSeconds: now,
      exclude: ["GAAA"],
    });

    expect(suggestions.map((s) => s.address)).toEqual(["GBBB"]);
  });

  it("filters out suggestions below minScore", () => {
    const history = [interaction("GAAA", 10_000_000_000)]; // very old

    const suggestions = suggestRecipients({
      history,
      nowSeconds: now,
      minScore: 0.9, // low recency keeps the composite below this
    });

    expect(suggestions).toHaveLength(0);
  });

  it("respects the limit option", () => {
    const history = [
      interaction("GAAA", 1000),
      interaction("GBBB", 2000),
      interaction("GCCC", 3000),
    ];

    const suggestions = suggestRecipients({
      history,
      nowSeconds: now,
      limit: 2,
    });

    expect(suggestions).toHaveLength(2);
  });

  it("uses explicit candidates when provided", () => {
    const history = [
      interaction("GAAA", 1000),
      interaction("GBBB", 1000),
      interaction("GCCC", 1000), // not a contact, should be ignored
    ];

    const suggestions = suggestRecipients({
      history,
      nowSeconds: now,
      candidates: ["GAAA", "GBBB"],
    });

    expect(suggestions.map((s) => s.address)).toEqual(["GAAA", "GBBB"]);
  });

  it("derives candidates from history when none are provided", () => {
    const history = [interaction("GAAA", 1000), interaction("GBBB", 2000)];

    const suggestions = suggestRecipients({ history, nowSeconds: now });

    expect(suggestions.map((s) => s.address).sort()).toEqual([
      "GAAA",
      "GBBB",
    ]);
  });

  it("throws ValidationError when history is missing", () => {
    expect(() =>
      suggestRecipients({ history: undefined as unknown as RecipientInteraction[] }),
    ).toThrow();
  });

  it("produces stable, deterministic ordering on equal scores", () => {
    const history = [
      interaction("GBBB", 1000),
      interaction("GAAA", 1000),
    ];

    const suggestions = suggestRecipients({ history, nowSeconds: now });

    // Equal counts and equal recency → tie-break by address ascending.
    expect(suggestions[0]!.address).toBe("GAAA");
    expect(suggestions[1]!.address).toBe("GBBB");
  });
});

describe("interactionFromRecipient", () => {
  it("converts a Recipient into an interaction", () => {
    const recipient: Recipient = { address: "GAAA", amount: 5000n };
    const result = interactionFromRecipient(recipient, now);
    expect(result.address).toBe("GAAA");
    expect(result.amount).toBe(5000n);
    expect(result.timestamp).toBe(now);
  });
});
