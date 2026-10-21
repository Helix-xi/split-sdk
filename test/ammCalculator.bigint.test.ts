import { describe, it, expect } from "vitest";
import { estimateSwapOutput } from "../src/ammCalculator.js";
import { InsufficientLiquidityError } from "../src/errors.js";

function makePool(reserveIn: string, reserveOut: string) {
  return {
    reserves: [
      { asset: "XLM", amount: reserveIn },
      { asset: "USDC", amount: reserveOut },
    ],
  };
}

describe("BigInt-safe liquidity ratio", () => {
  it("enforces maxRatio without overflowing arbitrary-size reserves", () => {
    const reserveIn = 10n ** 400n;
    const pool = makePool(reserveIn.toString(), reserveIn.toString());

    expect(() =>
      estimateSwapOutput(pool, (reserveIn * 2n).toString(), "XLM"),
    ).toThrow(InsufficientLiquidityError);

    expect(() =>
      estimateSwapOutput(pool, (reserveIn / 4n).toString(), "XLM", 0.25),
    ).not.toThrow();

    expect(() =>
      estimateSwapOutput(pool, (reserveIn / 4n + 1n).toString(), "XLM", 0.25),
    ).toThrow(InsufficientLiquidityError);
  });

});
