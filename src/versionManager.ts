/**
 * SDK version management: versioning scheme, runtime compatibility checks,
 * compatibility matrix, deprecation notices, migrations, and tracking.
 */

export interface SdkVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

export interface CompatibilityEntry {
  /** Minimum SDK version that supports the feature. */
  minVersion: string;
  /** Optional maximum SDK version (exclusive) that supports the feature. */
  maxVersion?: string;
  /** Peer/runtime requirements for the feature. */
  peers?: string[];
}

export interface DeprecationNotice {
  feature: string;
  deprecatedIn: string;
  removedIn?: string;
  message: string;
  replacement?: string;
}

export interface Migration {
  from: string;
  to: string;
  description: string;
  apply: (state: Record<string, unknown>) => Record<string, unknown>;
}

export interface VersionCheckResult {
  compatible: boolean;
  current: string;
  required: string;
  reason?: string;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(version: string): SdkVersion {
  const match = SEMVER_RE.exec(version.trim());
  if (!match) {
    throw new Error(`Invalid SDK version: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

export function formatVersion(v: SdkVersion): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease ? `${base}-${v.prerelease}` : base;
}

/** Compare two versions: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (va[key] !== vb[key]) {
      return va[key] - vb[key];
    }
  }
  // A prerelease is lower than the corresponding release.
  if (va.prerelease && !vb.prerelease) return -1;
  if (!va.prerelease && vb.prerelease) return 1;
  if (va.prerelease && vb.prerelease) {
    return va.prerelease < vb.prerelease ? -1 : va.prerelease > vb.prerelease ? 1 : 0;
  }
  return 0;
}

/**
 * Compatibility matrix mapping SDK versions to supported features and peers.
 */
export const COMPATIBILITY_MATRIX: Record<string, CompatibilityEntry> = {
  '1.0.0': { minVersion: '1.0.0', peers: ['node>=16'] },
  '1.1.0': { minVersion: '1.0.0', peers: ['node>=16'] },
  '2.0.0': { minVersion: '2.0.0', peers: ['node>=18'] },
};

export const DEPRECATIONS: DeprecationNotice[] = [
  {
    feature: 'legacyClient',
    deprecatedIn: '1.1.0',
    removedIn: '2.0.0',
    message: 'legacyClient is deprecated and will be removed in 2.0.0.',
    replacement: 'createClient',
  },
];

/**
 * Check whether the current SDK version satisfies a required minimum version.
 */
export function checkVersion(current: string, required: string): VersionCheckResult {
  let cmp: number;
  try {
    cmp = compareVersions(current, required);
  } catch (err) {
    return {
      compatible: false,
      current,
      required,
      reason: (err as Error).message,
    };
  }
  if (cmp < 0) {
    return {
      compatible: false,
      current,
      required,
      reason: `SDK version ${current} is below required ${required}`,
    };
  }
  return { compatible: true, current, required };
}

/**
 * Determine whether a feature is supported by the given SDK version.
 */
export function isFeatureSupported(feature: string, version: string): boolean {
  const entry = COMPATIBILITY_MATRIX[feature];
  if (!entry) return false;
  if (compareVersions(version, entry.minVersion) < 0) return false;
  if (entry.maxVersion && compareVersions(version, entry.maxVersion) >= 0) return false;
  return true;
}

/**
 * Return deprecation notices that apply to the given SDK version.
 */
export function getDeprecationNotices(version: string): DeprecationNotice[] {
  return DEPRECATIONS.filter((d) => {
    if (compareVersions(version, d.deprecatedIn) < 0) return false;
    if (d.removedIn && compareVersions(version, d.removedIn) >= 0) return false;
    return true;
  });
}

/**
 * Apply all migrations needed to move state from one version to another.
 */
export function migrate(
  state: Record<string, unknown>,
  from: string,
  to: string,
  migrations: Migration[],
): Record<string, unknown> {
  let result = { ...state };
  const applicable = migrations
    .filter((m) => compareVersions(m.from, from) >= 0 && compareVersions(m.to, to) <= 0)
    .sort((a, b) => compareVersions(a.from, b.from));
  for (const migration of applicable) {
    result = migration.apply(result);
  }
  return result;
}

/**
 * Tracks the SDK version and records version transitions.
 */
export class VersionTracker {
  private current: string;
  private readonly history: Array<{ from: string; to: string; at: number }> = [];

  constructor(initialVersion: string) {
    parseVersion(initialVersion);
    this.current = initialVersion;
  }

  get version(): string {
    return this.current;
  }

  get transitions(): ReadonlyArray<{ from: string; to: string; at: number }> {
    return this.history;
  }

  update(nextVersion: string): void {
    parseVersion(nextVersion);
    this.history.push({ from: this.current, to: nextVersion, at: Date.now() });
    this.current = nextVersion;
  }
}
