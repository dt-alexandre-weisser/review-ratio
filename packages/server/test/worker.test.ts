import { FIXTURES_BY_MAJOR } from '@review-ratio/contract/fixtures';
import { describe, expect, it } from 'vitest';

import worker from '../src/worker.ts';

const anchor = FIXTURES_BY_MAJOR[1]!.find((f) => f.name === 'anchor')!;

describe('Cloudflare Workers entry', () => {
  it('serves the app and rate limits on cf-connecting-ip', async () => {
    const health = await worker.request('/health');
    expect(health.status).toBe(200);
    const res = await worker.request('/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify(anchor.payload),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('ratelimit-limit')).toBe('120');
  });
});
