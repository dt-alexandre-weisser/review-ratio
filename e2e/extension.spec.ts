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
  await expect(badge).toHaveAttribute('data-placement', 'header');
  await expect(badge).toHaveAttribute('title', /given \/ asked/);
  // Just left of the search box, in the header's own row, outside GitHub's search group.
  const group = github.locator(
    '[data-testid="top-nav-center"] > #review-ratio-badge + [data-component="ButtonGroup"]',
  );
  await expect(group).toHaveCount(1);
  // Side by side: the badge's right edge meets the search box, a gap apart.
  const badgeBox = (await badge.boundingBox())!;
  const searchBox = (await group.boundingBox())!;
  expect(searchBox.x - (badgeBox.x + badgeBox.width)).toBeGreaterThanOrEqual(0);
  expect(searchBox.x - (badgeBox.x + badgeBox.width)).toBeLessThanOrEqual(24);
  // ↑ and ↓ in GitHub's colours for added and removed lines, from the theme when it sets them.
  const up = badge.locator('.review-ratio-up');
  const down = badge.locator('.review-ratio-down');
  await expect(up).toHaveCSS('color', 'rgb(26, 127, 55)');
  await expect(down).toHaveCSS('color', 'rgb(209, 36, 47)');
  await github.addStyleTag({
    content: ':root { --fgColor-success: rgb(9, 105, 218); --fgColor-danger: rgb(188, 76, 0); }',
  });
  await expect(up).toHaveCSS('color', 'rgb(9, 105, 218)');
  await expect(down).toHaveCSS('color', 'rgb(188, 76, 0)');

  // The pinned manifest key gives every install the same id: it says nothing about the machine.
  expect(extensionId).toBe('bhmdipijifghpkibegnfchgcafodlgnb');

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
  const status = options.locator('#status');
  await expect(status).toContainText('token works for dev-e2e');
  await expect(status).toContainText(
    'pull requests of DiliTrust updated in the last 7 days are visible',
  );
  await expect(status).toContainText('is up');
  await expect(status).toHaveAttribute('data-kind', 'ok');
});

test('injects the content script into an open GitHub tab, as after an update', async ({
  context,
  extensionId,
}) => {
  await installFakeGitHub(context);
  const options = await context.newPage();
  await configure(options, extensionId, { token: 'github_pat_e2e' });
  const github = await context.newPage();
  await github.goto('https://github.com/');
  await expect(github.locator('#review-ratio-badge .review-ratio-full')).toHaveText(/Ratio 1\.00/);

  // The same calls the worker makes on install and update (chrome.runtime.reload() cannot be
  // exercised here: Chrome unloads a command-line extension when it reloads).
  const worker = context.serviceWorkers()[0]!;
  const injected = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://github.com/*' });
    for (const tab of tabs) {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id! }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
    }
    return tabs.length;
  });
  expect(injected).toBe(1);

  await options.bringToFront();
  await options.getByLabel('Server URL').fill('http://127.0.0.1:9');
  await options.getByRole('button', { name: 'Refresh badge now' }).click();
  await expect(options.locator('#status')).toContainText('stale since');

  await expect(github.locator('#review-ratio-badge')).toHaveAttribute('data-stale', 'true');
  await expect(github.locator('#review-ratio-badge')).toHaveCount(1);
});

test('lists the calls of the last 30 minutes on the options page', async ({
  context,
  extensionId,
}) => {
  await installFakeGitHub(context);
  const options = await context.newPage();
  // Saving refreshes the badge.
  await configure(options, extensionId, { token: 'github_pat_e2e' });

  const rows = options.locator('#activity-rows');
  await expect(rows).toContainText('refresh started (asked by the options page)');
  await expect(rows).toContainText('GET 127.0.0.1:8787/classes');
  await expect(rows).toContainText('GET api.github.com/search/issues?q=is:pr');
  await expect(rows).toContainText('POST api.github.com/graphql');
  await expect(rows).toContainText(/PullRequest DiliTrust\/top-secret-repo#\d+/);
  await expect(rows).toContainText('POST 127.0.0.1:8787/score');
  await expect(rows).toContainText(/refreshed: \d+ reviews?/);
  await expect(options.locator('#activity-summary')).toHaveText(
    /^\d+ calls in the last 30 minutes: .*api\.github\.com.*127\.0\.0\.1:8787/,
  );
  // Newest first: the refresh's last line is on top.
  await expect(rows.locator('tr').first()).toContainText(/refreshed: /);

  await options.getByRole('button', { name: 'Test connection' }).click();
  await expect(options.locator('#status')).toContainText('is up');
  await expect(rows).toContainText('Test connection, on the options page');
  await expect(rows).toContainText('GET api.github.com/user');
  await expect(options.locator('#activity')).not.toContainText('github_pat_e2e');

  await options.getByRole('button', { name: 'Forget local activity data' }).click();
  await expect(options.locator('#activity-summary')).toHaveText('No calls in the last 30 minutes.');
  await expect(rows.locator('tr')).toHaveCount(0);
});

test('finds the search bar of a redesigned header, and stays visible in a narrow window', async ({
  context,
  extensionId,
}) => {
  await installFakeGitHub(context, { header: 'redesigned' });
  const options = await context.newPage();
  await configure(options, extensionId, { token: 'github_pat_e2e' });

  const github = await context.newPage();
  await github.setViewportSize({ width: 700, height: 600 });
  await github.goto('https://github.com/DiliTrust/top-secret-repo/pulls');
  const badge = github.locator('#review-ratio-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('data-placement', 'header');
  await expect(
    github.locator('.Nav2026-row > #review-ratio-badge + .Nav2026-searchWrap'),
  ).toHaveCount(1);
  // Narrow: the short form.
  await expect(badge.locator('.review-ratio-short')).toBeVisible();
  await expect(badge.locator('.review-ratio-short')).toHaveText('Ratio 1.00');

  await options.bringToFront();
  await expect(options.locator('#diag-placement')).toContainText('in the GitHub header');
  await expect(options.locator('#diag-header-wrap')).toBeHidden();
});

test('floats the badge when the GitHub header has no place for it, and says so', async ({
  context,
  extensionId,
}) => {
  await installFakeGitHub(context, { header: 'unknown' });
  const options = await context.newPage();
  await configure(options, extensionId, { token: 'github_pat_e2e' });

  const github = await context.newPage();
  await github.setViewportSize({ width: 1400, height: 800 });
  await github.goto('https://github.com/DiliTrust/top-secret-repo/pulls');
  const badge = github.locator('#review-ratio-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('data-placement', 'floating');
  await expect(badge.locator('.review-ratio-full')).toHaveText(/Ratio 1\.00/);
  const box = (await badge.boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(1300);
  expect(box.y + box.height).toBeGreaterThan(700);

  await options.bringToFront();
  await expect(options.locator('#diag-placement')).toContainText(
    "bottom-right corner: no place found in GitHub's header",
  );
  await expect(options.locator('#diag-header-wrap')).toBeVisible();
  await options.locator('#diag-header-wrap summary').click();
  await expect(options.locator('#diag-header')).toHaveText(
    [
      'search path: no search control found',
      'header:',
      '  header.GlobalNav',
      '    div.GlobalNav-end',
      '      a',
    ].join('\n'),
  );
  await expect(options.locator('#activity-rows')).toContainText(
    "badge shown in the bottom-right corner: no place found in GitHub's header",
  );
});

test('places the badge left of the search bar of the 2023–2025 header', async ({
  context,
  extensionId,
}) => {
  await installFakeGitHub(context, { header: 'app' });
  const options = await context.newPage();
  await configure(options, extensionId, { token: 'github_pat_e2e' });
  const github = await context.newPage();
  await github.goto('https://github.com/DiliTrust/top-secret-repo/pulls');
  await expect(
    github.locator('.AppHeader-globalBar-end > #review-ratio-badge + .AppHeader-search'),
  ).toHaveCount(1);
});

test('moves a floating badge into the header once GitHub shows it', async ({
  context,
  extensionId,
}) => {
  await installFakeGitHub(context, { headerShowsAfterMs: 6_000 });
  const options = await context.newPage();
  await configure(options, extensionId, { token: 'github_pat_e2e' });
  const github = await context.newPage();
  await github.goto('https://github.com/search');
  const badge = github.locator('#review-ratio-badge');
  await expect(badge).toHaveAttribute('data-placement', 'floating');
  await expect(badge).toHaveAttribute('data-placement', 'header', { timeout: 15_000 });
  await expect(
    github.locator(
      '[data-testid="top-nav-center"] > #review-ratio-badge + [data-component="ButtonGroup"]',
    ),
  ).toHaveCount(1);
});

test('shows no badge on signed-out pages', async ({ context, extensionId }) => {
  await installFakeGitHub(context, { signedOut: true });
  const options = await context.newPage();
  await configure(options, extensionId, { token: 'github_pat_e2e' });
  const github = await context.newPage();
  await github.goto('https://github.com/login');
  await github.waitForTimeout(4_000);
  await expect(github.locator('#review-ratio-badge')).toHaveCount(0);
});

test("holds the badge's place while GitHub's React takes over its header", async ({
  context,
  extensionId,
}) => {
  await installFakeGitHub(context, { hydratesAfterMs: 1_500 });
  const options = await context.newPage();
  await configure(options, extensionId, { token: 'github_pat_e2e' });
  const github = await context.newPage();
  await github.setViewportSize({ width: 1400, height: 600 });
  await github.goto('https://github.com/DiliTrust/top-secret-repo/pulls');
  const badge = github.locator('#review-ratio-badge');
  const standIn = () =>
    github.evaluate(() => {
      const group = document.querySelector('[class*="Search-module__searchButtonGroup"]')!;
      const before = getComputedStyle(group, '::before');
      return { content: before.content, width: before.width };
    });

  // Before React's commit: no node in the header, only the CSS stand-in with the badge's text.
  await expect(github.locator('html')).toHaveAttribute('data-review-ratio-placeholder', '');
  await expect(badge).toHaveCount(0);
  expect((await standIn()).content).toBe('"↑ 400 RP · ↓ 400 RP | Ratio 1.00"');

  // After it: the badge, in the stand-in's place, and the stand-in gone.
  await expect(badge).toHaveAttribute('data-placement', 'header', { timeout: 3_000 });
  await expect(github.locator('html')).not.toHaveAttribute('data-review-ratio-placeholder');
  expect((await standIn()).content).toBe('none');
  const marked = await github.evaluate(
    () => performance.getEntriesByName('react-root:commit:global-nav-bar')[0]?.startTime ?? 0,
  );
  expect(marked).toBeGreaterThan(1_000);
});

test('shows the badge or its stand-in on every frame when a navigation brings a new header', async ({
  context,
  extensionId,
}) => {
  await installFakeGitHub(context, { hydratesAfterMs: 0 });
  const options = await context.newPage();
  await configure(options, extensionId, { token: 'github_pat_e2e' });
  const github = await context.newPage();
  await github.setViewportSize({ width: 1400, height: 600 });
  await github.goto('https://github.com/DiliTrust/top-secret-repo/pulls');
  await expect(github.locator('#review-ratio-badge')).toHaveAttribute('data-placement', 'header');

  const frames = await github.evaluate(async () => {
    const shown = () => {
      if (document.getElementById('review-ratio-badge')) return 'badge';
      const group = document.querySelector('[class*="Search-module__searchButtonGroup"]');
      return group && getComputedStyle(group, '::before').content !== 'none' ? 'stand-in' : 'none';
    };
    const seen: string[] = [];
    for (const delay of [0, 50, 150]) {
      (window as unknown as { swapHeader: (ms: number) => void }).swapHeader(delay);
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        seen.push(shown());
      }
    }
    return seen;
  });
  expect(frames).not.toContain('none');
  expect(frames).toContain('stand-in');
  expect(frames.at(-1)).toBe('badge');
});

test('keeps the badge on screen when GitHub replaces its header, without a single frame missing', async ({
  context,
  extensionId,
}) => {
  await installFakeGitHub(context);
  const options = await context.newPage();
  await configure(options, extensionId, { token: 'github_pat_e2e' });
  const github = await context.newPage();
  await github.goto('https://github.com/DiliTrust/top-secret-repo/pulls');
  await expect(github.locator('#review-ratio-badge')).toHaveAttribute('data-placement', 'header');

  // As GitHub's navigation does: a fresh header replaces the old one, three times. Every frame
  // after each swap is checked for the badge.
  const missing = await github.evaluate(async () => {
    let frames = 0;
    let without = 0;
    for (let swap = 0; swap < 3; swap++) {
      const header = document.querySelector('header')!;
      const fresh = header.cloneNode(true) as Element;
      fresh.querySelector('#review-ratio-badge')?.remove();
      header.replaceWith(fresh);
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        frames += 1;
        if (!fresh.querySelector('#review-ratio-badge')) without += 1;
      }
    }
    return { frames, without };
  });
  expect(missing).toEqual({ frames: 30, without: 0 });
});

test('shows the payload of each call', async ({ context, extensionId }) => {
  await installFakeGitHub(context);
  const options = await context.newPage();
  await configure(options, extensionId, { token: 'github_pat_e2e' });
  const rows = options.locator('#activity-rows');
  await expect(rows).toContainText('POST 127.0.0.1:8787/score');

  const view = (call: string) =>
    rows.locator('tr', { hasText: call }).first().getByRole('button', { name: 'View payload' });
  await view('POST api.github.com/graphql').click();
  const payload = options.locator('#payload');
  await expect(payload).toBeVisible();
  await expect(options.locator('#payload-title')).toHaveText('POST api.github.com/graphql');
  await expect(options.locator('#payload-text')).toContainText('query PullRequest');
  await expect(options.locator('#payload-text')).toContainText('"owner": "DiliTrust"');
  await expect(options.locator('#payload-text')).not.toContainText('github_pat_e2e');

  await view('POST 127.0.0.1:8787/score').click();
  await expect(options.locator('#payload-text')).toContainText('"contractVersion": 1');
  await expect(
    rows.locator('tr', { hasText: 'GET api.github.com/user' }).first().getByRole('button'),
  ).toHaveCount(0);

  await options.getByRole('button', { name: 'Close' }).click();
  await expect(payload).toBeHidden();
});
