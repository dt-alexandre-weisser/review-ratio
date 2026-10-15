import { payloadV1, type } from '@review-ratio/contract';
import { describe, expect, it } from 'vitest';

import { buildPayload, hashUnit, roundLinesByClass } from '../src/lib/payload.ts';
import { NOW } from './helpers/github.ts';

describe('hashUnit', () => {
  it('is deterministic and in [0, 1)', () => {
    expect(hashUnit('a')).toBe(hashUnit('a'));
    expect(hashUnit('a')).not.toBe(hashUnit('b'));
    for (let i = 0; i < 1000; i += 1) {
      const u = hashUnit(`seed-${i}`);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it('is roughly uniform, so rounding stays unbiased', () => {
    let sum = 0;
    const n = 5000;
    for (let i = 0; i < n; i += 1) sum += hashUnit(`review-${i}:commented:production`);
    expect(sum / n).toBeGreaterThan(0.47);
    expect(sum / n).toBeLessThan(0.53);
  });
});

describe('roundLinesByClass', () => {
  it('rounds to the nearest 10 by default, so equal sizes round alike', () => {
    expect(roundLinesByClass({ production: 15, test: 4, docs: 0 })).toEqual({ production: 20 });
    expect(roundLinesByClass({ production: 1234 })).toEqual({ production: 1230 });
  });

  it('rounds without bias when seeded, stable per seed', () => {
    const lines = { production: 1234, test: 3 };
    const a = roundLinesByClass(lines, 'seed');
    expect(a).toEqual(roundLinesByClass(lines, 'seed'));
    expect([1230, 1240]).toContain(a.production);
    expect([undefined, 10]).toContain(a.test);
  });

  it('keeps the expected value of small seeded counts', () => {
    let sum = 0;
    const n = 4000;
    for (let i = 0; i < n; i += 1) {
      sum += roundLinesByClass({ production: 2 }, `r${i}`).production ?? 0;
    }
    expect(sum / n).toBeGreaterThan(1.7);
    expect(sum / n).toBeLessThan(2.3);
  });
});

describe('buildPayload', () => {
  it('builds a valid, rounded, anonymous payload', () => {
    const payload = buildPayload(
      [
        {
          reviewId: 'r1',
          tMs: NOW - 31 * 60_000,
          action: 'approve',
          linesByClass: { production: 400 },
          commentedLinesByClass: { production: 20 },
          viewedLinesByClass: {},
          waitedHoursWithoutReview: 48.2,
        },
      ],
      [
        {
          prKey: '0f6f9a1e-5a7d-4c1b-9d2e-2b1d8c3f4a5b',
          readyAtMs: NOW - 2 * 3_600_000 - 1,
          closedAtMs: NOW,
          linesByClass: { production: 400 },
        },
        {
          prKey: '1f6f9a1e-5a7d-4c1b-9d2e-2b1d8c3f4a5b',
          readyAtMs: NOW,
          closedAtMs: null,
          linesByClass: {},
        },
      ],
    );
    expect(payloadV1(payload)).not.toBeInstanceOf(type.errors);
    expect(payload).toEqual({
      contractVersion: 1,
      up: [
        {
          t: '2026-10-15T11:00:00.000Z',
          action: 'approve',
          linesByClass: { production: 400 },
          commentedLinesByClass: { production: 20 },
          viewedLinesByClass: {},
          waitedHoursWithoutReview: 49,
        },
      ],
      down: [
        {
          prKey: '0f6f9a1e-5a7d-4c1b-9d2e-2b1d8c3f4a5b',
          readyAt: '2026-10-15T10:00:00.000Z',
          closedAt: '2026-10-15T12:00:00.000Z',
          linesByClass: { production: 400 },
        },
        {
          prKey: '1f6f9a1e-5a7d-4c1b-9d2e-2b1d8c3f4a5b',
          readyAt: '2026-10-15T12:00:00.000Z',
          linesByClass: {},
        },
      ],
    });
  });

  it('never carries identifying fields', () => {
    const payload = buildPayload(
      [
        {
          reviewId: 'PRR_kwDOsecret',
          tMs: NOW,
          action: 'comment',
          linesByClass: { production: 10 },
          commentedLinesByClass: {},
          viewedLinesByClass: {},
          waitedHoursWithoutReview: 0,
        },
      ],
      [],
    );
    expect(JSON.stringify(payload)).not.toContain('PRR_kwDOsecret');
  });

  it('refuses a payload that would break the contract', () => {
    expect(() =>
      buildPayload(
        [],
        [{ prKey: 'DiliTrust/app#1', readyAtMs: NOW, closedAtMs: null, linesByClass: {} }],
      ),
    ).toThrow(/contract/);
  });
});

describe('buildPayload and the anchor invariant', () => {
  it('rounds an approve and an own PR of the same size the same way', () => {
    for (const lines of [5, 14, 15, 25, 333, 404, 405]) {
      const payload = buildPayload(
        [
          {
            reviewId: `r-${lines}`,
            tMs: NOW,
            action: 'approve',
            linesByClass: { production: lines },
            commentedLinesByClass: {},
            viewedLinesByClass: {},
            waitedHoursWithoutReview: 0,
          },
        ],
        [
          {
            prKey: '0f6f9a1e-5a7d-4c1b-9d2e-2b1d8c3f4a5b',
            readyAtMs: NOW,
            closedAtMs: null,
            linesByClass: { production: lines },
          },
        ],
      );
      expect(payload.up[0]!.linesByClass, `lines=${lines}`).toEqual(payload.down[0]!.linesByClass);
    }
  });
});
