import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isChromeVersion,
  packageExtension,
  releaseVersion,
  stampManifest,
  zip,
} from '../scripts/package.mjs';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-ratio-package-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Unzips with the system's unzip, as a user's archive tool would. */
function unzip(archive: Buffer): string {
  const dir = tempDir();
  writeFileSync(join(dir, 'archive.zip'), archive);
  execFileSync('unzip', ['-q', join(dir, 'archive.zip'), '-d', join(dir, 'out')]);
  return join(dir, 'out');
}

describe('isChromeVersion', () => {
  it.each(['1', '0.1.0', '0.1.0.57', '65535.0.0.65535'])('accepts %s', (version) => {
    expect(isChromeVersion(version)).toBe(true);
  });

  it.each(['', '1.2.3.4.5', '0.1.0.65536', '0.01.0', '1.-1', '1.2a', '1..2'])(
    'rejects %j',
    (version) => {
      expect(isChromeVersion(version)).toBe(false);
    },
  );
});

describe('releaseVersion', () => {
  it('appends the build number and names the build after its commit', () => {
    expect(releaseVersion({ base: '0.1.0', build: 57, commit: 'd95aca0abcdef' })).toEqual({
      version: '0.1.0.57',
      versionName: '0.1.0 build 57 (d95aca0)',
    });
  });

  it('names a tag build after the tag', () => {
    expect(releaseVersion({ base: '0.2.0', build: 58, tag: 'v0.2.0' })).toEqual({
      version: '0.2.0.58',
      versionName: '0.2.0',
    });
  });

  it('refuses a tag that is not the package version', () => {
    expect(() => releaseVersion({ base: '0.1.0', build: 3, tag: 'v0.2.0' })).toThrow(
      'expected v0.1.0',
    );
  });

  it('refuses a version Chrome would refuse', () => {
    expect(() => releaseVersion({ base: '0.1.0-beta', build: 3 })).toThrow('major.minor.patch');
    expect(() => releaseVersion({ base: '0.1.0', build: 70_000 })).toThrow('not a valid Chrome');
    expect(() => releaseVersion({ base: '0.1.0', build: Number.NaN })).toThrow(
      'not a valid Chrome',
    );
  });

  it('orders builds by run number across a version bump', () => {
    const versions = [
      releaseVersion({ base: '0.1.0', build: 9 }).version,
      releaseVersion({ base: '0.1.0', build: 10 }).version,
      releaseVersion({ base: '0.2.0', build: 11, tag: 'v0.2.0' }).version,
    ];
    const compare = (a: string, b: string) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 4; i += 1) {
        if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
      }
      return 0;
    };
    expect([...versions].sort(compare)).toEqual(versions);
  });
});

describe('stampManifest', () => {
  const manifest = { name: 'review-ratio', version: '0.1.0', key: 'MIIB' };

  it('keeps the key for the unpacked zip, so every install has the same id', () => {
    expect(
      stampManifest(manifest, { version: '0.1.0.5', versionName: 'five', store: false }),
    ).toEqual({ name: 'review-ratio', version: '0.1.0.5', version_name: 'five', key: 'MIIB' });
  });

  it('drops the key for the Store', () => {
    expect(
      stampManifest(manifest, { version: '0.1.0.5', versionName: 'five', store: true }),
    ).toEqual({ name: 'review-ratio', version: '0.1.0.5', version_name: 'five' });
    expect(manifest.key).toBe('MIIB');
  });

  it('leaves version_name out for Firefox, which has none', () => {
    expect(stampManifest(manifest, { version: '0.1.0.5', versionName: null, store: true })).toEqual(
      { name: 'review-ratio', version: '0.1.0.5' },
    );
  });
});

describe('zip', () => {
  it('writes an archive that unzip extracts byte for byte', () => {
    const big = Buffer.from('review-ratio '.repeat(5_000));
    const out = unzip(
      zip([
        { name: 'manifest.json', data: Buffer.from('{}\n') },
        { name: 'icons/icon-16.png', data: Buffer.from([0, 1, 2, 255]) },
        { name: 'big.txt', data: big },
        { name: 'empty.txt', data: Buffer.alloc(0) },
      ]),
    );
    expect(readFileSync(join(out, 'manifest.json'), 'utf8')).toBe('{}\n');
    expect([...readFileSync(join(out, 'icons/icon-16.png'))]).toEqual([0, 1, 2, 255]);
    expect(readFileSync(join(out, 'big.txt')).equals(big)).toBe(true);
    expect(readFileSync(join(out, 'empty.txt')).length).toBe(0);
  });

  it('is the same for the same files', () => {
    const entries = [{ name: 'a.txt', data: Buffer.from('a') }];
    expect(zip(entries).equals(zip(entries))).toBe(true);
  });
});

describe('packageExtension', () => {
  function dist(): string {
    const dir = tempDir();
    mkdirSync(join(dir, 'icons'));
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, version: '0.1.0', key: 'MIIB' }),
    );
    writeFileSync(join(dir, 'background.js'), 'export {};\n');
    writeFileSync(join(dir, 'icons', 'icon-128.png'), 'png');
    return dir;
  }

  it('zips dist with the stamped manifest at the root', () => {
    const out = unzip(
      packageExtension({ dist: dist(), version: '0.1.0.7', versionName: 'seven', store: true }),
    );
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))).toEqual({
      manifest_version: 3,
      version: '0.1.0.7',
      version_name: 'seven',
    });
    expect(readFileSync(join(out, 'background.js'), 'utf8')).toBe('export {};\n');
    expect(readFileSync(join(out, 'icons', 'icon-128.png'), 'utf8')).toBe('png');
  });

  it('refuses a folder without a manifest', () => {
    expect(() =>
      packageExtension({ dist: tempDir(), version: '0.1.0.7', versionName: 'x', store: false }),
    ).toThrow('build first');
  });
});
