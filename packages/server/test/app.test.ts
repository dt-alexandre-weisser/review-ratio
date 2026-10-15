import { FIXTURES_BY_MAJOR } from '@review-ratio/contract/fixtures';
import { classesResponseV1, scoreResponseV1, type } from '@review-ratio/contract';
import { describe, expect, it } from 'vitest';

import { MAX_BODY_BYTES, createApp, isAllowedOrigin } from '../src/app.ts';
import { forwardedClientIp } from '../src/rate-limit.ts';
import type { Decoder } from '../src/decoders/index.ts';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const anchor = FIXTURES_BY_MAJOR[1]!.find((f) => f.name === 'anchor')!;

function app(overrides: Parameters<typeof createApp>[0] = {}) {
  return createApp({ now: () => NOW, log: null, ...overrides });
}

async function json(res: Response): Promise<any> {
  return res.json();
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('GET /health', () => {
  it('reports the supported and retired majors', async () => {
    const res = await app().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: expect.any(String),
      contract: { supported: [1], retired: [] },
    });
  });
});

describe('GET /classes', () => {
  it('returns names and globs, cacheable', async () => {
    const res = await app().request('/classes');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age');
    const body = classesResponseV1(await res.json());
    expect(body).not.toBeInstanceOf(type.errors);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/weight/i);
  });
});

describe('POST /score', () => {
  it('scores a valid payload with the server clock', async () => {
    const res = await app().request(post(anchor.payload));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = scoreResponseV1(await res.json());
    expect(body).toEqual({ up: 400, down: 400, ratio: 1 });
  });

  it('rejects a payload that breaks the contract with the problems', async () => {
    const res = await app().request(post({ contractVersion: 1, up: [{ t: 'now' }], down: [] }));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe('invalid_payload');
    expect(body.error.problems.length).toBeGreaterThan(0);
  });

  it('rejects a body that is not JSON', async () => {
    const res = await app().request(post('{not json'));
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('invalid_json');
  });

  it('rejects a missing contract version', async () => {
    const res = await app().request(post({ up: [], down: [] }));
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('invalid_payload');
    const res2 = await app().request(post([1, 2]));
    expect(res2.status).toBe(400);
  });

  it('rejects an unknown major with 400', async () => {
    const res = await app().request(post({ contractVersion: 99, up: [], down: [] }));
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('unsupported_version');
  });

  it('answers 426 for a retired major', async () => {
    const retired = app({ decoders: new Map<number, Decoder>(), retiredMajors: new Set([1]) });
    const res = await retired.request(post(anchor.payload));
    expect(res.status).toBe(426);
    expect((await json(res)).error.code).toBe('upgrade_required');
  });

  it('rejects an oversized body with 413', async () => {
    const huge = JSON.stringify({
      contractVersion: 1,
      up: [],
      down: [],
      pad: 'x'.repeat(MAX_BODY_BYTES),
    });
    const res = await app().request(post(huge));
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe('payload_too_large');
  });

  it('rate limits a runaway client and recovers after the window', async () => {
    let clock = NOW;
    const limited = app({
      now: () => clock,
      rateLimit: {
        limit: 2,
        windowMs: 1000,
        keyOf: (c) => forwardedClientIp(c.req.header('x-forwarded-for'), 1) ?? 'unknown',
      },
    });
    const headers = { 'x-forwarded-for': '203.0.113.7' };
    expect((await limited.request(post(anchor.payload, headers))).status).toBe(200);
    expect((await limited.request(post(anchor.payload, headers))).status).toBe(200);
    const third = await limited.request(post(anchor.payload, headers));
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('1');
    expect(third.headers.get('ratelimit-remaining')).toBe('0');
    expect((await json(third)).error.code).toBe('rate_limited');
    // Another client is not affected.
    const other = await limited.request(
      post(anchor.payload, { 'x-forwarded-for': '198.51.100.2' }),
    );
    expect(other.status).toBe(200);
    clock += 1001;
    expect((await limited.request(post(anchor.payload, headers))).status).toBe(200);
  });

  it('does not rate limit the class globs', async () => {
    const limited = app({ rateLimit: { limit: 1, windowMs: 1000, keyOf: () => 'one' } });
    for (let i = 0; i < 3; i += 1) {
      expect((await limited.request('/classes')).status).toBe(200);
    }
  });
});

describe('cross-cutting', () => {
  it('answers 404 as JSON', async () => {
    const res = await app().request('/nope');
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('not_found');
  });

  it('allows the extension origin and refuses others', async () => {
    const id = 'a'.repeat(32);
    expect(isAllowedOrigin(`chrome-extension://${id}`)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
    const res = await app().request(
      new Request('http://localhost/score', {
        method: 'OPTIONS',
        headers: {
          origin: `chrome-extension://${id}`,
          'access-control-request-method': 'POST',
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(`chrome-extension://${id}`);
    const refused = await app().request('/classes', {
      headers: { origin: 'https://evil.example' },
    });
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('logs one line per request without the body', async () => {
    const lines: string[] = [];
    const logged = app({ log: (line) => lines.push(line) });
    await logged.request(post(anchor.payload));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^POST \/score 200 \d+ms id=/);
    expect(lines[0]).not.toContain('contractVersion');
  });

  it('turns an unexpected error into a 500 JSON body', async () => {
    const broken = app({
      decoders: new Map<number, Decoder>([
        [
          1,
          {
            major: 1,
            decode: () => {
              throw new Error('boom');
            },
          },
        ],
      ]),
    });
    const res = await broken.request(post(anchor.payload));
    expect(res.status).toBe(500);
    expect((await json(res)).error.code).toBe('internal');
  });
});
