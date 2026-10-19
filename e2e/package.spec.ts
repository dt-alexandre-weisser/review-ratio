import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test } from '@playwright/test';

const PACKAGE = resolve(import.meta.dirname, '../packages/extension/scripts/package.mjs');
const PINNED_ID = 'bhmdipijifghpkibegnfchgcafodlgnb';

let work = '';
let released: { version: string; versionName: string };

test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'review-ratio-zips-'));
  const printed = execFileSync(
    'node',
    [PACKAGE, '--build', '7', '--commit', 'abcdef0123456', '--out-dir', work],
    { encoding: 'utf8' },
  );
  released = JSON.parse(printed);
});

test.afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/**
 * What a user does with a release zip: unzip it, Load unpacked. Returns the extension's id and
 * the manifest Chrome loaded, read on the options page that opens by itself on install.
 */
async function loadUnzipped(zipName: string) {
  const folder = join(work, zipName.replace(/\.zip$/, ''));
  execFileSync('unzip', ['-q', join(work, zipName), '-d', folder]);
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${folder}`, `--load-extension=${folder}`],
  });
  try {
    // Nothing reaches GitHub: without a token the extension calls nothing, and these make sure.
    await context.route('https://github.com/**', (route) => route.abort('blockedbyclient'));
    await context.route('https://api.github.com/**', (route) => route.abort('blockedbyclient'));
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const optionsUrl = `chrome-extension://${id}/options.html`;
    await expect.poll(() => context.pages().some((page) => page.url() === optionsUrl)).toBe(true);
    const options = context.pages().find((page) => page.url() === optionsUrl)!;
    await expect(options.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    const manifest = await options.evaluate(() => chrome.runtime.getManifest());
    return {
      id,
      manifest,
      onDisk: JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')),
    };
  } finally {
    await context.close();
  }
}

test('the release zip loads unpacked with the pinned id and the stamped version', async () => {
  expect(released).toEqual({ version: '0.1.0.7', versionName: '0.1.0 build 7 (abcdef0)' });
  const { id, manifest } = await loadUnzipped('review-ratio.zip');
  expect(id).toBe(PINNED_ID);
  expect(manifest.version).toBe('0.1.0.7');
  expect(manifest.version_name).toBe('0.1.0 build 7 (abcdef0)');
});

test('the Chrome Web Store zip has no key and loads with the same version', async () => {
  const { id, manifest, onDisk } = await loadUnzipped('review-ratio-chrome-web-store.zip');
  expect(onDisk).not.toHaveProperty('key');
  expect(id).not.toBe(PINNED_ID);
  expect(manifest.version).toBe('0.1.0.7');
});
