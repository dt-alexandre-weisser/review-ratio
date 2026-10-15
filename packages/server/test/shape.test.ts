import { FIXTURES_BY_MAJOR } from '@review-ratio/contract/fixtures';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.ts';
import { networkKey } from '../src/rate-limit.ts';
import { SHAPE_LIMITS, shapeProblem } from '../src/shape.ts';

describe('shapeProblem', () => {
  it('accepts every fixture of every major', () => {
    for (const fixtures of Object.values(FIXTURES_BY_MAJOR)) {
      for (const fixture of fixtures)
        expect(shapeProblem(fixture.payload), fixture.name).toBeNull();
    }
  });

  it('rejects objects with too many keys, long arrays and deep nesting', () => {
    const wide = Object.fromEntries(
      Array.from({ length: SHAPE_LIMITS.maxKeys + 1 }, (_, i) => [`k${i}`, 1]),
    );
    expect(shapeProblem({ up: [{ linesByClass: wide }] })).toMatch(/keys/);
    expect(shapeProblem({ up: new Array(SHAPE_LIMITS.maxItems + 1).fill(0) })).toMatch(/items/);
    let deep: unknown = 1;
    for (let i = 0; i <= SHAPE_LIMITS.maxDepth + 1; i += 1) deep = [deep];
    expect(shapeProblem(deep)).toMatch(/deeper/);
  });

  it('rejects a body stuffed with unknown keys fast, before schema validation', async () => {
    const keys = Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [`k${i}`, 'x']));
    const payload = {
      contractVersion: 1,
      up: [
        {
          t: '2026-10-15T12:00:00Z',
          action: 'approve',
          linesByClass: keys,
          commentedLinesByClass: {},
          viewedLinesByClass: {},
          waitedHoursWithoutReview: 0,
        },
      ],
      down: [],
    };
    const app = createApp({ log: null });
    const started = performance.now();
    const res = await app.request('/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('networkKey', () => {
  it('keys IPv6 addresses by their /64 and leaves IPv4 alone', () => {
    expect(networkKey('203.0.113.7')).toBe('203.0.113.7');
    expect(networkKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(networkKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(networkKey('2001:db8:1:2::abcd')).toBe('2001:db8:1:2::/64');
    expect(networkKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(networkKey('[2001:db8:1:2::1]')).toBe('2001:db8:1:2::/64');
    expect(networkKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(networkKey('2001:0DB8:0001:0002:ffff::')).toBe('2001:db8:1:2::/64');
  });

  it('keys every IPv6 spelling of an IPv4 address, and ports, by the IPv4 address', () => {
    expect(networkKey('::ffff:c000:280')).toBe('192.0.2.128');
    expect(networkKey('::FFFF:192.0.2.128')).toBe('192.0.2.128');
    expect(networkKey('::192.0.2.128')).toBe('192.0.2.128');
    expect(networkKey('192.0.2.128:5678')).toBe('192.0.2.128');
    expect(networkKey('[2001:db8:1:2::1]:443')).toBe('2001:db8:1:2::/64');
    expect(networkKey('::1')).toBe('0:0:0:0::/64');
    expect(networkKey('garbage:::')).toBe('garbage:::');
  });
});
