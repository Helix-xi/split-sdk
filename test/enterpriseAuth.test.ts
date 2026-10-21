import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EnterpriseAuthProvider,
  type AuthCredentials,
  type AuthToken,
  type EnterpriseAuthProviderOptions,
} from "../src/enterpriseAuth.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Craft a minimal HS256 JWT with arbitrary payload fields (no real signature). */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

/** Unix epoch in seconds N seconds from now. */
function nowPlusSec(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

/** Unix epoch in milliseconds N milliseconds from now. */
function nowPlusMs(ms: number): number {
  return Date.now() + ms;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("EnterpriseAuthProvider — constructor / defaults", () => {
  it("creates an instance with default options", () => {
    const auth = new EnterpriseAuthProvider();
    expect(auth).toBeDefined();
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.getToken()).toBeNull();
    auth.dispose();
  });

  it("creates an instance with explicit options", () => {
    const auth = new EnterpriseAuthProvider({
      refreshThresholdMs: 30_000,
      autoRefresh: false,
    });
    expect(auth).toBeDefined();
    auth.dispose();
  });
});

// ─── authenticate() ───────────────────────────────────────────────────────────

describe("EnterpriseAuthProvider.authenticate() — api-key", () => {
  let auth: EnterpriseAuthProvider;

  beforeEach(() => {
    auth = new EnterpriseAuthProvider();
  });
  afterEach(() => auth.dispose());

  it("resolves with a non-expiring AuthToken", async () => {
    const token = await auth.authenticate({ type: "api-key", value: "MY-SECRET-KEY" });

    expect(token.token).toBe("MY-SECRET-KEY");
    expect(token.type).toBe("api-key");
    expect(token.expiresAt).toBe(0);
    expect(token.scopes).toEqual([]);
  });

  it("sets isAuthenticated() to true after success", async () => {
    await auth.authenticate({ type: "api-key", value: "key-abc" });
    expect(auth.isAuthenticated()).toBe(true);
  });

  it("returns the token via getToken()", async () => {
    const token = await auth.authenticate({ type: "api-key", value: "key-xyz" });
    expect(auth.getToken()).toEqual(token);
  });

  it("emits auth:success", async () => {
    const handler = vi.fn();
    auth.on("auth:success", handler);
    const token = await auth.authenticate({ type: "api-key", value: "key-123" });
    expect(handler).toHaveBeenCalledWith({ token });
  });

  it("passes metadata scopes into the token", async () => {
    const token = await auth.authenticate({
      type: "api-key",
      value: "key-scoped",
      metadata: { scopes: ["read", "write"] },
    });
    expect(token.scopes).toEqual(["read", "write"]);
  });
});

describe("EnterpriseAuthProvider.authenticate() — jwt", () => {
  let auth: EnterpriseAuthProvider;

  beforeEach(() => {
    auth = new EnterpriseAuthProvider();
  });
  afterEach(() => auth.dispose());

  it("decodes expiresAt from the exp claim", async () => {
    const expSec = nowPlusSec(3600);
    const jwt = makeJwt({ sub: "user-1", exp: expSec });
    const token = await auth.authenticate({ type: "jwt", value: jwt });

    expect(token.type).toBe("jwt");
    expect(token.expiresAt).toBe(expSec * 1000);
  });

  it("decodes scopes from the scopes claim (array)", async () => {
    const jwt = makeJwt({ exp: nowPlusSec(3600), scopes: ["invoices:read", "invoices:write"] });
    const token = await auth.authenticate({ type: "jwt", value: jwt });
    expect(token.scopes).toEqual(["invoices:read", "invoices:write"]);
  });

  it("decodes scopes from the scope claim (space-delimited string)", async () => {
    const jwt = makeJwt({ exp: nowPlusSec(3600), scope: "invoices:read invoices:write" });
    const token = await auth.authenticate({ type: "jwt", value: jwt });
    expect(token.scopes).toEqual(["invoices:read", "invoices:write"]);
  });

  it("falls back to 1-hour expiry for JWTs without an exp claim", async () => {
    const jwt = makeJwt({ sub: "user-no-exp" });
    const before = Date.now();
    const token = await auth.authenticate({ type: "jwt", value: jwt });
    const after = Date.now();

    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 10);
    expect(token.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000 + 10);
  });

  it("falls back gracefully for a malformed JWT (wrong number of segments)", async () => {
    const token = await auth.authenticate({ type: "jwt", value: "not.a.jwt.at.all.here" });
    // Still resolves — with default expiry
    expect(token.type).toBe("jwt");
    expect(token.expiresAt).toBeGreaterThan(0);
  });

  it("emits auth:success on success", async () => {
    const handler = vi.fn();
    auth.on("auth:success", handler);
    const jwt = makeJwt({ exp: nowPlusSec(3600) });
    await auth.authenticate({ type: "jwt", value: jwt });
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("EnterpriseAuthProvider.authenticate() — oauth2", () => {
  let auth: EnterpriseAuthProvider;

  beforeEach(() => {
    auth = new EnterpriseAuthProvider();
  });
  afterEach(() => auth.dispose());

  it("uses metadata.expiresIn to set expiresAt", async () => {
    const before = Date.now();
    const token = await auth.authenticate({
      type: "oauth2",
      value: "access-token-abc",
      metadata: { expiresIn: 7200 },
    });
    const after = Date.now();

    expect(token.type).toBe("oauth2");
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 7200 * 1000 - 10);
    expect(token.expiresAt).toBeLessThanOrEqual(after + 7200 * 1000 + 10);
  });

  it("defaults to 3600s expiry when expiresIn is absent", async () => {
    const before = Date.now();
    const token = await auth.authenticate({ type: "oauth2", value: "access-token-def" });
    const after = Date.now();

    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 10);
    expect(token.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000 + 10);
  });

  it("parses metadata.scopes as array", async () => {
    const token = await auth.authenticate({
      type: "oauth2",
      value: "tok",
      metadata: { scopes: ["pay:write", "invoice:read"] },
    });
    expect(token.scopes).toEqual(["pay:write", "invoice:read"]);
  });

  it("parses metadata.scopes as space-delimited string", async () => {
    const token = await auth.authenticate({
      type: "oauth2",
      value: "tok",
      metadata: { scopes: "pay:write invoice:read" },
    });
    expect(token.scopes).toEqual(["pay:write", "invoice:read"]);
  });

  it("uses empty scopes when metadata is absent", async () => {
    const token = await auth.authenticate({ type: "oauth2", value: "tok" });
    expect(token.scopes).toEqual([]);
  });
});

describe("EnterpriseAuthProvider.authenticate() — failures", () => {
  it("throws and emits auth:failure when value is empty", async () => {
    const auth = new EnterpriseAuthProvider();
    const failureHandler = vi.fn();
    auth.on("auth:failure", failureHandler);

    await expect(
      auth.authenticate({ type: "api-key", value: "" }),
    ).rejects.toThrow(/non-empty string/i);

    expect(failureHandler).toHaveBeenCalledOnce();
    expect(failureHandler.mock.calls[0]![0].error).toBeInstanceOf(Error);
    auth.dispose();
  });

  it("throws and emits auth:failure when value is whitespace only", async () => {
    const auth = new EnterpriseAuthProvider();
    const failureHandler = vi.fn();
    auth.on("auth:failure", failureHandler);

    await expect(auth.authenticate({ type: "jwt", value: "   " })).rejects.toThrow();
    expect(failureHandler).toHaveBeenCalledOnce();
    auth.dispose();
  });

  it("emits auth:failure with credentials on resolver rejection", async () => {
    const resolver = vi.fn().mockRejectedValue(new Error("remote auth failed"));
    const auth = new EnterpriseAuthProvider({ tokenResolver: resolver });
    const failureHandler = vi.fn();
    auth.on("auth:failure", failureHandler);

    const creds: AuthCredentials = { type: "api-key", value: "key" };
    await expect(auth.authenticate(creds)).rejects.toThrow("remote auth failed");

    expect(failureHandler).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: creds }),
    );
    auth.dispose();
  });

  it("does not set a token on failure", async () => {
    const auth = new EnterpriseAuthProvider();
    try {
      await auth.authenticate({ type: "api-key", value: "" });
    } catch {
      /* expected */
    }
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.getToken()).toBeNull();
    auth.dispose();
  });
});

// ─── isAuthenticated() / getToken() ──────────────────────────────────────────

describe("EnterpriseAuthProvider — isAuthenticated / getToken", () => {
  it("returns false before any authentication", () => {
    const auth = new EnterpriseAuthProvider();
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.getToken()).toBeNull();
    auth.dispose();
  });

  it("returns false when the token is expired", async () => {
    const auth = new EnterpriseAuthProvider();
    // Resolver returns an already-expired token
    const resolver = vi.fn().mockResolvedValue({
      token: "expired",
      expiresAt: Date.now() - 1000,
      type: "jwt",
      scopes: [],
    } satisfies AuthToken);

    const auth2 = new EnterpriseAuthProvider({ tokenResolver: resolver });
    await auth2.authenticate({ type: "jwt", value: "tok" });

    expect(auth2.isAuthenticated()).toBe(false);
    expect(auth2.getToken()).toBeNull();
    auth.dispose();
    auth2.dispose();
  });

  it("returns true for a non-expiring api-key token", async () => {
    const auth = new EnterpriseAuthProvider();
    await auth.authenticate({ type: "api-key", value: "forever-key" });
    expect(auth.isAuthenticated()).toBe(true);
    auth.dispose();
  });

  it("returns true for a not-yet-expired token", async () => {
    const auth = new EnterpriseAuthProvider();
    const resolver = vi.fn().mockResolvedValue({
      token: "valid",
      expiresAt: nowPlusMs(60_000),
      type: "oauth2",
      scopes: [],
    } satisfies AuthToken);
    const auth2 = new EnterpriseAuthProvider({ tokenResolver: resolver });
    await auth2.authenticate({ type: "oauth2", value: "tok" });

    expect(auth2.isAuthenticated()).toBe(true);
    expect(auth2.getToken()).not.toBeNull();
    auth.dispose();
    auth2.dispose();
  });
});

// ─── refresh() ───────────────────────────────────────────────────────────────

describe("EnterpriseAuthProvider.refresh()", () => {
  it("throws if called before authenticate()", async () => {
    const auth = new EnterpriseAuthProvider();
    await expect(auth.refresh()).rejects.toThrow(/no credentials/i);
    auth.dispose();
  });

  it("emits auth:failure if called before authenticate() (no credentials)", async () => {
    const auth = new EnterpriseAuthProvider();
    const handler = vi.fn();
    auth.on("auth:failure", handler);
    await expect(auth.refresh()).rejects.toThrow();
    expect(handler).toHaveBeenCalledOnce();
    auth.dispose();
  });

  it("re-uses last credentials and returns a new token", async () => {
    let callCount = 0;
    const tokens: AuthToken[] = [
      { token: "token-v1", expiresAt: nowPlusMs(60_000), type: "oauth2", scopes: [] },
      { token: "token-v2", expiresAt: nowPlusMs(120_000), type: "oauth2", scopes: [] },
    ];
    const resolver = vi.fn().mockImplementation(async () => tokens[callCount++]!);

    const auth = new EnterpriseAuthProvider({ tokenResolver: resolver });
    await auth.authenticate({ type: "oauth2", value: "access-token" });

    const refreshed = await auth.refresh();
    expect(refreshed.token).toBe("token-v2");
    auth.dispose();
  });

  it("emits auth:refresh with previous token", async () => {
    let callCount = 0;
    const tokens: AuthToken[] = [
      { token: "old-token", expiresAt: nowPlusMs(5000), type: "jwt", scopes: [] },
      { token: "new-token", expiresAt: nowPlusMs(10_000), type: "jwt", scopes: [] },
    ];
    const resolver = vi.fn().mockImplementation(async () => tokens[callCount++]!);

    const auth = new EnterpriseAuthProvider({ tokenResolver: resolver });
    const firstToken = await auth.authenticate({ type: "jwt", value: "j" });

    const refreshHandler = vi.fn();
    auth.on("auth:refresh", refreshHandler);
    await auth.refresh();

    expect(refreshHandler).toHaveBeenCalledWith({
      token: tokens[1],
      previousToken: firstToken,
    });
    auth.dispose();
  });

  it("emits auth:success after auth:refresh", async () => {
    let callCount = 0;
    const tokens: AuthToken[] = [
      { token: "t1", expiresAt: nowPlusMs(5000), type: "jwt", scopes: [] },
      { token: "t2", expiresAt: nowPlusMs(10_000), type: "jwt", scopes: [] },
    ];
    const resolver = vi.fn().mockImplementation(async () => tokens[callCount++]!);

    const auth = new EnterpriseAuthProvider({ tokenResolver: resolver });
    await auth.authenticate({ type: "jwt", value: "j" });

    const successHandler = vi.fn();
    auth.on("auth:success", successHandler);
    await auth.refresh();

    expect(successHandler).toHaveBeenCalledWith({ token: tokens[1] });
    auth.dispose();
  });

  it("emits auth:failure and throws on resolver rejection during refresh", async () => {
    let callCount = 0;
    const resolver = vi.fn().mockImplementation(async () => {
      if (callCount++ === 0) {
        return { token: "t1", expiresAt: nowPlusMs(5000), type: "jwt", scopes: [] } as AuthToken;
      }
      throw new Error("refresh rejected");
    });

    const auth = new EnterpriseAuthProvider({ tokenResolver: resolver });
    await auth.authenticate({ type: "jwt", value: "j" });

    const failureHandler = vi.fn();
    auth.on("auth:failure", failureHandler);

    await expect(auth.refresh()).rejects.toThrow("refresh rejected");
    expect(failureHandler).toHaveBeenCalledOnce();
    auth.dispose();
  });
});

// ─── revoke() ────────────────────────────────────────────────────────────────

describe("EnterpriseAuthProvider.revoke()", () => {
  it("clears the current token", async () => {
    const auth = new EnterpriseAuthProvider();
    await auth.authenticate({ type: "api-key", value: "key" });
    expect(auth.isAuthenticated()).toBe(true);

    auth.revoke();
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.getToken()).toBeNull();
    auth.dispose();
  });

  it("emits auth:revoked with the revoked token", async () => {
    const auth = new EnterpriseAuthProvider();
    const token = await auth.authenticate({ type: "api-key", value: "key" });

    const revokedHandler = vi.fn();
    auth.on("auth:revoked", revokedHandler);
    auth.revoke();

    expect(revokedHandler).toHaveBeenCalledWith({ token });
    auth.dispose();
  });

  it("is a no-op when no token is held", () => {
    const auth = new EnterpriseAuthProvider();
    const revokedHandler = vi.fn();
    auth.on("auth:revoked", revokedHandler);

    expect(() => auth.revoke()).not.toThrow();
    expect(revokedHandler).not.toHaveBeenCalled();
    auth.dispose();
  });

  it("prevents refresh after revoke", async () => {
    const auth = new EnterpriseAuthProvider();
    await auth.authenticate({ type: "api-key", value: "key" });
    auth.revoke();

    await expect(auth.refresh()).rejects.toThrow(/no credentials/i);
    auth.dispose();
  });
});

// ─── isTokenExpiringSoon() ────────────────────────────────────────────────────

describe("EnterpriseAuthProvider.isTokenExpiringSoon()", () => {
  it("returns false for non-expiring tokens (expiresAt === 0)", async () => {
    const auth = new EnterpriseAuthProvider({ refreshThresholdMs: 60_000 });
    await auth.authenticate({ type: "api-key", value: "k" });
    expect(auth.isTokenExpiringSoon()).toBe(false);
    auth.dispose();
  });

  it("returns true when within the refresh threshold", () => {
    const auth = new EnterpriseAuthProvider({ refreshThresholdMs: 60_000 });
    const token: AuthToken = {
      token: "t",
      expiresAt: nowPlusMs(30_000), // expires in 30s, threshold is 60s
      type: "jwt",
      scopes: [],
    };
    expect(auth.isTokenExpiringSoon(token)).toBe(true);
    auth.dispose();
  });

  it("returns false when well outside the refresh threshold", () => {
    const auth = new EnterpriseAuthProvider({ refreshThresholdMs: 60_000 });
    const token: AuthToken = {
      token: "t",
      expiresAt: nowPlusMs(300_000), // expires in 5 min, threshold 60s
      type: "jwt",
      scopes: [],
    };
    expect(auth.isTokenExpiringSoon(token)).toBe(false);
    auth.dispose();
  });

  it("returns false when no token is held", () => {
    const auth = new EnterpriseAuthProvider();
    expect(auth.isTokenExpiringSoon()).toBe(false);
    auth.dispose();
  });

  it("checks the current token when no argument is passed", async () => {
    const resolver = vi.fn().mockResolvedValue({
      token: "t",
      expiresAt: nowPlusMs(30_000),
      type: "jwt",
      scopes: [],
    } satisfies AuthToken);
    const auth = new EnterpriseAuthProvider({
      tokenResolver: resolver,
      refreshThresholdMs: 60_000,
    });
    await auth.authenticate({ type: "jwt", value: "j" });
    expect(auth.isTokenExpiringSoon()).toBe(true);
    auth.dispose();
  });
});

// ─── Auto-refresh ─────────────────────────────────────────────────────────────

describe("EnterpriseAuthProvider — autoRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules a refresh before the token expires", async () => {
    const expiresInMs = 120_000; // 2 minutes
    const thresholdMs = 30_000; // refresh 30s before expiry

    let callCount = 0;
    const resolver = vi.fn().mockImplementation(async () => ({
      token: `token-${callCount++}`,
      expiresAt: Date.now() + expiresInMs,
      type: "oauth2",
      scopes: [],
    }));

    const auth = new EnterpriseAuthProvider({
      tokenResolver: resolver,
      autoRefresh: true,
      refreshThresholdMs: thresholdMs,
    });

    await auth.authenticate({ type: "oauth2", value: "tok" });
    expect(resolver).toHaveBeenCalledTimes(1);

    // Advance to just before the refresh window — no refresh yet
    await vi.advanceTimersByTimeAsync(expiresInMs - thresholdMs - 100);
    expect(resolver).toHaveBeenCalledTimes(1);

    // Advance past the refresh trigger point
    await vi.advanceTimersByTimeAsync(200);
    expect(resolver).toHaveBeenCalledTimes(2);

    auth.dispose();
  });

  it("skips scheduling for non-expiring api-key tokens", async () => {
    const resolver = vi.fn().mockResolvedValue({
      token: "api-key",
      expiresAt: 0,
      type: "api-key",
      scopes: [],
    } satisfies AuthToken);

    const auth = new EnterpriseAuthProvider({
      tokenResolver: resolver,
      autoRefresh: true,
    });

    await auth.authenticate({ type: "api-key", value: "k" });

    // No refresh should be scheduled — advancing time should not trigger resolver again
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(resolver).toHaveBeenCalledTimes(1);

    auth.dispose();
  });

  it("cancels the scheduled refresh on revoke", async () => {
    const resolver = vi.fn().mockResolvedValue({
      token: "tok",
      expiresAt: Date.now() + 120_000,
      type: "jwt",
      scopes: [],
    } satisfies AuthToken);

    const auth = new EnterpriseAuthProvider({
      tokenResolver: resolver,
      autoRefresh: true,
      refreshThresholdMs: 30_000,
    });

    await auth.authenticate({ type: "jwt", value: "j" });
    auth.revoke(); // should cancel timer

    await vi.advanceTimersByTimeAsync(200_000); // well past when refresh would fire
    expect(resolver).toHaveBeenCalledTimes(1); // only the initial authenticate
    auth.dispose();
  });
});

// ─── Custom tokenResolver ─────────────────────────────────────────────────────

describe("EnterpriseAuthProvider — custom tokenResolver", () => {
  it("delegates to the injected resolver", async () => {
    const customToken: AuthToken = {
      token: "custom-token-123",
      expiresAt: nowPlusMs(3600_000),
      type: "oauth2",
      scopes: ["read", "write"],
    };
    const resolver = vi.fn().mockResolvedValue(customToken);

    const auth = new EnterpriseAuthProvider({ tokenResolver: resolver });
    const token = await auth.authenticate({ type: "oauth2", value: "bearer-xyz" });

    expect(token).toEqual(customToken);
    expect(resolver).toHaveBeenCalledWith({ type: "oauth2", value: "bearer-xyz" });
    auth.dispose();
  });

  it("calls the resolver with the full credentials (including metadata)", async () => {
    const resolver = vi.fn().mockResolvedValue({
      token: "t",
      expiresAt: 0,
      type: "api-key",
      scopes: [],
    } satisfies AuthToken);

    const auth = new EnterpriseAuthProvider({ tokenResolver: resolver });
    const creds: AuthCredentials = {
      type: "api-key",
      value: "k",
      metadata: { tenantId: "acme-corp" },
    };
    await auth.authenticate(creds);

    expect(resolver).toHaveBeenCalledWith(creds);
    auth.dispose();
  });
});

// ─── Event emitter API ────────────────────────────────────────────────────────

describe("EnterpriseAuthProvider — event emitter", () => {
  it("supports multiple listeners for the same event", async () => {
    const auth = new EnterpriseAuthProvider();
    const h1 = vi.fn();
    const h2 = vi.fn();
    auth.on("auth:success", h1);
    auth.on("auth:success", h2);

    await auth.authenticate({ type: "api-key", value: "k" });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
    auth.dispose();
  });

  it("supports unsubscribing a listener", async () => {
    const auth = new EnterpriseAuthProvider();
    const handler = vi.fn();
    const unsubscribe = auth.on("auth:success", handler);

    unsubscribe();
    await auth.authenticate({ type: "api-key", value: "k" });
    expect(handler).not.toHaveBeenCalled();
    auth.dispose();
  });

  it("supports wildcard * listener receiving all events", async () => {
    const auth = new EnterpriseAuthProvider();
    const events: string[] = [];
    auth.on("*", (event) => events.push(String(event)));

    await auth.authenticate({ type: "api-key", value: "k" });
    auth.revoke();

    expect(events).toContain("auth:success");
    expect(events).toContain("auth:revoked");
    auth.dispose();
  });

  it("dispose() removes all listeners", async () => {
    const auth = new EnterpriseAuthProvider();
    const handler = vi.fn();
    auth.on("auth:success", handler);

    auth.dispose();
    // Directly emit to verify listeners are cleared
    // (Re-authentication after dispose would use a cleared emitter)
    await auth.authenticate({ type: "api-key", value: "k" }).catch(() => {});
    expect(handler).not.toHaveBeenCalled();
  });
});

// ─── Concurrent authenticate() calls ─────────────────────────────────────────

describe("EnterpriseAuthProvider — concurrent calls", () => {
  it("last-wins when authenticate is called concurrently", async () => {
    let counter = 0;
    const resolver = vi.fn().mockImplementation(async (creds: AuthCredentials) => ({
      token: `token-${counter++}`,
      expiresAt: nowPlusMs(3600_000),
      type: creds.type,
      scopes: [],
    }));

    const auth = new EnterpriseAuthProvider({ tokenResolver: resolver });

    const [t1, t2] = await Promise.all([
      auth.authenticate({ type: "oauth2", value: "a" }),
      auth.authenticate({ type: "oauth2", value: "b" }),
    ]);

    // Both calls must have resolved successfully
    expect(t1.token).toMatch(/^token-/);
    expect(t2.token).toMatch(/^token-/);
    // The stored token must be one of the two resolved tokens
    expect([t1.token, t2.token]).toContain(auth.getToken()?.token);
    auth.dispose();
  });
});

// ─── Type-level smoke test ────────────────────────────────────────────────────

describe("EnterpriseAuthProvider — type exports", () => {
  it("AuthCredentials and AuthToken shapes are type-compatible", () => {
    const creds: AuthCredentials = { type: "jwt", value: "tok", metadata: { key: "val" } };
    const token: AuthToken = { token: "t", expiresAt: 0, type: "jwt", scopes: ["r"] };

    expect(creds.type).toBe("jwt");
    expect(token.scopes).toHaveLength(1);
  });
});
