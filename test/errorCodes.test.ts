import { describe, it, expect } from "vitest";
import {
  StellarSplitError,
  InvoiceNotFoundError,
  InvoiceNotPendingError,
  DeadlinePassedError,
  InsufficientBalanceError,
  PaymentExceedsRemainingError,
  InvoiceFrozenError,
  RoundNotEndedError,
  isRoundNotEndedError,
  WrongMilestoneError,
  isWrongMilestoneError,
  NothingToClaimError,
  isNothingToClaimError,
  InvoiceExpiredError,
  isInvoiceExpiredError,
  PayerNotWhitelistedError,
  isPayerNotWhitelistedError,
  ContributionCapExceededError,
  isContributionCapExceededError,
  PaymentCooldownActiveError,
  isPaymentCooldownActiveError,
  ContractFrozenError,
  isContractFrozenError,
  InvoiceFullyFundedError,
  isInvoiceFullyFundedError,
  DelegateLimitReachedError,
  isDelegateLimitReachedError,
  BatchTooLargeError,
  isBatchTooLargeError,
} from "../src/errors.js";
import { isRetryable } from "../src/retryPolicy.js";

describe("Error Codes & Taxonomy (#1077)", () => {
  describe("Rounds, Milestones and Referral Errors", () => {
    it("RoundNotEndedError instantiates properly and is non-retryable", () => {
      const err = new RoundNotEndedError("inv-10", 1700000000);
      expect(err).toBeInstanceOf(StellarSplitError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("RoundNotEndedError");
      expect(err.code).toBe("ROUND_NOT_ENDED");
      expect(err.invoiceId).toBe("inv-10");
      expect(err.roundEnd).toBe(1700000000);
      expect(isRoundNotEndedError(err)).toBe(true);
      expect(isRoundNotEndedError(new Error())).toBe(false);
      expect(isRetryable(err)).toBe(false);
    });

    it("WrongMilestoneError instantiates properly and is non-retryable", () => {
      const err = new WrongMilestoneError("inv-10", 3, 1);
      expect(err).toBeInstanceOf(StellarSplitError);
      expect(err.name).toBe("WrongMilestoneError");
      expect(err.code).toBe("WRONG_MILESTONE");
      expect(err.invoiceId).toBe("inv-10");
      expect(err.requestedIndex).toBe(3);
      expect(err.activeIndex).toBe(1);
      expect(isWrongMilestoneError(err)).toBe(true);
      expect(isWrongMilestoneError(new Error())).toBe(false);
      expect(isRetryable(err)).toBe(false);
    });

    it("NothingToClaimError instantiates properly and is non-retryable", () => {
      const err = new NothingToClaimError("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H");
      expect(err).toBeInstanceOf(StellarSplitError);
      expect(err.name).toBe("NothingToClaimError");
      expect(err.code).toBe("NOTHING_TO_CLAIM");
      expect(err.address).toBe("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H");
      expect(isNothingToClaimError(err)).toBe(true);
      expect(isNothingToClaimError(new Error())).toBe(false);
      expect(isRetryable(err)).toBe(false);
    });
  });

  describe("Access, Cooldown, and Funding Errors", () => {
    it("PaymentCooldownActiveError carries retryAfter Date and IS retryable", () => {
      const ts = 1750000000;
      const err = new PaymentCooldownActiveError("inv-1", "GABC", ts);
      expect(err).toBeInstanceOf(StellarSplitError);
      expect(err.code).toBe("PAYMENT_COOLDOWN_ACTIVE");
      expect(err.payer).toBe("GABC");
      expect(err.retryAfter).toBeInstanceOf(Date);
      expect(err.retryAfter.getTime()).toBe(ts * 1000);
      expect(isPaymentCooldownActiveError(err)).toBe(true);
      expect(isRetryable(err)).toBe(true);
    });

    it("InvoiceExpiredError and PayerNotWhitelistedError are non-retryable", () => {
      const expErr = new InvoiceExpiredError("inv-exp");
      expect(expErr.code).toBe("INVOICE_EXPIRED");
      expect(isInvoiceExpiredError(expErr)).toBe(true);
      expect(isRetryable(expErr)).toBe(false);

      const whiteErr = new PayerNotWhitelistedError("inv-w", "GXYZ");
      expect(whiteErr.code).toBe("PAYER_NOT_WHITELISTED");
      expect(isPayerNotWhitelistedError(whiteErr)).toBe(true);
      expect(isRetryable(whiteErr)).toBe(false);
    });

    it("ContributionCapExceededError carries cap and attempted", () => {
      const err = new ContributionCapExceededError("inv-cap", "GABC", 1000n, 1500n);
      expect(err.code).toBe("CONTRIBUTION_CAP_EXCEEDED");
      expect(err.cap).toBe(1000n);
      expect(err.attempted).toBe(1500n);
      expect(isContributionCapExceededError(err)).toBe(true);
      expect(isRetryable(err)).toBe(false);
    });

    it("ContractFrozenError represents administrative contract pause", () => {
      const err = new ContractFrozenError();
      expect(err.code).toBe("CONTRACT_FROZEN");
      expect(isContractFrozenError(err)).toBe(true);
      expect(isRetryable(err)).toBe(false);
    });

    it("InvoiceFullyFundedError and DelegateLimitReachedError instantiate properly", () => {
      const fundedErr = new InvoiceFullyFundedError("inv-full");
      expect(fundedErr.code).toBe("INVOICE_FULLY_FUNDED");
      expect(isInvoiceFullyFundedError(fundedErr)).toBe(true);
      expect(isRetryable(fundedErr)).toBe(false);

      const limitErr = new DelegateLimitReachedError("inv-lim", 3);
      expect(limitErr.code).toBe("DELEGATE_LIMIT_REACHED");
      expect(limitErr.limit).toBe(3);
      expect(isDelegateLimitReachedError(limitErr)).toBe(true);
      expect(isRetryable(limitErr)).toBe(false);
    });

    it("BatchTooLargeError carries batchSize and maxSize", () => {
      const err = new BatchTooLargeError(25, 20);
      expect(err.code).toBe("BATCH_TOO_LARGE");
      expect(err.batchSize).toBe(25);
      expect(err.maxSize).toBe(20);
      expect(isBatchTooLargeError(err)).toBe(true);
    });
  });

  describe("Base StellarSplitError guarantees", () => {
    it("preserves prototype chain and context", () => {
      const err = new StellarSplitError("Custom failure", "CUSTOM_CODE", { foo: "bar" }, "contract panic string");
      expect(err).toBeInstanceOf(StellarSplitError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe("CUSTOM_CODE");
      expect(err.context?.foo).toBe("bar");
      expect(err.raw).toBe("contract panic string");
    });
  });
});
