/**
 * Input sanitization and validation utilities (issue #1057).
 *
 * Every public SDK method forwards user-supplied strings, amounts, and
 * addresses to Soroban contract calls, RPC/Horizon endpoints, and webhook
 * consumers. This module centralizes the guards applied to those inputs so
 * integrators (and the SDK itself) can reject or neutralize hostile payloads
 * before they travel any further:
 *
 * - {@link sanitizeString} strips NUL/control characters (CRLF header
 *   injection), Unicode bidi overrides (display spoofing), and enforces
 *   length limits.
 * - {@link validateAmount} accepts only canonical decimal amounts with at
 *   most 7 fractional digits (Stellar stroops precision) and rejects NaN,
 *   Infinity, exponent notation, unsafe integers, and out-of-range values.
 *   {@link validateAndParseAmount} additionally converts to stroops.
 * - {@link validateAddress} enforces StrKey structure (G/C/M addresses),
 *   including checksum validation.
 * - {@link sanitizeObject} deep-sanitizes plain-object payloads while
 *   blocking prototype-pollution keys (`__proto__`, `constructor`,
 *   `prototype`), non-finite numbers, functions/symbols, excessive depth,
 *   excessive key counts, and cyclic references.
 *
 * Strings are intentionally NOT HTML-escaped: SDK values are on-chain data,
 * and escaping would corrupt legitimate memos/metadata. Structural validation
 * plus control-character stripping is the sanitization contract; rendering
 * layers remain responsible for output encoding.
 *
 * Issue #1057
 */

import { StrKey } from "@stellar/stellar-sdk";
import { StellarSplitError } from "./errors.js";
import { parseAmount } from "./utils.js";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Thrown when user input fails sanitization or structural validation. */
export class InputSanitizationError extends StellarSplitError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "INPUT_SANITIZATION", context);
    this.name = "InputSanitizationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** C0 control chars (minus TAB/LF/CR) plus DEL and the C1 range. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** C0 control chars including TAB/LF/CR — used for single-line inputs. */
const ALL_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
/** Unicode bidirectional overrides/isolates used for display spoofing. */
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
/** Canonical decimal amount pattern (no exponents, separators, or whitespace). */
const AMOUNT_PATTERN = /^-?\d+(?:\.\d+)?$/;
/** Decimal places supported by Stellar stroops. */
const MAX_STROOP_DECIMALS = 7;

/** Keys that must never survive a deep clone (prototype-pollution vectors). */
const PROTOTYPE_POLLUTION_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

// ---------------------------------------------------------------------------
// String sanitization
// ---------------------------------------------------------------------------

/** Options for {@link sanitizeString}. */
export interface SanitizeStringOptions {
  /**
   * Maximum length (in characters) of the sanitized result. When exceeded an
   * {@link InputSanitizationError} is thrown instead of silently truncating.
   */
  maxLength?: number;
  /** Keep `\r` and `\n`. Defaults to `true`. */
  allowNewlines?: boolean;
  /** Trim leading/trailing whitespace. Defaults to `true`. */
  trim?: boolean;
  /** Field name used in error messages. Defaults to `"input"`. */
  field?: string;
}

/**
 * Strip characters that enable injection or display attacks from `input`.
 *
 * Removes:
 * - NUL and other C0/C1 control characters (and optionally `\r`/`\n`, which
 *   enable HTTP header injection when a value lands in a header).
 * - Unicode bidirectional overrides (`U+202A`–`U+202E`, `U+2066`–`U+2069`)
 *   and directional marks used to spoof displayed text.
 *
 * @param input   - Raw string input.
 * @param options - Sanitization options (length, newlines, trimming).
 * @returns The sanitized string.
 * @throws {InputSanitizationError} If `input` is not a string or the
 *   sanitized result exceeds `maxLength`.
 *
 * @example
 * sanitizeString(" hello\u0000\u202E ");              // "hello"
 * sanitizeString("a\r\nb", { allowNewlines: false }); // "ab"
 */
export function sanitizeString(
  input: string,
  options: SanitizeStringOptions = {},
): string {
  const field = options.field ?? "input";
  if (typeof input !== "string") {
    throw new InputSanitizationError(`${field} must be a string`, {
      field,
      received: typeof input,
    });
  }

  let out = input.replace(BIDI_CONTROLS, "");
  out =
    options.allowNewlines === false
      ? out.replace(ALL_CONTROL_CHARS, "")
      : out.replace(CONTROL_CHARS, "");
  if (options.trim !== false) {
    out = out.trim();
  }
  if (options.maxLength !== undefined && out.length > options.maxLength) {
    throw new InputSanitizationError(
      `${field} exceeds maximum length of ${options.maxLength} characters`,
      { field, length: out.length, maxLength: options.maxLength },
    );
  }
  return out;
}
// ---------------------------------------------------------------------------
// Amount validation
// ---------------------------------------------------------------------------

/** Options for {@link validateAmount} / {@link validateAndParseAmount}. */
export interface AmountValidationOptions {
  /**
   * Maximum number of fractional digits. Defaults to `7` (Stellar stroops
   * precision). Values above `7` are rejected because they cannot be
   * represented on-chain.
   */
  maxDecimals?: number;
  /** Inclusive lower bound as a decimal string. Defaults to `"0"`. */
  min?: string;
  /** Field name used in error messages. Defaults to `"amount"`. */
  field?: string;
}

interface NormalizedAmount {
  /** Canonical decimal string without redundant zeros. */
  value: string;
  /** Value scaled by `10 ** maxDecimals` for exact comparison. */
  units: bigint;
}

function normalizeAmount(
  value: string | number | bigint,
  maxDecimals: number,
  field: string,
): NormalizedAmount {
  let text: string;
  if (typeof value === "bigint") {
    text = value.toString();
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InputSanitizationError(`${field} must be a finite number`, {
        field,
        received: String(value),
      });
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new InputSanitizationError(`${field} exceeds the safe integer range`, {
        field,
        received: String(value),
      });
    }
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    throw new InputSanitizationError(
      `${field} must be a string, number, or bigint`,
      { field, received: typeof value },
    );
  }

  if (!AMOUNT_PATTERN.test(text)) {
    throw new InputSanitizationError(
      `${field} must be a plain decimal number (no exponents or separators)`,
      { field, received: text },
    );
  }

  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole = "0", frac = ""] = unsigned.split(".");
  if (frac.length > maxDecimals) {
    throw new InputSanitizationError(
      `${field} has ${frac.length} decimal places; maximum is ${maxDecimals}`,
      { field, decimals: frac.length, maxDecimals },
    );
  }

  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFrac = frac.replace(/0+$/, "");
  const sign = negative ? "-" : "";
  const normalized = `${sign}${normalizedWhole}${
    normalizedFrac ? `.${normalizedFrac}` : ""
  }`;
  const units =
    BigInt(`${sign}${normalizedWhole}`) * 10n ** BigInt(maxDecimals) +
    BigInt(`${sign}${normalizedFrac.padEnd(maxDecimals, "0") || "0"}`);
  // Canonicalize "-0" / "-0.0" to "0".
  return { value: units === 0n ? normalized.replace(/^-/, "") : normalized, units };
}

/**
 * Validate a user-supplied amount and return its canonical decimal form.
 *
 * Accepts `string`, `number`, and `bigint` inputs and rejects: non-finite
 * numbers, exponent notation (`1e7`), grouping separators (`1,000`),
 * unsafe integers, more than `maxDecimals` fractional digits, and values
 * below `min` (negatives are rejected by default because `min` defaults
 * to `"0"`).
 *
 * The returned canonical string can be converted to stroops with the
 * existing `parseAmount()` helper (or use {@link validateAndParseAmount}).
 *
 * @param value   - Candidate amount.
 * @param options - Validation options (precision, lower bound).
 * @returns The canonical decimal string.
 * @throws {InputSanitizationError} When the amount is malformed or out of range.
 *
 * @example
 * validateAmount("001.5000");  // "1.5"
 * validateAmount(42);          // "42"
 * validateAmount("1.2345678"); // throws: 8 decimal places
 * validateAmount("-1");        // throws: below minimum "0"
 */
export function validateAmount(
  value: string | number | bigint,
  options: AmountValidationOptions = {},
): string {
  const field = options.field ?? "amount";
  const maxDecimals = options.maxDecimals ?? MAX_STROOP_DECIMALS;
  if (
    !Number.isInteger(maxDecimals) ||
    maxDecimals < 0 ||
    maxDecimals > MAX_STROOP_DECIMALS
  ) {
    throw new InputSanitizationError(
      `maxDecimals must be an integer between 0 and ${MAX_STROOP_DECIMALS}`,
      { field, maxDecimals },
    );
  }

  const normalized = normalizeAmount(value, maxDecimals, field);
  const min = normalizeAmount(
    options.min ?? "0",
    maxDecimals,
    `${field} minimum`,
  );
  if (normalized.units < min.units) {
    throw new InputSanitizationError(
      `${field} is below the minimum of ${min.value}`,
      { field, received: normalized.value, min: min.value },
    );
  }
  return normalized.value;
}

/**
 * Validate an amount and convert it to stroops (1 unit = 10^7 stroops).
 *
 * Pairs {@link validateAmount} with the existing `parseAmount()` helper so
 * malformed input can never be truncated silently before hitting the chain.
 *
 * @param value   - Candidate amount.
 * @param options - Validation options (precision must be 0–7 decimals).
 * @returns The amount in stroops.
 * @throws {InputSanitizationError} When the amount is malformed or out of range.
 *
 * @example
 * validateAndParseAmount("1.5"); // 15000000n
 */
export function validateAndParseAmount(
  value: string | number | bigint,
  options: AmountValidationOptions = {},
): bigint {
  const canonical = validateAmount(value, options);
  return parseAmount(canonical);
}
// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

/** Options for {@link validateAddress}. */
export interface AddressValidationOptions {
  /** Expected StrKey kind. Defaults to `"account"` (`G...`). */
  kind?: "account" | "contract" | "muxed";
  /** Field name used in error messages. Defaults to `"address"`. */
  field?: string;
}

/**
 * Validate a Stellar address (structure + CRC16 checksum) and return it
 * trimmed.
 *
 * @param address - Candidate address string.
 * @param options - Validation options (expected address kind).
 * @returns The trimmed, validated address.
 * @throws {InputSanitizationError} If the address is not a well-formed
 *   StrKey of the requested kind.
 *
 * @example
 * validateAddress("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ");
 * validateAddress(contractId, { kind: "contract" });
 */
export function validateAddress(
  address: string,
  options: AddressValidationOptions = {},
): string {
  const field = options.field ?? "address";
  const kind = options.kind ?? "account";
  const trimmed = sanitizeString(address, { allowNewlines: false, field });

  const valid =
    kind === "contract"
      ? StrKey.isValidContract(trimmed)
      : kind === "muxed"
        ? StrKey.isValidMed25519PublicKey(trimmed)
        : StrKey.isValidEd25519PublicKey(trimmed);

  if (!valid) {
    throw new InputSanitizationError(
      `${field} is not a valid Stellar ${kind} address`,
      {
        field,
        kind,
        received: trimmed.length > 72 ? `${trimmed.slice(0, 72)}…` : trimmed,
      },
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Object deep-sanitization
// ---------------------------------------------------------------------------

/** Options for {@link sanitizeObject}. */
export interface SanitizeObjectOptions {
  /** Maximum nesting depth before rejecting the payload. Defaults to `8`. */
  maxDepth?: number;
  /** Maximum number of keys per plain object. Defaults to `100`. */
  maxKeys?: number;
  /** Maximum length for embedded strings. Defaults to `10_000`. */
  maxLength?: number;
  /** Root field name used in error messages. Defaults to `"input"`. */
  field?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeLeaf(
  value: unknown,
  path: string,
  options: Required<Omit<SanitizeObjectOptions, "field">>,
): unknown {
  if (typeof value === "string") {
    return sanitizeString(value, { maxLength: options.maxLength, field: path });
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InputSanitizationError(`${path} must be a finite number`, {
        field: path,
        received: String(value),
      });
    }
    return value;
  }
  if (typeof value === "bigint" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) {
    throw new InputSanitizationError(`${path} contains an unsupported value type`, {
      field: path,
      received: typeof value,
    });
  }
  return undefined; // Containers are handled by walkValue before reaching here.
}
function walkValue(
  value: unknown,
  path: string,
  depth: number,
  options: Required<Omit<SanitizeObjectOptions, "field">>,
  ancestors: Set<object>,
): unknown {
  if (depth > options.maxDepth) {
    throw new InputSanitizationError(
      `${path} exceeds maximum depth of ${options.maxDepth}`,
      { field: path, maxDepth: options.maxDepth },
    );
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new InputSanitizationError(`${path} contains a circular reference`, {
        field: path,
      });
    }
    ancestors.add(value);
    const out = value.map((item, index) =>
      walkValue(item, `${path}[${index}]`, depth + 1, options, ancestors),
    );
    ancestors.delete(value);
    return out;
  }

  if (isPlainObject(value)) {
    if (ancestors.has(value)) {
      throw new InputSanitizationError(`${path} contains a circular reference`, {
        field: path,
      });
    }
    const keys = Object.keys(value);
    if (keys.length > options.maxKeys) {
      throw new InputSanitizationError(
        `${path} has ${keys.length} keys; maximum is ${options.maxKeys}`,
        { field: path, keys: keys.length, maxKeys: options.maxKeys },
      );
    }
    ancestors.add(value);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      // Never materialize prototype-pollution vectors on the result object.
      if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
        throw new InputSanitizationError(
          `${path} contains a forbidden key "${key}"`,
          { field: path, key },
        );
      }
      out[key] = walkValue(value[key], `${path}.${key}`, depth + 1, options, ancestors);
    }
    ancestors.delete(value);
    return out;
  }

  const leaf = sanitizeLeaf(value, path, options);
  if (leaf !== undefined) return leaf;

  // Dates, class instances, Maps, etc. are passed through untouched — they
  // are not plain JSON-representable input and cloning them would change
  // identity/semantics.
  return value;
}

/**
 * Deep-sanitize a plain-object payload before passing it to an SDK method.
 *
 * Recursively walks arrays/plain objects and:
 * - runs every string through {@link sanitizeString} (control chars, bidi
 *   overrides, length limits),
 * - rejects non-finite numbers, functions, symbols, and `undefined`,
 * - rejects forbidden keys (`__proto__`, `constructor`, `prototype`) to
 *   prevent prototype pollution,
 * - rejects payloads exceeding `maxDepth`/`maxKeys` or containing
 *   circular references.
 *
 * @param input   - Candidate payload.
 * @param options - Sanitization limits.
 * @returns A sanitized deep copy of plain structures.
 * @throws {InputSanitizationError} When any leaf or structure is unsafe.
 *
 * @example
 * sanitizeObject({ memo: "hi\u0000" }); // { memo: "hi" }
 */
export function sanitizeObject<T>(input: T, options: SanitizeObjectOptions = {}): T {
  const limits: Required<Omit<SanitizeObjectOptions, "field">> = {
    maxDepth: options.maxDepth ?? 8,
    maxKeys: options.maxKeys ?? 100,
    maxLength: options.maxLength ?? 10_000,
  };
  return walkValue(input, options.field ?? "input", 0, limits, new Set()) as T;
}



