/**
 * Node entry point. `pnpm dev:server` runs it on a fixed localhost port so the extension can
 * declare the host permission. The same app runs on Cloud Run through this file.
 *
 * Environment (see config.ts):
 * - `PORT` (default 8787), `HOST` (default 127.0.0.1; 0.0.0.0 in a container).
 * - `TRUSTED_PROXY_HOPS`: required unless HOST is a loopback address. 0 keys the rate limit on
 *   the socket address; N keys it on the N-th `X-Forwarded-For` entry from the end.
 */
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';

import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { SCORE_RATE_LIMIT } from './limits.ts';
import { forwardedClientIp } from './rate-limit.ts';

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const { port, host, trustedProxyHops } = config;

const app = createApp({
  rateLimit: {
    ...SCORE_RATE_LIMIT,
    keyOf: (c) =>
      forwardedClientIp(c.req.header('x-forwarded-for'), trustedProxyHops) ??
      getConnInfo(c).remote.address ??
      'unknown',
  },
});

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.info(
    `review-ratio server listening on http://${info.address}:${info.port} (trusted proxy hops: ${trustedProxyHops})`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
