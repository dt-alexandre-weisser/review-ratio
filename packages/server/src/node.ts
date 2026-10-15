/**
 * Node entry point. `pnpm dev:server` runs it on a fixed localhost port so the extension can
 * declare the host permission. The same app runs on Cloud Run through this file.
 *
 * Environment:
 * - `PORT` (default 8787), `HOST` (default 127.0.0.1; set 0.0.0.0 in a container).
 * - `TRUSTED_PROXY_HOPS` (default 0): number of proxies in front of the server that append to
 *   `X-Forwarded-For`. 0 keys the rate limit on the socket address. Behind Cloud Run, use 1.
 */
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';

import { createApp } from './app.ts';
import { SCORE_RATE_LIMIT } from './limits.ts';
import { forwardedClientIp } from './rate-limit.ts';

export const DEFAULT_PORT = 8787;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

const port = intFromEnv('PORT', DEFAULT_PORT);
const hostname = process.env['HOST'] ?? '127.0.0.1';
const trustedHops = intFromEnv('TRUSTED_PROXY_HOPS', 0);

const app = createApp({
  rateLimit: {
    ...SCORE_RATE_LIMIT,
    keyOf: (c) =>
      forwardedClientIp(c.req.header('x-forwarded-for'), trustedHops) ??
      getConnInfo(c).remote.address ??
      'unknown',
  },
});

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.info(`review-ratio server listening on http://${info.address}:${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
