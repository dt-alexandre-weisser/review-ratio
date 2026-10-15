/**
 * Cloudflare Workers entry point. Same app, no Node APIs.
 *
 * Rate limiting keys on `cf-connecting-ip`, which Cloudflare sets and clients cannot forge. The
 * buckets live in one isolate's memory, so the limit is per isolate: a soft brake, not a quota.
 */
import { createApp } from './app.ts';
import { SCORE_RATE_LIMIT } from './limits.ts';

export default createApp({
  rateLimit: {
    ...SCORE_RATE_LIMIT,
    keyOf: (c) => c.req.header('cf-connecting-ip') ?? 'unknown',
  },
});
