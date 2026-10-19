/**
 * Generates the Chrome Web Store images into `store/` from the built extension, against the fake
 * GitHub of the end-to-end tests:
 *
 *   pnpm store:images
 *
 * Nothing reaches the real GitHub, or any other host: the fake answers github.com and
 * api.github.com, a route of lower priority aborts every other request, Chromium resolves no host
 * name at all, and the run fails unless every request went to the fake.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BrowserContext } from '@playwright/test';

import { ME, installFakeGitHub, installFakeGitHubLogin } from './fake-github.ts';
// The icon shader of the build, to draw the store icon with its transparent margin.
import { iconShader, png } from '../packages/extension/scripts/icons.mjs';

// Playwright routes the service worker's requests only with this flag, read when it launches.
process.env['PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS'] = '1';
const { chromium } = await import('@playwright/test');

const EXTENSION = resolve(import.meta.dirname, '../packages/extension/dist');
const OUT = resolve(import.meta.dirname, '../store');
const FAKE_HOSTS = new Set(['github.com', 'api.github.com']);

/** Every http(s) request of the run, and those no fake route answered. */
const requests: string[] = [];
const unanswered: string[] = [];

async function launch(): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    // Twice the pixels for the header crop; the store images are taken at CSS size.
    deviceScaleFactor: 2,
    colorScheme: 'light',
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      // A request that slipped past every route would still find no host.
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
  context.on('request', (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  // Routes added last run first: this one only sees what the fake GitHub does not answer.
  await context.route(
    (url) => url.protocol === 'http:' || url.protocol === 'https:',
    (route) => {
      unanswered.push(route.request().url());
      return route.abort('blockedbyclient');
    },
  );
  await installFakeGitHub(context);
  await installFakeGitHubLogin(context);
  return context;
}

async function extensionId(context: BrowserContext): Promise<string> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return new URL(worker.url()).host;
}

/** A light frame with a caption around a picture: the layout of every screenshot. */
function framed(caption: string, detail: string, picture: Buffer, width: number): string {
  return `<!doctype html><html><head><style>
    body { margin: 0; width: 1280px; height: 800px; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 40px; background: #f6f8fa;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
      color: #1f2328; }
    h1 { margin: 0; font-size: 44px; font-weight: 600; }
    p { margin: 12px 0 0; font-size: 24px; color: #59636e; text-align: center; }
    img { width: ${width}px; border: 1px solid #d0d7de; border-radius: 12px;
      box-shadow: 0 8px 24px rgba(31, 35, 40, 0.12); }
  </style></head><body>
    <div><h1>${caption}</h1><p>${detail}</p></div>
    <img src="data:image/png;base64,${picture.toString('base64')}">
  </body></html>`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const context = await launch();
  try {
    const id = await extensionId(context);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.getByRole('button', { name: 'Sign in with GitHub' }).click();
    await options.locator('#signed-in-login').filter({ hasText: ME }).waitFor({ timeout: 15_000 });
    await options.getByRole('button', { name: 'Save' }).click();
    await options.locator('#status').filter({ hasText: 'Saved' }).waitFor();
    await options
      .locator('#status')
      .filter({ hasNotText: 'Refreshing the badge' })
      .waitFor({ timeout: 15_000 });

    // The header at 1,440 px: wide enough for the full badge.
    const github = await context.newPage();
    await github.setViewportSize({ width: 1440, height: 400 });
    await github.goto('https://github.com/DiliTrust/top-secret-repo/pulls');
    const badge = github.locator('#review-ratio-badge');
    await badge.locator('.review-ratio-full').filter({ hasText: 'Ratio 1.00' }).waitFor();
    // The fake header is bare markup: a few rules make it read as a header, not as test fixtures.
    await github.addStyleTag({
      content: `body { margin: 0; font: 14px -apple-system, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif; }
        header { background: #f6f8fa; border-bottom: 1px solid #d0d7de; }
        header a { font: inherit; font-weight: 600; color: #1f2328; text-decoration: none; }
        header button { font: inherit; color: #59636e; background: #ffffff; border: 1px solid #d0d7de;
          border-radius: 6px; padding: 5px 12px; }
        [data-testid="top-nav-left"] { display: none !important; }
        [data-component="ButtonGroup"] button { min-width: 260px; text-align: left; }
        [data-component="ButtonGroup"] div + div button { min-width: 0; }
        main { display: none; }`,
    });
    const box = (await badge.boundingBox())!;
    const header = await github.screenshot({
      clip: { x: Math.max(0, box.x - 260), y: 0, width: 760, height: box.y + box.height + 14 },
      scale: 'device',
    });
    const badgeOnly = await badge.screenshot();

    const frame = await context.newPage();
    await frame.setViewportSize({ width: 1280, height: 800 });
    await frame.setContent(
      framed(
        'Your review ratio, in the GitHub header',
        'Review Points you gave ↑ and asked for ↓ in the last 7 days. Private: only you see it.',
        header,
        1100,
      ),
    );
    await frame.waitForLoadState('load');
    writeFileSync(resolve(OUT, 'screenshot-badge.png'), await frame.screenshot({ scale: 'css' }));

    await options.bringToFront();
    await options.setViewportSize({ width: 1280, height: 800 });
    await options.evaluate(() => {
      window.scrollTo(0, 0);
    });
    writeFileSync(
      resolve(OUT, 'screenshot-options.png'),
      await options.screenshot({ scale: 'css' }),
    );

    const icon = png(128, iconShader(96, 16));
    writeFileSync(resolve(OUT, 'icon-128.png'), icon);

    await frame.setViewportSize({ width: 440, height: 280 });
    await frame.setContent(`<!doctype html><html><head><style>
      body { margin: 0; width: 440px; height: 280px; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 14px; background: #f6f8fa;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
        color: #1f2328; }
      .name { display: flex; align-items: center; gap: 12px; font-size: 34px; font-weight: 600; }
      .name img { width: 64px; height: 64px; }
      p { margin: 0; font-size: 17px; color: #59636e; }
      .badge { padding: 8px 12px; background: #ffffff; border: 1px solid #d0d7de; border-radius: 8px; }
    </style></head><body>
      <div class="name"><img src="data:image/png;base64,${icon.toString('base64')}">review-ratio</div>
      <p>Review as much as you ask to be reviewed.</p>
      <div class="badge"><img style="width:${box.width}px" src="data:image/png;base64,${badgeOnly.toString('base64')}"></div>
    </body></html>`);
    await frame.waitForLoadState('load');
    writeFileSync(
      resolve(OUT, 'promo-small-440x280.png'),
      await frame.screenshot({ scale: 'css' }),
    );
  } finally {
    await context.close();
  }

  const hosts = new Set(requests.map((url) => new URL(url).host));
  if (unanswered.length > 0 || [...hosts].some((host) => !FAKE_HOSTS.has(host))) {
    throw new Error(`requests outside the fake GitHub: ${unanswered.join(', ')}`);
  }
  if (!requests.some((url) => url.startsWith('https://api.github.com/'))) {
    throw new Error('the badge was scored without a call to the fake api.github.com');
  }
  console.info(`${requests.length} requests, all answered by the fake GitHub; images in ${OUT}`);
}

await main();
