#!/usr/bin/env node
/**
 * Packages the built extension (`dist/` and `dist-firefox/`, run `pnpm build` first) into three
 * zips, manifest.json at their root:
 *
 *   review-ratio.zip                     unzip, then Load unpacked; keeps the pinned extension id
 *   review-ratio-chrome-web-store.zip    for the Chrome Web Store, without the manifest `key`
 *   review-ratio-firefox.zip             unsigned, for addons.mozilla.org to sign
 *
 *   node scripts/package.mjs --build 42 --commit "$GITHUB_SHA" [--tag v0.1.0] [--out-dir release]
 *
 * The version is `<package.json version>.<build>`: CI passes its run number, so every build has a
 * higher version than the one before, as the Chrome Web Store requires. It is stamped into the
 * zipped manifests only; `dist/` and the repository keep theirs. Prints the version as JSON.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { deflateRawSync } from 'node:zlib';

import { crc32 } from './icons.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ZIP_NAME = 'review-ratio.zip';
export const STORE_ZIP_NAME = 'review-ratio-chrome-web-store.zip';
export const FIREFOX_ZIP_NAME = 'review-ratio-firefox.zip';

/**
 * Chrome's rule for `version`: one to four dot-separated integers from 0 to 65535, without leading
 * zeros.
 * @param {string} version
 */
export function isChromeVersion(version) {
  const parts = version.split('.');
  return (
    parts.length >= 1 &&
    parts.length <= 4 &&
    parts.every((p) => /^(0|[1-9]\d{0,4})$/.test(p) && Number(p) <= 65535)
  );
}

/**
 * @param {{ base: string, build: number, commit?: string | undefined, tag?: string | undefined }} input
 * @returns {{ version: string, versionName: string }}
 */
export function releaseVersion({ base, build, commit, tag }) {
  if (!/^\d+\.\d+\.\d+$/.test(base)) {
    throw new Error(`package.json version ${base} is not major.minor.patch`);
  }
  if (tag !== undefined && tag !== `v${base}`) {
    throw new Error(`tag ${tag} does not match package.json version ${base}: expected v${base}`);
  }
  const version = `${base}.${build}`;
  if (!Number.isInteger(build) || !isChromeVersion(version)) {
    throw new Error(`${version} is not a valid Chrome extension version`);
  }
  if (tag !== undefined) return { version, versionName: base };
  const at = commit ? ` (${commit.slice(0, 7)})` : '';
  return { version, versionName: `${base} build ${build}${at}` };
}

/**
 * The manifest as zipped: the release version, and no `key` for the Store, which gives the item
 * its own id. Firefox has no `version_name`: it gets none.
 * @param {Record<string, unknown>} manifest
 * @param {{ version: string, versionName: string | null, store: boolean }} stamp
 */
export function stampManifest(manifest, { version, versionName, store }) {
  /** @type {Record<string, unknown>} */
  const stamped = { ...manifest, version };
  if (versionName !== null) stamped['version_name'] = versionName;
  if (store) delete stamped['key'];
  return stamped;
}

// 1980-01-01 00:00, the earliest DOS date: the same files always give the same zip.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/**
 * A zip archive, deflated, without any dependency. Entries keep the given order.
 * @param {{ name: string, data: Buffer }[]} entries
 */
export function zip(entries) {
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: deflate
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so unzip applies the mode below
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + deflated.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** @param {string} dir @returns {string[]} */
function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/**
 * Zips `dist` with the stamped manifest.
 * @param {{ dist: string, version: string, versionName: string | null, store: boolean }} options
 */
export function packageExtension({ dist, version, versionName, store }) {
  const files = listFiles(dist);
  if (!files.includes('manifest.json'))
    throw new Error(`${dist} has no manifest.json: build first`);
  return zip(
    files.map((name) => {
      if (name !== 'manifest.json') return { name, data: readFileSync(join(dist, name)) };
      /** @type {Record<string, unknown>} */
      const manifest = JSON.parse(readFileSync(join(dist, name), 'utf8'));
      const stamped = stampManifest(manifest, { version, versionName, store });
      return { name, data: Buffer.from(`${JSON.stringify(stamped, null, 2)}\n`) };
    }),
  );
}

function main() {
  const { values } = parseArgs({
    options: {
      build: { type: 'string', default: '0' },
      commit: { type: 'string' },
      tag: { type: 'string' },
      'out-dir': { type: 'string', default: join(root, 'release') },
    },
  });
  /** @type {{ version: string }} */
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const { version, versionName } = releaseVersion({
    base: pkg.version,
    build: Number(values.build),
    commit: values.commit,
    tag: values.tag,
  });
  const outDir = resolve(values['out-dir']);
  mkdirSync(outDir, { recursive: true });
  for (const [name, dist, store, named] of /** @type {const} */ ([
    [ZIP_NAME, join(root, 'dist'), false, true],
    [STORE_ZIP_NAME, join(root, 'dist'), true, true],
    [FIREFOX_ZIP_NAME, join(root, 'dist-firefox'), true, false],
  ])) {
    const zipped = packageExtension({
      dist,
      version,
      versionName: named ? versionName : null,
      store,
    });
    writeFileSync(join(outDir, name), zipped);
    console.error(`packaged ${join(outDir, name)}`);
  }
  process.stdout.write(`${JSON.stringify({ version, versionName })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
