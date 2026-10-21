/**
 * Enterprise Authentication Integration for StellarSplit SDK.
 *
 * Provides a pluggable, multi-strategy authentication provider that supports
 * API key, JWT, and OAuth2 credential types with automatic token refresh,
 * expiry checking, and a typed event emitter.
 *
 * No external dependencies — uses only the SDK's internal TypedEventEmitter.
 *
 * @example
 * ```ts
 * const auth = new EnterpriseAuthProvider({
 *   refreshThresholdMs: 60_000,          // refresh 1 min before expiry
 *   autoRefresh: true,
 * });
 *
 * auth.on("auth:success", ({ token }) => console.log("authenticated", token));
 *
 * await auth.authenticate({
 *   type: "jwt",
 *   value: "<signed-jwt>",
 *   metadata: { audience: "stellar-split-api" },
 * });
 * ```
 */

import { TypedEventEmitter } from "./events/TypedEventEmitter.js";

// ─── Public Types ────────────────────────────────────────────────────────────

/** The credential payload passed to {@link EnterpriseAuthProvider.authenticate}. */
export interface AuthCredentials {
  /** Authentication strategy to use. */
  type: "api-key" | "jwt" | "oauth2";
  /** The raw credential value (API key string, JWT token, or OAuth2 access token). */
  value: string;
  /** Optional provider-specific metadata (e.g. audience, scopes, tenant ID). */
  metadata?: Record<string, unknown>;
}

/** A resolved authentication token returned after a successful authentication. */
export interface AuthToken {
  /** The opaque token string to be attached to SDK requests. */
  token: string;
  /**
   * Unix epoch in **milliseconds** at which the token expires.
   * `0` or `Infinity` means the token never expires (e.g. static API keys).
   */
  expiresAt: number;
  /** Authentication strategy that produced this token. */
  type: string;
  /** Scopes granted to this token (may be empty for API-key auth). */
  scopes: string[];
}

/** Options for auto-refresh behaviour. */
export interface EnterpriseAuthProviderOptions {
  /**
   * How many milliseconds before expiry to trigger a proactive refresh.
   * Defaults to `60_000` (1 minute).
   */
  refreshThresholdMs?: number;
  /**
   * When `true`, the provider automatically calls {@link EnterpriseAuthProvider.refresh}
   * before the token expires (based on `refreshThresholdMs`).
   * Defaults to `false`.
   */
  autoRefresh?: boolean;
  /**
   * Optional factory to resolve a fresh token from a given set of credentials.
   * Inject this to connect to a real auth server; the default implementation
   * synthesises a token from the supplied credentials for testing purposes.
   */
  tokenResolver?: (credentials: AuthCredentials) => Promise<AuthToken>;
}

// ─── Event Map ───────────────────────────────────────────────────────────────

export interface EnterpriseAuthEvents {
  /** Fired after a successful authentication or token refresh. */
  "auth:success": { token: AuthToken };
  /** Fired when an authentication or refresh attempt fails. */
  "auth:failure": { error: Error; credentials?: AuthCredentials };
  /** Fired after a token has been proactively or manually refreshed. */
  "auth:refresh": { token: AuthToken; previousToken: AuthToken | null };
  /** Fired after `revoke()` clears the active token. */
  "auth:revoked": { token: AuthToken };
}

// ─── Default Token Resolver ──────────────────────────────────────────────────

/**
 * Built-in token resolver used when no custom `tokenResolver` is supplied.
 * Validates the credential structure and synthesises an {@link AuthToken}:
 *
 * - `api-key` → non-expiring token (expiresAt = 0), no scopes
 * - `jwt`     → decodes the expiry from the JWT payload (`exp` claim × 1000),
 *               falls back to 1 hour if the claim is absent or invalid
 * - `oauth2`  → expects `metadata.expiresIn` (seconds), defaults to 3600
 */
async function defaultTokenResolver(credentials: AuthCredentials): Promise<AuthToken> {
  const { type, value, metadata } = credentials;

  if (!value || typeof value !== "string" || value.trim() === "") {
    throw new Error(`[EnterpriseAuth] Credential value must be a non-empty string (type: ${type})`);
  }

  const now = Date.now();

  switch (type) {
    case "api-key": {
      return {
        token: value,
        expiresAt: 0, // API keys do not expire
        type: "api-key",
        scopes: (metadata?.scopes as string[] | undefined) ?? [],
      };
    }

    case "jwt": {
      let expiresAt = now + 60 * 60 * 1000; // default: 1 hour
      let scopes: string[] = [];

      try {
        const parts = value.split(".");
        if (parts.length === 3) {
          // Base64url-decode the payload
          const pad = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4);
          const payloadJson = Buffer.from(
            pad(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")),
            "base64",
          ).toString("utf8");
          const payload = JSON.parse(payloadJson) as Record<string, unknown>;

          if (typeof payload["exp"] === "number") {
            expiresAt = payload["exp"] * 1000;
          }
          if (Array.isArray(payload["scopes"])) {
            scopes = payload["scopes"] as string[];
          } else if (typeof payload["scope"] === "string") {
            scopes = payload["scope"].split(" ").filter(Boolean);
          }
        }
      } catch {
        // Malformed JWT payload — keep defaults
      }

      return {
        token: value,
        expiresAt,
        type: "jwt",
        scopes,
      };
    }

    case "oauth2": {
      const expiresInSec =
        typeof metadata?.["expiresIn"] === "number" ? (metadata["expiresIn"] as number) : 3600;

      const rawScopes = metadata?.["scopes"];
      const scopes: string[] = Array.isArray(rawScopes)
        ? (rawScopes as string[])
        : typeof rawScopes === "string"
          ? (rawScopes as string).split(" ").filter(Boolean)
          : [];

      return {
        token: value,
        expiresAt: now + expiresInSec * 1000,
        type: "oauth2",
        scopes,
      };
    }

    default: {
      // TypeScript exhaustiveness guard
      const _exhaustive: never = type;
      throw new Error(`[EnterpriseAuth] Unknown credential type: ${String(_exhaustive)}`);
    }
  }
}

// ─── EnterpriseAuthProvider ──────────────────────────────────────────────────

/**
 * Multi-strategy enterprise authentication provider for the StellarSplit SDK.
 *
 * Supports `api-key`, `jwt`, and `oauth2` credential types.  Tokens are cached
 * in-memory; the provider can auto-refresh them before expiry and emits typed
 * lifecycle events for observability.
 *
 * ### Thread / concurrency note
 * JavaScript is single-threaded, so concurrent calls to `authenticate()` may
 * each start a resolver round-trip.  If you need deduplication, wrap calls
 * with your own mutex or call `authenticate()` once at startup.
 */
export class EnterpriseAuthProvider extends TypedEventEmitter<EnterpriseAuthEvents> {
  private currentToken: AuthToken | null = null;
  private lastCredentials: AuthCredentials | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly refreshThresholdMs: number;
  private readonly autoRefresh: boolean;
  private readonly tokenResolver: (credentials: AuthCredentials) => Promise<AuthToken>;

  constructor(options: EnterpriseAuthProviderOptions = {}) {
    super();
    this.refreshThresholdMs = options.refreshThresholdMs ?? 60_000;
    this.autoRefresh = options.autoRefresh ?? false;
    this.tokenResolver = options.tokenResolver ?? defaultTokenResolver;
  }

  // ── Core API ───────────────────────────────────────────────────────────────

  /**
   * Authenticate with the given credentials and cache the resulting token.
   * Emits `auth:success` on success or `auth:failure` on error.
   *
   * @returns The resolved {@link AuthToken}.
   * @throws {Error} When the resolver rejects (the `auth:failure` event is
   *   also emitted before the error propagates).
   */
  async authenticate(credentials: AuthCredentials): Promise<AuthToken> {
    this._clearRefreshTimer();

    try {
      const token = await this.tokenResolver(credentials);
      this.currentToken = token;
      this.lastCredentials = credentials;
      this.emit("auth:success", { token });

      if (this.autoRefresh) {
        this._scheduleRefresh(token);
      }

      return token;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("auth:failure", { error, credentials });
      throw error;
    }
  }

  /**
   * Re-authenticate using the most recently supplied credentials.
   * Emits `auth:refresh` (and `auth:success`) on success, or `auth:failure`
   * on error.
   *
   * @throws {Error} When called before `authenticate()` has ever succeeded.
   */
  async refresh(): Promise<AuthToken> {
    if (!this.lastCredentials) {
      const error = new Error(
        "[EnterpriseAuth] Cannot refresh — no credentials have been authenticated yet",
      );
      this.emit("auth:failure", { error });
      throw error;
    }

    this._clearRefreshTimer();

    const previousToken = this.currentToken;

    try {
      const token = await this.tokenResolver(this.lastCredentials);
      this.currentToken = token;
      this.emit("auth:refresh", { token, previousToken });
      this.emit("auth:success", { token });

      if (this.autoRefresh) {
        this._scheduleRefresh(token);
      }

      return token;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("auth:failure", { error, credentials: this.lastCredentials });
      throw error;
    }
  }

  /**
   * Revoke (clear) the current token.
   * Emits `auth:revoked` if a token was active.
   * After revocation, `isAuthenticated()` returns `false` until the next
   * successful `authenticate()` call.
   */
  revoke(): void {
    this._clearRefreshTimer();

    if (this.currentToken) {
      const token = this.currentToken;
      this.currentToken = null;
      this.lastCredentials = null;
      this.emit("auth:revoked", { token });
    }
  }

  /**
   * Returns `true` when a token is held and it has not yet expired.
   * API-key tokens (`expiresAt === 0`) are treated as permanently valid.
   */
  isAuthenticated(): boolean {
    if (!this.currentToken) return false;
    return !this._isExpired(this.currentToken);
  }

  /**
   * Returns the current {@link AuthToken}, or `null` if no token is held or
   * the token has expired.
   */
  getToken(): AuthToken | null {
    if (!this.currentToken) return null;
    if (this._isExpired(this.currentToken)) return null;
    return this.currentToken;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Returns `true` when the given token has passed its `expiresAt` timestamp.
   * Tokens with `expiresAt === 0` (e.g. API keys) never expire.
   */
  private _isExpired(token: AuthToken): boolean {
    if (token.expiresAt === 0) return false; // non-expiring
    return Date.now() >= token.expiresAt;
  }

  /**
   * Returns `true` when the given token will expire within `refreshThresholdMs`.
   * Tokens with `expiresAt === 0` never need refreshing.
   */
  isTokenExpiringSoon(token?: AuthToken | null): boolean {
    const t = token ?? this.currentToken;
    if (!t) return false;
    if (t.expiresAt === 0) return false;
    return Date.now() >= t.expiresAt - this.refreshThresholdMs;
  }

  /**
   * Schedule an automatic refresh before the token expires.
   * The timer is set to fire `refreshThresholdMs` before `expiresAt`.
   * Non-expiring tokens are skipped.
   */
  private _scheduleRefresh(token: AuthToken): void {
    if (token.expiresAt === 0) return; // API keys do not expire

    const delay = token.expiresAt - Date.now() - this.refreshThresholdMs;
    if (delay <= 0) {
      // Already within (or past) the refresh window — refresh immediately
      void this.refresh().catch(() => {
        /* error already emitted via auth:failure */
      });
      return;
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().catch(() => {
        /* error already emitted via auth:failure */
      });
    }, delay);
  }

  /** Cancel any pending auto-refresh timer. */
  private _clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Dispose of the provider: cancel the auto-refresh timer and remove all
   * event listeners.  Call this when tearing down the SDK.
   */
  dispose(): void {
    this._clearRefreshTimer();
    this.removeAllListeners();
  }
}
