import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { forwardedClientIp, rateLimit } from '../src/rate-limit.ts';

describe('forwardedClientIp', () => {
  it('takes the entry written by the outermost trusted proxy', () => {
    expect(forwardedClientIp('6.6.6.6, 203.0.113.7', 1)).toBe('203.0.113.7');
    expect(forwardedClientIp('6.6.6.6, 203.0.113.7, 10.0.0.1', 2)).toBe('203.0.113.7');
  });

  it('ignores the header when no proxy is trusted or it is too short', () => {
    expect(forwardedClientIp('203.0.113.7', 0)).toBeUndefined();
    expect(forwardedClientIp('203.0.113.7', 2)).toBeUndefined();
    expect(forwardedClientIp(undefined, 1)).toBeUndefined();
    expect(forwardedClientIp(' , ', 1)).toBeUndefined();
    expect(forwardedClientIp('x'.repeat(65), 1)).toBeUndefined();
  });
});

describe('rateLimit', () => {
  it('bounds the number of tracked clients', async () => {
    let n = 0;
    const app = new Hono();
    app.use(
      rateLimit({ limit: 1, windowMs: 60_000, maxKeys: 3, keyOf: () => `k${n}`, now: () => 0 }),
    );
    app.get('/', (c) => c.text('ok'));
    for (n = 0; n < 10; n += 1) {
      expect((await app.request('/')).status).toBe(200);
    }
    // k0 was evicted to make room, so it starts a fresh window instead of being over the limit.
    n = 0;
    expect((await app.request('/')).status).toBe(200);
    // k9 is still tracked and over its limit.
    n = 9;
    expect((await app.request('/')).status).toBe(429);
  });
});
