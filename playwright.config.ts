import { defineConfig } from '@playwright/test';

// The fake GitHub answers requests made by the extension's service worker. Playwright routes
// service-worker traffic only with this flag; set here so workers inherit it.
process.env['PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS'] = '1';

/**
 * End-to-end: the built extension in Chromium, the built server on its fixed port, and a fake
 * GitHub (github.com and api.github.com are routed inside the browser). Run `pnpm build` first;
 * `pnpm test:e2e` does both.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'node packages/server/dist/node.js',
    url: 'http://127.0.0.1:8787/health',
    reuseExistingServer: !process.env['CI'],
    env: { PORT: '8787', HOST: '127.0.0.1' },
    timeout: 30_000,
  },
});
