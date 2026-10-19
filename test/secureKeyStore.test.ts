/**
 * Tests for #1060 — secure private-key storage.
 *
 * Covers:
 * - Storage API: setSecret/getSecret/hasSecret/listSecrets/deleteSecret
 * - Encryption: ciphertext at rest never contains the secret, fresh IVs,
 *   wrong-key and tampering detection (AES-256-GCM auth tag)
 * - Key rotation: rotateMasterKey re-encrypts everything; old key becomes
 *   unreadable; invalid new keys rejected
 * - Cleanup: cleanup() purges the backend; destroy() zeroizes the master key
 *   and disables the instance
 * - Derivation: deterministic PBKDF2 output and input validation
 * - Backend injection and id/secret validation
 */

import { describe, expect, it } from "vitest";
import {
  KeyIntegrityError,
  KeyNotFoundError,
  KeyRotationError,
  KeyStorageError,
  MemoryKeyStoreBackend,
  SecureKeyStore,
} from "../src/secureKeyStore.js";

const SECRET = "SC6HDG7LBUN4G4S6O2X3I5JZ3PZQ7N4L2M1K0J9I8H7G6F5D4S3A2W1Q0P";

function makeStore(): { store: SecureKeyStore; backend: MemoryKeyStoreBackend } {
  const backend = new MemoryKeyStoreBackend();
  const store = new SecureKeyStore({
    masterKey: SecureKeyStore.generateMasterKey(),
    backend,
  });
  return { store, backend };
}

// ---------------------------------------------------------------------------
// Storage API
// ---------------------------------------------------------------------------

describe("SecureKeyStore — storage API", () => {
  it("round-trips a secret", async () => {
    const { store } = makeStore();
    expect(await store.hasSecret("wallet-1")).toBe(false);
    await store.setSecret("wallet-1", SECRET);
    expect(await store.hasSecret("wallet-1")).toBe(true);
    expect(await store.getSecret("wallet-1")).toBe(SECRET);
  });

  it("lists ids without exposing key material", async () => {
    const { store } = makeStore();
    await store.setSecret("b-key", SECRET);
    await store.setSecret("a-key", SECRET);
    expect(await store.listSecrets()).toEqual(["a-key", "b-key"]);
  });

  it("deletes secrets", async () => {
    const { store } = makeStore();
    await store.setSecret("wallet-1", SECRET);
    await store.deleteSecret("wallet-1");
    expect(await store.hasSecret("wallet-1")).toBe(false);
    await expect(store.getSecret("wallet-1")).rejects.toThrow(KeyNotFoundError);
  });

  it("throws KeyNotFoundError for missing ids", async () => {
    const { store } = makeStore();
    await expect(store.getSecret("missing")).rejects.toThrow(KeyNotFoundError);
  });

  it("validates ids and secrets", async () => {
    const { store } = makeStore();
    await expect(store.setSecret("", SECRET)).rejects.toThrow(KeyStorageError);
    await expect(store.setSecret("bad\u0000id", SECRET)).rejects.toThrow(
      KeyStorageError,
    );
    await expect(store.setSecret("x".repeat(200), SECRET)).rejects.toThrow(
      KeyStorageError,
    );
    await expect(store.setSecret("wallet-1", "")).rejects.toThrow(KeyStorageError);
    await expect(store.setSecret("wallet-1", "x".repeat(5_000))).rejects.toThrow(
      KeyStorageError,
    );
  });
});

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

describe("SecureKeyStore — encryption", () => {
  it("never stores the plaintext secret in the backend", async () => {
    const { store, backend } = makeStore();
    await store.setSecret("wallet-1", SECRET);
    const raw = await backend.read("wallet-1");
    expect(raw).not.toBeNull();
    expect(raw!).not.toContain(SECRET);
    expect(raw!).not.toContain("SC6HDG7");
    const record = JSON.parse(raw!) as { iv: string; tag: string; ciphertext: string };
    expect(record.iv).toBeTruthy();
    expect(record.tag).toBeTruthy();
    expect(record.ciphertext).toBeTruthy();
  });

  it("uses a fresh IV and ciphertext for every write", async () => {
    const { store, backend } = makeStore();
    await store.setSecret("wallet-1", SECRET);
    const first = JSON.parse((await backend.read("wallet-1"))!) as {
      iv: string;
      ciphertext: string;
    };
    await store.setSecret("wallet-1", SECRET);
    const second = JSON.parse((await backend.read("wallet-1"))!) as {
      iv: string;
      ciphertext: string;
    };
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("rejects reads under the wrong master key", async () => {
    const { store, backend } = makeStore();
    await store.setSecret("wallet-1", SECRET);
    const impostor = new SecureKeyStore({
      masterKey: SecureKeyStore.generateMasterKey(),
      backend,
    });
    await expect(impostor.getSecret("wallet-1")).rejects.toThrow(KeyIntegrityError);
  });

  it("detects tampered ciphertext", async () => {
    const { store, backend } = makeStore();
    await store.setSecret("wallet-1", SECRET);
    const record = JSON.parse((await backend.read("wallet-1"))!) as {
      ciphertext: string;
    };
    record.ciphertext = Buffer.from("tampered-payload").toString("base64");
    await backend.write("wallet-1", JSON.stringify(record));
    await expect(store.getSecret("wallet-1")).rejects.toThrow(KeyIntegrityError);
  });

  it("detects corrupt record envelopes", async () => {
    const { store, backend } = makeStore();
    await backend.write("wallet-1", "not-json");
    await expect(store.getSecret("wallet-1")).rejects.toThrow(KeyIntegrityError);
    await backend.write("wallet-1", JSON.stringify({ version: 99 }));
    await expect(store.getSecret("wallet-1")).rejects.toThrow(KeyIntegrityError);
  });
});

// ---------------------------------------------------------------------------
// Key rotation
// ---------------------------------------------------------------------------

describe("SecureKeyStore — key rotation", () => {
  it("re-encrypts every secret under the new master key", async () => {
    const { store, backend } = makeStore();
    await store.setSecret("a", SECRET);
    await store.setSecret("b", `${SECRET}2`);
    const newKey = SecureKeyStore.generateMasterKey();

    await store.rotateMasterKey(newKey);

    // Same store (now holding the new key) still reads everything.
    expect(await store.getSecret("a")).toBe(SECRET);
    expect(await store.getSecret("b")).toBe(`${SECRET}2`);

    // A reader holding a different key is locked out.
    const impostor = new SecureKeyStore({
      masterKey: SecureKeyStore.generateMasterKey(),
      backend,
    });
    await expect(impostor.getSecret("a")).rejects.toThrow(KeyIntegrityError);

    // A reader holding the rotated key can decrypt.
    const newKeyReader = new SecureKeyStore({ masterKey: newKey, backend });
    expect(await newKeyReader.getSecret("a")).toBe(SECRET);
  });

  it("rotating to an invalid key fails before any record changes", async () => {
    const { store, backend } = makeStore();
    await store.setSecret("a", SECRET);
    const before = await backend.read("a");

    await expect(store.rotateMasterKey(new Uint8Array(16))).rejects.toThrow(
      KeyRotationError,
    );
    expect(await backend.read("a")).toBe(before);
    expect(await store.getSecret("a")).toBe(SECRET);
  });

  it("preserves createdAt across rotation", async () => {
    const { store, backend } = makeStore();
    await store.setSecret("a", SECRET);
    const before = JSON.parse((await backend.read("a"))!) as { createdAt: number };
    await store.rotateMasterKey(SecureKeyStore.generateMasterKey());
    const after = JSON.parse((await backend.read("a"))!) as { createdAt: number };
    expect(after.createdAt).toBe(before.createdAt);
  });

  it("supports rotating an empty store", async () => {
    const { store } = makeStore();
    await store.rotateMasterKey(SecureKeyStore.generateMasterKey());
    expect(await store.listSecrets()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cleanup and destroy
// ---------------------------------------------------------------------------

describe("SecureKeyStore — cleanup", () => {
  it("cleanup purges every record but keeps the store usable", async () => {
    const { store, backend } = makeStore();
    await store.setSecret("a", SECRET);
    await store.setSecret("b", SECRET);
    await store.cleanup();
    expect(await backend.listIds()).toEqual([]);
    expect(await store.listSecrets()).toEqual([]);
    // Still usable afterwards.
    await store.setSecret("c", SECRET);
    expect(await store.getSecret("c")).toBe(SECRET);
  });

  it("destroy zeroizes the master key and disables the instance", async () => {
    const store = new SecureKeyStore({
      masterKey: SecureKeyStore.generateMasterKey(),
      backend: new MemoryKeyStoreBackend(),
    });
    await store.setSecret("a", SECRET);

    store.destroy();

    // The store's internal copy of the key is wiped…
    const internalKey = (store as unknown as { _masterKey: Uint8Array })._masterKey;
    expect(internalKey.every((byte) => byte === 0)).toBe(true);
    // …and every operation is refused afterwards.
    await expect(store.getSecret("a")).rejects.toThrow(KeyStorageError);
    await expect(store.setSecret("b", SECRET)).rejects.toThrow(KeyStorageError);
    await expect(store.hasSecret("a")).rejects.toThrow(KeyStorageError);
    await expect(store.listSecrets()).rejects.toThrow(KeyStorageError);
    await expect(store.cleanup()).rejects.toThrow(KeyStorageError);
    expect(() => store.destroy()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Derivation and construction
// ---------------------------------------------------------------------------

describe("SecureKeyStore — key derivation", () => {
  it("derives deterministic keys from passphrase + salt", async () => {
    const salt = Buffer.alloc(16, 3);
    const key1 = await SecureKeyStore.deriveMasterKey("passphrase-long", salt, 10_000);
    const key2 = await SecureKeyStore.deriveMasterKey("passphrase-long", salt, 10_000);
    expect(key1.length).toBe(32);
    expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(true);

    const otherSalt = await SecureKeyStore.deriveMasterKey(
      "passphrase-long",
      Buffer.alloc(16, 4),
      10_000,
    );
    expect(Buffer.from(key1).equals(Buffer.from(otherSalt))).toBe(false);
  });

  it("validates derivation inputs", async () => {
    const salt = Buffer.alloc(16, 3);
    await expect(SecureKeyStore.deriveMasterKey("", salt, 10_000)).rejects.toThrow(
      KeyStorageError,
    );
    await expect(
      SecureKeyStore.deriveMasterKey("pass", Buffer.alloc(8, 1), 10_000),
    ).rejects.toThrow(KeyStorageError);
    await expect(SecureKeyStore.deriveMasterKey("pass", salt, 10)).rejects.toThrow(
      KeyStorageError,
    );
  });

  it("derived keys work as store master keys", async () => {
    const backend = new MemoryKeyStoreBackend();
    const passphrase = "correct horse battery staple";
    const salt = Buffer.alloc(16, 1);
    const store = new SecureKeyStore({
      masterKey: await SecureKeyStore.deriveMasterKey(passphrase, salt, 10_000),
      backend,
    });
    await store.setSecret("wallet-1", SECRET);
    const reader = new SecureKeyStore({
      masterKey: await SecureKeyStore.deriveMasterKey(passphrase, salt, 10_000),
      backend,
    });
    expect(await reader.getSecret("wallet-1")).toBe(SECRET);
  });
});

describe("SecureKeyStore — construction", () => {
  it("rejects invalid master keys", () => {
    expect(() => new SecureKeyStore({ masterKey: new Uint8Array(16) })).toThrow(
      KeyStorageError,
    );
    expect(
      () =>
        new SecureKeyStore({ masterKey: "not-a-key" as unknown as Uint8Array }),
    ).toThrow(KeyStorageError);
  });

  it("rejects backends missing required methods", () => {
    expect(
      () =>
        new SecureKeyStore({
          masterKey: SecureKeyStore.generateMasterKey(),
          backend: { read: async () => null } as never,
        }),
    ).toThrow(KeyStorageError);
  });

  it("works without an explicit backend (in-memory default)", async () => {
    const store = new SecureKeyStore({
      masterKey: SecureKeyStore.generateMasterKey(),
    });
    await store.setSecret("wallet-1", SECRET);
    expect(await store.getSecret("wallet-1")).toBe(SECRET);
    await store.cleanup();
  });
});


