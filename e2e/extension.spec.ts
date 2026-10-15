import { resolve } from 'node:path';

import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';

import { installFakeGitHub } from './fake-github.ts';

const EXTENSION = resolve(import.meta.dirname, '../packages/extension/dist');

const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(new URL(worker.url()).host);
  },
});

async function configure(
  page: Page,
  extensionId: string,
  settings: { token: string; serverUrl?: string },
) {
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.getByLabel('Token').fill(settings.token);
  if (settings.serverUrl) await page.getByLabel('Server URL').fill(settings.serverUrl);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#status')).toContainText('Saved');
}

test('shows the ratio in the GitHub header and sends numbers only', async ({
  context,
  extensionId,
}) => {
  await installFakeGitHub(context);
  const payloads: string[] = [];
  await context.route('http://127.0.0.1:8787/score', async (route) => {
    payloads.push(route.request().postData() ?? '');
    await route.continue();
  });

  const options = await context.newPage();
  await configure(options, extensionId, { token: 'github_pat_e2e' });

  const github = await context.newPage();
  await github.goto('https://github.com/DiliTrust/top-secret-repo/pulls');
  const badge = github.locator('#review-ratio-badge');
  await expect(badge).toBeVisible();
  await expect(badge.locator('.review-ratio-full')).toHaveText('↑ 400 RP · ↓ 400 RP | Ratio 1.00');
  await expect(badge).toHaveAttribute('data-tone', 'good');
  await expect(badge).toHaveAttribute('data-stale', 'false');
  await expect(badge).toHaveAttribute('title', /given \/ asked/);

  expect(payloads.length).toBeGreaterThan(0);
  const sent = payloads.at(-1)!;
  for (const secret of [
    'DiliTrust',
    'top-secret-repo',
    'alice',
    'dev-e2e',
    'payments',
    '.ts',
    'PRR_e2e_1',
    '"11"',
    '#22',
  ]) {
    expect(sent, `payload leaks ${secret}`).not.toContain(secret);
  }
  expect(JSON.parse(sent)).toMatchObject({
    contractVersion: 1,
    up: [{ action: 'approve' }],
    down: [{}],
  });

  // Clicking the badge does nothing.
  await badge.click();
  await expect(github).toHaveURL('https://github.com/DiliTrust/top-secret-repo/pulls');
});

test('keeps the badge visible but greyed when the server is unreachable', async ({
  context,
  extensionId,
}) => {
  await installFakeGitHub(context);
  const options = await context.newPage();
  await configure(options, extensionId, { token: 'github_pat_e2e' });

  const github = await context.newPage();
  await github.goto('https://github.com/');
  await expect(github.locator('#review-ratio-badge .review-ratio-full')).toHaveText(/Ratio 1\.00/);

  await options.bringToFront();
  await options.getByLabel('Server URL').fill('http://127.0.0.1:9');
  await options.getByRole('button', { name: 'Refresh badge now' }).click();
  await expect(options.locator('#status')).toContainText('stale since');

  const badge = github.locator('#review-ratio-badge');
  await expect(badge).toHaveAttribute('data-stale', 'true');
  await expect(badge.locator('.review-ratio-full')).toHaveText(/Ratio 1\.00/);
  await expect(badge).toHaveAttribute('title', /^stale since \d\d:\d\d$/);
});

test('asks for set up without a token and flags a rejected token', async ({
  context,
  extensionId,
}) => {
  await installFakeGitHub(context, { rejectToken: true });
  const github = await context.newPage();
  await github.goto('https://github.com/');
  await expect(github.locator('#review-ratio-badge .review-ratio-full')).toHaveText(
    'review-ratio: set up',
  );

  const options = await context.newPage();
  await configure(options, extensionId, { token: 'github_pat_revoked' });
  await options.getByRole('button', { name: 'Refresh badge now' }).click();
  await expect(options.locator('#status')).toContainText('token rejected');
  await expect(github.locator('#review-ratio-badge .review-ratio-full')).toHaveText(
    'review-ratio: token rejected',
  );
});

test('reports both connections from the options page', async ({ context, extensionId }) => {
  await installFakeGitHub(context);
  const options = await context.newPage();
  await configure(options, extensionId, { token: 'github_pat_e2e' });
  await options.getByRole('button', { name: 'Test connection' }).click();
  await expect(options.locator('#status')).toContainText('token works for dev-e2e');
  await expect(options.locator('#status')).toContainText('is up');
});
