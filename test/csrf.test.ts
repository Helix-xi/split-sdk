/**
 * Tests for #1059 — CSRF protection utilities.
 *
 * Covers:
 * - generateCsrfToken: entropy, uniqueness, base64url format, config limits
 * - hashCsrfToken: deterministic SHA-256 digests
 * - csrfTokensMatch: constant-time-safe equality semantics
 * - extractCsrfToken: case-insensitive header lookup, arrays, empty values
 * - CsrfTokenManager: issue/validate/consume/rotate/revoke, TTL expiry,
 *   LRU-bounded storage, cleanup, configuration and session validation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CsrfError,
  CsrfTokenManager,
  csrfTokensMatch,
  extractCsrfToken,
  generateCsrfToken,
  hashCsrfToken,
} from "../src/csrf.js";

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

describe("generateCsrfToken", () => {
  it("produces unique base64url tokens", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateCsrfToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("defaults to 32 bytes (43 base64url chars) of entropy", () => {
    expect(generateCsrfToken().length).toBe(43);
    expect(generateCsrfToken(64).length).toBe(86);
  });

  it("rejects tokenBytes below 16 or non-integers", () => {
    expect(() => generateCsrfToken(15)).toThrow(CsrfError);
    expect(() => generateCsrfToken(32.5)).toThrow(CsrfError);
    expect(() => generateCsrfToken(0)).toThrow(CsrfError);
  });
});

describe("hashCsrfToken", () => {
  it("returns a deterministic 64-char hex digest", () => {
    const token = generateCsrfToken();
    const digest = hashCsrfToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCsrfToken(token)).toBe(digest);
  });

  it("hashes different tokens to different digests", () => {
    expect(hashCsrfToken("a")).not.toBe(hashCsrfToken("b"));
  });
});

describe("csrfTokensMatch", () => {
  it("matches identical tokens only", () => {
    const token = generateCsrfToken();
    expect(csrfTokensMatch(token, token)).toBe(true);
    expect(csrfTokensMatch(token, `${token}x`)).toBe(false);
    expect(csrfTokensMatch("short", "much-longer-token")).toBe(false);
  });

  it("rejects empty and non-string operands", () => {
    expect(csrfTokensMatch("", "")).toBe(false);
    expect(csrfTokensMatch("abc", "")).toBe(false);
    expect(csrfTokensMatch(null as unknown as string, "abc")).toBe(false);
  });
});

describe("extractCsrfToken", () => {
  it("reads the default header case-insensitively", () => {
    expect(extractCsrfToken({ "X-CSRF-Token": "tok" })).toBe("tok");
    expect(extractCsrfToken({ [CSRF_HEADER_NAME]: "tok" })).toBe("tok");
  });

  it("uses the first value of array headers", () => {
    expect(extractCsrfToken({ "x-csrf-token": ["first", "second"] })).toBe("first");
  });

  it("returns null for missing or empty tokens", () => {
    expect(extractCsrfToken({})).toBeNull();
    expect(extractCsrfToken({ "x-csrf-token": "   " })).toBeNull();
    expect(extractCsrfToken({ "x-csrf-token": undefined })).toBeNull();
  });

  it("honors a custom header name", () => {
    expect(extractCsrfToken({ "x-requested-with": "abc" }, "X-Requested-With")).toBe(
      "abc",
    );
  });
});

describe("exported constants", () => {
  it("uses conventional header and cookie names", () => {
    expect(CSRF_HEADER_NAME).toBe("x-csrf-token");
    expect(CSRF_COOKIE_NAME).toBe("xsrf-token");
  });
});

// ---------------------------------------------------------------------------
// CsrfTokenManager
// ---------------------------------------------------------------------------

describe("CsrfTokenManager", () => {
  it("issues a token that validates for its session only", () => {
    const csrf = new CsrfTokenManager();
    const token = csrf.issueToken("session-1");
    expect(csrf.validateToken("session-1", token)).toBe(true);
    expect(csrf.validateToken("session-1", `${token}tampered`)).toBe(false);
    expect(csrf.validateToken("session-2", token)).toBe(false);
    expect(csrf.validateToken("session-1", "")).toBe(false);
    expect(csrf.size).toBe(1);
  });

  it("never returns false for unknown sessions or wrong tokens", () => {
    const csrf = new CsrfTokenManager();
    const token = csrf.issueToken("session-1");
    expect(csrf.validateToken("unknown", token)).toBe(false);
    expect(csrf.validateToken("session-1", generateCsrfToken())).toBe(false);
  });

  it("supports single-use tokens via consume", () => {
    const csrf = new CsrfTokenManager();
    const token = csrf.issueToken("session-1");
    expect(csrf.validateToken("session-1", token, { consume: true })).toBe(true);
    expect(csrf.validateToken("session-1", token)).toBe(false);
  });

  it("rotates tokens, invalidating the previous one", () => {
    const csrf = new CsrfTokenManager();
    const oldToken = csrf.issueToken("session-1");
    const newToken = csrf.rotateToken("session-1");
    expect(newToken).not.toBe(oldToken);
    expect(csrf.validateToken("session-1", oldToken)).toBe(false);
    expect(csrf.validateToken("session-1", newToken)).toBe(true);
  });

  it("revokes single sessions and all sessions", () => {
    const csrf = new CsrfTokenManager();
    const tokenA = csrf.issueToken("a");
    const tokenB = csrf.issueToken("b");
    expect(csrf.revokeToken("a")).toBe(true);
    expect(csrf.revokeToken("missing")).toBe(false);
    expect(csrf.validateToken("a", tokenA)).toBe(false);
    expect(csrf.validateToken("b", tokenB)).toBe(true);
    csrf.revokeAll();
    expect(csrf.size).toBe(0);
    expect(csrf.validateToken("b", tokenB)).toBe(false);
  });

  it("rejects empty and oversized session ids", () => {
    const csrf = new CsrfTokenManager();
    expect(() => csrf.issueToken("")).toThrow(CsrfError);
    expect(() => csrf.issueToken("   ")).toThrow(CsrfError);
    expect(() => csrf.issueToken("x".repeat(300))).toThrow(CsrfError);
    expect(() => csrf.validateToken("", "token")).toThrow(CsrfError);
  });

  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("expires tokens after ttlMs", () => {
      const csrf = new CsrfTokenManager({ ttlMs: 1_000 });
      const token = csrf.issueToken("session-1");
      vi.advanceTimersByTime(999);
      expect(csrf.validateToken("session-1", token)).toBe(true);
      vi.advanceTimersByTime(2);
      expect(csrf.validateToken("session-1", token)).toBe(false);
    });

    it("cleanup removes expired entries only", () => {
      const csrf = new CsrfTokenManager({ ttlMs: 1_000 });
      csrf.issueToken("old-1");
      csrf.issueToken("old-2");
      vi.advanceTimersByTime(1_500);
      csrf.issueToken("fresh");
      expect(csrf.cleanup()).toBe(2);
      expect(csrf.size).toBe(1);
      expect(csrf.cleanup()).toBe(0);
    });
  });

  it("bounds storage with least-recently-used eviction", () => {
    const csrf = new CsrfTokenManager({ maxSessions: 3 });
    const tokenA = csrf.issueToken("a");
    const tokenB = csrf.issueToken("b");
    csrf.issueToken("c");
    // Touch "a" so "b" becomes the least recently used.
    expect(csrf.validateToken("a", tokenA)).toBe(true);
    csrf.issueToken("d");
    expect(csrf.size).toBe(3);
    expect(csrf.validateToken("b", tokenB)).toBe(false); // evicted
  });

  it("validates configuration", () => {
    expect(() => new CsrfTokenManager({ ttlMs: 0 })).toThrow(CsrfError);
    expect(() => new CsrfTokenManager({ ttlMs: -5 })).toThrow(CsrfError);
    expect(() => new CsrfTokenManager({ tokenBytes: 8 })).toThrow(CsrfError);
    expect(() => new CsrfTokenManager({ maxSessions: 0 })).toThrow(CsrfError);
  });

  it("honors custom tokenBytes", () => {
    const csrf = new CsrfTokenManager({ tokenBytes: 16 });
    expect(csrf.issueToken("s").length).toBe(22);
  });
});

