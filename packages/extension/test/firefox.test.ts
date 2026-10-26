import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  FIREFOX_MIN_VERSION,
  GECKO_ID,
  UPDATES_URL,
  firefoxManifest,
  updatesManifest,
} from '../scripts/firefox.mjs';

const shared: Record<string, unknown> = JSON.parse(
  readFileSync(join(import.meta.dirname, '../manifest.json'), 'utf8'),
);

describe('firefoxManifest', () => {
  const manifest = firefoxManifest(shared);

  it('runs the background as an event page module', () => {
    expect(manifest['background']).toEqual({ scripts: ['background.js'], type: 'module' });
  });

  it('drops what only Chrome reads', () => {
    expect(manifest).not.toHaveProperty('key');
    expect(manifest).not.toHaveProperty('minimum_chrome_version');
    expect(shared).toHaveProperty('key');
  });

  it('gives the add-on its id, its update manifest and its data declaration', () => {
    expect(manifest['browser_specific_settings']).toEqual({
      gecko: {
        id: GECKO_ID,
        strict_min_version: FIREFOX_MIN_VERSION,
        update_url: UPDATES_URL,
        data_collection_permissions: { required: ['authenticationInfo'] },
      },
    });
    expect(UPDATES_URL).toMatch(/^https:\/\/github\.com\/.+\/releases\/download\/firefox\//);
  });

  it('keeps everything else as Chrome has it', () => {
    for (const key of [
      'manifest_version',
      'name',
      'description',
      'permissions',
      'host_permissions',
      'content_scripts',
      'options_ui',
      'action',
      'icons',
    ]) {
      expect(manifest[key]).toEqual(shared[key]);
    }
  });
});

describe('updatesManifest', () => {
  const xpi = Buffer.from('signed add-on');
  const link = 'https://github.com/owner/review-ratio/releases/download/v0.1.1/review-ratio.xpi';

  it('lists the one signed version with the hash of its file', () => {
    const hash = createHash('sha256').update(xpi).digest('hex');
    expect(updatesManifest({ version: '0.1.1.57', link, xpi })).toEqual({
      addons: {
        '@review-ratio': {
          updates: [{ version: '0.1.1.57', update_link: link, update_hash: `sha256:${hash}` }],
        },
      },
    });
  });

  it('refuses a link Firefox would refuse', () => {
    expect(() =>
      updatesManifest({ version: '0.1.1.57', link: 'http://example.test/a.xpi', xpi }),
    ).toThrow('not https');
  });
});
