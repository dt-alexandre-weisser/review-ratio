#!/usr/bin/env node
/**
 * Firefox: the manifest the Firefox build ships, and the update manifest (`updates.json`) that
 * signed installs read to update themselves.
 *
 *   node scripts/firefox.mjs --version 0.1.1.57 --xpi review-ratio.xpi --link <url of that xpi>
 *
 * prints the update manifest for that signed XPI. The Release workflow publishes it on the fixed
 * GitHub Release `firefox`, where `update_url` points: docs/firefox-add-ons.md.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** The add-on id on addons.mozilla.org. It never changes: Firefox ties the storage to it. */
export const GECKO_ID = '@review-ratio';

/**
 * 140 understands `data_collection_permissions`; 143 has `storage.session.getKeys()`, which the
 * activity log reads.
 */
export const FIREFOX_MIN_VERSION = '143.0';

const REPOSITORY = 'https://github.com/dt-alexandre-weisser/review-ratio';

/**
 * A fixed release that only `v*` tag runs update. `releases/latest` would not do: it is the newest
 * main build, which has no Firefox files.
 */
export const FIREFOX_RELEASE = 'firefox';
export const UPDATES_URL = `${REPOSITORY}/releases/download/${FIREFOX_RELEASE}/updates.json`;

/**
 * The shared manifest as Firefox wants it. Firefox runs the background as an event page, not a
 * service worker. The Chrome-only `key` and `minimum_chrome_version` go.
 *
 * The data the extension sends out is the GitHub token and the user's login, to GitHub, for its
 * single purpose: Mozilla counts anything handled outside the browser, so this is
 * `authenticationInfo` and not `none`.
 * @param {Record<string, unknown>} manifest
 * @returns {Record<string, unknown>}
 */
export function firefoxManifest(manifest) {
  const {
    key: _key,
    minimum_chrome_version: _minimumChromeVersion,
    background,
    ...rest
  } = manifest;
  const { service_worker: worker, type } = /** @type {{ service_worker: string, type: string }} */ (
    background
  );
  return {
    ...rest,
    background: { scripts: [worker], type },
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: FIREFOX_MIN_VERSION,
        update_url: UPDATES_URL,
        data_collection_permissions: { required: ['authenticationInfo'] },
      },
    },
  };
}

/**
 * The update manifest Firefox fetches from `update_url`: one entry, the newest signed version.
 * Firefox never downgrades, so older versions add nothing.
 * @param {{ version: string, link: string, xpi: Buffer }} update
 */
export function updatesManifest({ version, link, xpi }) {
  if (!link.startsWith('https://')) throw new Error(`update link ${link} is not https`);
  const hash = createHash('sha256').update(xpi).digest('hex');
  return {
    addons: {
      [GECKO_ID]: {
        updates: [{ version, update_link: link, update_hash: `sha256:${hash}` }],
      },
    },
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      xpi: { type: 'string' },
      link: { type: 'string' },
    },
  });
  const { version, xpi, link } = values;
  if (!version || !xpi || !link) throw new Error('usage: --version <v> --xpi <file> --link <url>');
  const updates = updatesManifest({ version, link, xpi: readFileSync(xpi) });
  process.stdout.write(`${JSON.stringify(updates, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
