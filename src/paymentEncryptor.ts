/**
 * Advanced Payment Encryption with Key Rotation
 *
 * Provides AES-256-GCM encryption for sensitive payment data (amounts,
 * payer addresses, memos) with a full key-rotation lifecycle:
 *
 * - Key derivation from a passphrase via PBKDF2
 * - Versioned key registry (add, retire, rotate)
 * - Encrypted payload envelope with key-version header
 * - Transparent re-encryption when the active key changes
 * - Event emission for lifecycle hooks (key:added, key:retired, key:rotated,
 *   payload:encrypted, payload:decrypted)
 *
 * All crypto uses Node's built-in `node:crypto` module so there is no extra
 * dependency beyond what the SDK already requires.
 *
 * Issue #961
 */

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2 as pbkdf2Cb,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { TypedEventEmitter } from "./events/TypedEventEmitter.js";

const pbkdf2 = promisify(pbkdf2Cb);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm" as const;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = "sha256";
const ENVELOPE_VERSION = 1;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single versioned encryption key in the registry. */
export interface EncryptionKeyEntry {
  /** Numeric version identifier. Must be unique and > 0. */
  version: number;
  /** The raw 32-byte AES key. */
  key: Uint8Array;
  /** Unix timestamp (ms) when this key was added. */
  createdAt: number;
  /** Whether this key has been retired (read-only; still available for decryption). */
  retired: boolean;
}

/** Encrypted envelope produced by {@link PaymentEncryptor.encrypt}. */
export interface EncryptedPaymentEnvelope {
  /**
   * Envelope format version for future extensibility.
   * Currently always `1`.
   */
  envelopeVersion: number;
  /** Key version used to encrypt this payload. */
  keyVersion: number;
  /** Base-64 encoded IV (12 bytes). */
  iv: string;
  /** Base-64 encoded GCM authentication tag (16 bytes). */
  tag: string;
  /** Base-64 encoded ciphertext. */
  ciphertext: string;
}

/** Sensitive payment data fields subject to encryption. */
export interface PaymentData {
  /** Payment amount in stroops. */
  amount: bigint;
  /** Payer public key (G… address). */
  payer: string;
  /** Optional payment memo. */
  memo?: string;
  /** Optional arbitrary metadata. */
  metadata?: Record<string, unknown>;
}

/** Options for deriving a key from a passphrase. */
export interface DeriveKeyOptions {
  /** PBKDF2 salt (must be unique per key, at least 16 bytes). */
  salt: Uint8Array;
  /** Number of PBKDF2 iterations. Defaults to 100 000. */
  iterations?: number;
}

/** Events emitted by {@link PaymentEncryptor}. */
export interface PaymentEncryptorEvents {
  /** Fired when a new key is registered. */
  "key:added": { version: number };
  /** Fired when a key is retired. */
  "key:retired": { version: number };
  /** Fired when the active key is changed. */
  "key:rotated": { fromVersion: number | null; toVersion: number };
  /** Fired after a payload is successfully encrypted. */
  "payload:encrypted": { keyVersion: number };
  /** Fired after a payload is successfully decrypted. */
  "payload:decrypted": { keyVersion: number };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EncryptionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "EncryptionError";
  }
}

export class DecryptionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DecryptionError";
  }
}

export class KeyRotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyRotationError";
  }
}

// ---------------------------------------------------------------------------
// PaymentEncryptor
// ---------------------------------------------------------------------------

/**
 * Stateful encryptor for payment data, with versioned key management and
 * automatic re-encryption support.
 *
 * @example
 * ```ts
 * const encryptor = new PaymentEncryptor();
 * const key = await PaymentEncryptor.deriveKey("my-passphrase", { salt });
 * encryptor.addKey(1, key);
 * encryptor.setActiveKey(1);
 *
 * const envelope = await encryptor.encrypt({ amount: 100n, payer: "GABC..." });
 * const data = await encryptor.decrypt(envelope);
 * ```
 */
export class PaymentEncryptor extends TypedEventEmitter<PaymentEncryptorEvents> {
  private _keys: Map<number, EncryptionKeyEntry> = new Map();
  private _activeVersion: number | null = null;

  // -------------------------------------------------------------------------
  // Key management
  // -------------------------------------------------------------------------

  /**
   * Register a new encryption key.
   *
   * @param version - Unique key version number (positive integer).
   * @param key     - Raw 32-byte AES key.
   * @throws {KeyRotationError} if the version is already registered.
   */
  addKey(version: number, key: Uint8Array): this {
    if (version <= 0 || !Number.isInteger(version)) {
      throw new KeyRotationError("Key version must be a positive integer");
    }
    if (this._keys.has(version)) {
      throw new KeyRotationError(
        `Key version ${version} is already registered`,
      );
    }
    if (key.length !== KEY_BYTES) {
      throw new KeyRotationError(
        `Key must be exactly ${KEY_BYTES} bytes (AES-256)`,
      );
    }
    this._keys.set(version, {
      version,
      key: Uint8Array.from(key),
      createdAt: Date.now(),
      retired: false,
    });
    this.emit("key:added", { version });
    return this;
  }

  /**
   * Set the active key used for all new encryptions.
   *
   * @param version - The key version to activate.
   * @throws {KeyRotationError} if the version is not registered or is retired.
   */
  setActiveKey(version: number): this {
    const entry = this._keys.get(version);
    if (!entry) {
      throw new KeyRotationError(`Key version ${version} is not registered`);
    }
    if (entry.retired) {
      throw new KeyRotationError(
        `Key version ${version} has been retired and cannot be set as active`,
      );
    }
    const previous = this._activeVersion;
    this._activeVersion = version;
    this.emit("key:rotated", { fromVersion: previous, toVersion: version });
    return this;
  }

  /**
   * Retire a key. Retired keys remain available for decryption but cannot be
   * set as the active key.
   *
   * @param version - Key version to retire.
   * @throws {KeyRotationError} if the version is not registered.
   */
  retireKey(version: number): this {
    const entry = this._keys.get(version);
    if (!entry) {
      throw new KeyRotationError(`Key version ${version} is not registered`);
    }
    this._keys.set(version, { ...entry, retired: true });
    if (this._activeVersion === version) {
      this._activeVersion = null;
    }
    this.emit("key:retired", { version });
    return this;
  }

  /**
   * Retrieve metadata for a registered key (without exposing the raw bytes).
   */
  getKeyInfo(
    version: number,
  ): Omit<EncryptionKeyEntry, "key"> | undefined {
    const entry = this._keys.get(version);
    if (!entry) return undefined;
    const { key: _key, ...rest } = entry;
    return rest;
  }

  /**
   * Return version numbers of all registered keys.
   */
  listKeyVersions(): number[] {
    return [...this._keys.keys()];
  }

  /**
   * The currently active key version, or `null` if none is set.
   */
  get activeVersion(): number | null {
    return this._activeVersion;
  }

  // -------------------------------------------------------------------------
  // Encryption / Decryption
  // -------------------------------------------------------------------------

  /**
   * Encrypt `data` using the active key, returning a self-describing envelope.
   *
   * @param data - {@link PaymentData} to encrypt.
   * @throws {EncryptionError} if no active key is set or encryption fails.
   */
  async encrypt(data: PaymentData): Promise<EncryptedPaymentEnvelope> {
    if (this._activeVersion === null) {
      throw new EncryptionError("No active encryption key set");
    }

    const entry = this._keys.get(this._activeVersion);
    if (!entry || entry.retired) {
      throw new EncryptionError(
        `Active key version ${this._activeVersion} is not available`,
      );
    }

    try {
      const iv = randomBytes(GCM_IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, Buffer.from(entry.key), iv);

      // Serialise PaymentData — bigint needs custom handling
      const plaintext = Buffer.from(
        JSON.stringify(data, (_k, v) =>
          typeof v === "bigint" ? { __bigint: v.toString() } : v,
        ),
        "utf8",
      );

      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();

      const envelope: EncryptedPaymentEnvelope = {
        envelopeVersion: ENVELOPE_VERSION,
        keyVersion: this._activeVersion,
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };

      this.emit("payload:encrypted", { keyVersion: this._activeVersion });
      return envelope;
    } catch (err) {
      throw new EncryptionError("Failed to encrypt payment data", err);
    }
  }

  /**
   * Decrypt an envelope, automatically selecting the correct key by version.
   *
   * @param envelope - {@link EncryptedPaymentEnvelope} to decrypt.
   * @returns The original {@link PaymentData}.
   * @throws {DecryptionError} if the key is unavailable or authentication fails.
   */
  async decrypt(envelope: EncryptedPaymentEnvelope): Promise<PaymentData> {
    const entry = this._keys.get(envelope.keyVersion);
    if (!entry) {
      throw new DecryptionError(
        `No key registered for version ${envelope.keyVersion}`,
      );
    }

    try {
      const iv = Buffer.from(envelope.iv, "base64");
      const tag = Buffer.from(envelope.tag, "base64");
      const ciphertext = Buffer.from(envelope.ciphertext, "base64");

      const decipher = createDecipheriv(
        ALGORITHM,
        Buffer.from(entry.key),
        iv,
      );
      decipher.setAuthTag(tag);

      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      const data = JSON.parse(plaintext.toString("utf8"), (_k, v) => {
        if (v && typeof v === "object" && "__bigint" in v) {
          return BigInt(v.__bigint as string);
        }
        return v;
      }) as PaymentData;

      this.emit("payload:decrypted", { keyVersion: envelope.keyVersion });
      return data;
    } catch (err) {
      throw new DecryptionError("Failed to decrypt payment data", err);
    }
  }

  /**
   * Re-encrypt an envelope with the current active key.
   * If the envelope is already encrypted under the active key, returns it
   * unchanged.
   *
   * @param envelope - The envelope to potentially re-encrypt.
   * @throws {EncryptionError} if no active key is set.
   * @throws {DecryptionError} if the original decryption fails.
   */
  async reEncrypt(
    envelope: EncryptedPaymentEnvelope,
  ): Promise<EncryptedPaymentEnvelope> {
    if (this._activeVersion === null) {
      throw new EncryptionError(
        "No active key — cannot re-encrypt without a target key",
      );
    }
    if (envelope.keyVersion === this._activeVersion) {
      return envelope; // Nothing to do
    }
    const data = await this.decrypt(envelope);
    return this.encrypt(data);
  }

  // -------------------------------------------------------------------------
  // Static helpers
  // -------------------------------------------------------------------------

  /**
   * Derive a 32-byte AES key from `passphrase` using PBKDF2-SHA256.
   *
   * @param passphrase - Secret passphrase string.
   * @param options    - Derivation options (salt, iterations).
   */
  static async deriveKey(
    passphrase: string,
    options: DeriveKeyOptions,
  ): Promise<Uint8Array> {
    const iterations = options.iterations ?? PBKDF2_ITERATIONS;
    const derived = await pbkdf2(
      passphrase,
      Buffer.from(options.salt),
      iterations,
      KEY_BYTES,
      PBKDF2_DIGEST,
    );
    return new Uint8Array(derived);
  }

  /**
   * Produce a cryptographically random 32-byte key.
   * Useful when you don't need passphrase-based derivation.
   */
  static generateKey(): Uint8Array {
    return new Uint8Array(randomBytes(KEY_BYTES));
  }

  /**
   * Produce a cryptographically random salt (16 bytes by default).
   *
   * @param length - Salt length in bytes. Defaults to 16.
   */
  static generateSalt(length = 16): Uint8Array {
    return new Uint8Array(randomBytes(length));
  }

  /**
   * Constant-time comparison of two keys to avoid timing attacks.
   *
   * @param a - First key.
   * @param b - Second key.
   */
  static keysEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
}
