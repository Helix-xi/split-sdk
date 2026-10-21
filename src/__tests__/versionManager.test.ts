import {
  checkVersion,
  compareVersions,
  getDeprecationNotices,
  isFeatureSupported,
  migrate,
  parseVersion,
  VersionTracker,
} from '../versionManager';

describe('versionManager', () => {
  it('parses semver versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: undefined });
    expect(parseVersion('2.0.0-beta.1').prerelease).toBe('beta.1');
    expect(() => parseVersion('nope')).toThrow();
  });

  it('compares versions', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
  });

  it('checks required versions', () => {
    expect(checkVersion('1.2.0', '1.0.0').compatible).toBe(true);
    expect(checkVersion('0.9.0', '1.0.0').compatible).toBe(false);
  });

  it('reports feature support from the matrix', () => {
    expect(isFeatureSupported('1.0.0', '1.0.0')).toBe(true);
    expect(isFeatureSupported('2.0.0', '1.0.0')).toBe(false);
    expect(isFeatureSupported('unknown', '1.0.0')).toBe(false);
  });

  it('returns deprecation notices', () => {
    expect(getDeprecationNotices('1.1.0').length).toBe(1);
    expect(getDeprecationNotices('2.0.0').length).toBe(0);
  });

  it('applies migrations in order', () => {
    const result = migrate({ a: 1 }, '1.0.0', '2.0.0', [
      { from: '1.0.0', to: '1.1.0', description: 'add b', apply: (s) => ({ ...s, b: 2 }) },
      { from: '1.1.0', to: '2.0.0', description: 'add c', apply: (s) => ({ ...s, c: 3 }) },
    ]);
    expect(result).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('tracks version transitions', () => {
    const tracker = new VersionTracker('1.0.0');
    tracker.update('1.1.0');
    expect(tracker.version).toBe('1.1.0');
    expect(tracker.transitions.length).toBe(1);
  });
});
