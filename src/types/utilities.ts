/**
 * Generic type utilities and inference helpers for the StellarSplit SDK.
 *
 * Provides:
 * - Result<T, E> discriminated union for functional error handling
 * - PaginatedResponse<T> generic pagination wrapper
 * - Status-narrowed Invoice types and type guards
 * - Branded types for type-safe amounts, addresses, and invoice identifiers
 * - Recursive type utilities (DeepPartial, DeepReadonly, RequireKeys, etc.)
 */

import type { Invoice, InvoiceStatus } from "../types.js";

// ---------------------------------------------------------------------------
// Result<T, E> Pattern
// ---------------------------------------------------------------------------

/**
 * A discriminated union representing either a successful outcome with value `T`
 * or a failure with error `E`.
 */
export type Result<T, E = Error> =
  | { readonly success: true; readonly data: T; readonly error?: never }
  | { readonly success: false; readonly error: E; readonly data?: never };

/** Creates a successful Result. */
export function ok<T>(data: T): Result<T, never> {
  return { success: true, data };
}

/** Creates a failed Result. */
export function err<E = Error>(error: E): Result<never, E> {
  return { success: false, error };
}

/** Type guard that narrows a Result to a success variant. */
export function isOk<T, E>(result: Result<T, E>): result is { readonly success: true; readonly data: T; readonly error?: never } {
  return result.success;
}

/** Type guard that narrows a Result to an error variant. */
export function isErr<T, E>(result: Result<T, E>): result is { readonly success: false; readonly error: E; readonly data?: never } {
  return !result.success;
}

/**
 * Unwraps a Result, returning the value if successful, or throwing the error.
 */
export function unwrapResult<T, E>(result: Result<T, E>): T {
  if (result.success) {
    return result.data;
  }
  throw result.error;
}

/**
 * Maps the data value of a Result if successful.
 */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (val: T) => U): Result<U, E> {
  if (result.success) {
    return ok(fn(result.data));
  }
  return result;
}

/**
 * Maps the error value of a Result if failed.
 */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  if (!result.success) {
    return err(fn(result.error));
  }
  return result;
}

/**
 * Pattern-matches against a Result.
 */
export function matchResult<T, E, R>(
  result: Result<T, E>,
  patterns: { ok: (data: T) => R; err: (error: E) => R }
): R {
  return result.success ? patterns.ok(result.data) : patterns.err(result.error);
}

// ---------------------------------------------------------------------------
// Pagination Generics
// ---------------------------------------------------------------------------

/**
 * Generic container for paginated query results.
 */
export interface PaginatedResponse<T> {
  /** Array of items in the current page. */
  readonly items: T[];
  /** Total count of items across all pages. */
  readonly total: number;
  /** Current 1-based page index. */
  readonly page: number;
  /** Number of items requested per page. */
  readonly pageSize: number;
  /** Total number of pages available. */
  readonly totalPages: number;
  /** True when subsequent pages exist. */
  readonly hasNext: boolean;
  /** True when previous pages exist. */
  readonly hasPrev: boolean;
}

/**
 * Helper to construct a PaginatedResponse.
 */
export function createPaginatedResponse<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number
): PaginatedResponse<T> {
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.ceil(Math.max(0, total) / safePageSize);
  return {
    items,
    total,
    page,
    pageSize: safePageSize,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

// ---------------------------------------------------------------------------
// Status-Narrowed Invoices & Guards
// ---------------------------------------------------------------------------

/** An Invoice narrowed to the "Pending" lifecycle state. */
export type PendingInvoice<TMetadata = Record<string, unknown>> = Invoice<TMetadata, "Pending">;

/** An Invoice narrowed to the "Released" lifecycle state. */
export type ReleasedInvoice<TMetadata = Record<string, unknown>> = Invoice<TMetadata, "Released">;

/** An Invoice narrowed to the "Refunded" lifecycle state. */
export type RefundedInvoice<TMetadata = Record<string, unknown>> = Invoice<TMetadata, "Refunded">;

/** An Invoice narrowed to the "Cancelled" lifecycle state. */
export type CancelledInvoice<TMetadata = Record<string, unknown>> = Invoice<TMetadata, "Cancelled">;

/** Narrows an Invoice to a specific lifecycle status. */
export function isInvoiceStatus<S extends InvoiceStatus>(
  invoice: Invoice<any, any>,
  status: S
): invoice is Invoice<Record<string, unknown>, S> {
  return invoice.status === status;
}

/** Narrows an invoice to Pending. */
export function isPendingInvoice<T = Record<string, unknown>>(
  invoice: Invoice<T, any>
): invoice is PendingInvoice<T> {
  return invoice.status === "Pending";
}

/** Narrows an invoice to Released. */
export function isReleasedInvoice<T = Record<string, unknown>>(
  invoice: Invoice<T, any>
): invoice is ReleasedInvoice<T> {
  return invoice.status === "Released";
}

/** Narrows an invoice to Refunded. */
export function isRefundedInvoice<T = Record<string, unknown>>(
  invoice: Invoice<T, any>
): invoice is RefundedInvoice<T> {
  return invoice.status === "Refunded";
}

/** Narrows an invoice to Cancelled. */
export function isCancelledInvoice<T = Record<string, unknown>>(
  invoice: Invoice<T, any>
): invoice is CancelledInvoice<T> {
  return invoice.status === "Cancelled";
}

// ---------------------------------------------------------------------------
// Branded Types for Type Safety
// ---------------------------------------------------------------------------

declare const __brand: unique symbol;

/** Generic brand helper. */
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Amount represented in stroops (1 XLM = 10_000_000 stroops). */
export type StroopAmount = Brand<bigint, "StroopAmount">;

/** Valid Stellar public key or contract address. */
export type StellarAddress = Brand<string, "StellarAddress">;

/** Unique invoice ID string. */
export type InvoiceId = Brand<string, "InvoiceId">;

/** Converts a bigint, number, or string to a branded StroopAmount. */
export function toStroops(amount: bigint | number | string): StroopAmount {
  const val = typeof amount === "bigint" ? amount : BigInt(amount);
  if (val < 0n) {
    throw new TypeError(`Stroop amount cannot be negative: ${val}`);
  }
  return val as StroopAmount;
}

/** Validates and brands a Stellar public key or contract address. */
export function toStellarAddress(address: string): StellarAddress {
  if (typeof address !== "string" || address.trim().length === 0) {
    throw new TypeError("Stellar address must be a non-empty string");
  }
  return address.trim() as StellarAddress;
}

/** Brands an invoice identifier string. */
export function toInvoiceId(id: string | bigint): InvoiceId {
  const str = id.toString().trim();
  if (!str) {
    throw new TypeError("Invoice ID cannot be empty");
  }
  return str as InvoiceId;
}

// ---------------------------------------------------------------------------
// Type-Level Utilities
// ---------------------------------------------------------------------------

/** Recursively makes all properties optional. */
export type DeepPartial<T> = T extends Function
  ? T
  : T extends Array<infer U>
  ? _DeepPartialArray<U>
  : T extends object
  ? _DeepPartialObject<T>
  : T;

type _DeepPartialArray<T> = Array<DeepPartial<T>>;
type _DeepPartialObject<T> = { [P in keyof T]?: DeepPartial<T[P]> };

/** Recursively makes all properties readonly. */
export type DeepReadonly<T> = T extends Function
  ? T
  : T extends Array<infer U>
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
  ? { readonly [P in keyof T]: DeepReadonly<T[P]> }
  : T;

/** Forces specific keys of an object to be required while keeping the rest unchanged. */
export type RequireKeys<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

/** Forces specific keys of an object to be optional while keeping the rest unchanged. */
export type OptionalKeys<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** Type-safe Omit that guarantees keys exist on T. */
export type StrictOmit<T, K extends keyof T> = Omit<T, K>;

/** Union of all value types of an object or record. */
export type ValueOf<T> = T[keyof T];

/** Ensures at least one of the specified keys is provided on T. */
export type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Pick<T, Exclude<keyof T, Keys>> &
  {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>;
  }[Keys];

/** Ensures exactly one of the specified keys is provided on T. */
export type RequireOnlyOne<T, Keys extends keyof T = keyof T> = Pick<T, Exclude<keyof T, Keys>> &
  {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Record<Exclude<Keys, K>, never>>;
  }[Keys];

/** Narrows specified keys to be NonNullable. */
export type NonNullableFields<T, K extends keyof T> = Omit<T, K> & {
  [P in K]: NonNullable<T[P]>;
};
