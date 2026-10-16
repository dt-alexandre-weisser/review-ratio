import { describe, expect, it } from 'vitest';

import {
  MAX_DOWN_RECORDS,
  MAX_LINES,
  MAX_UP_RECORDS,
  buildRecords,
  hashUnit,
  roundLinesByClass,
} from '../../src/lib/scoring/records.ts';
import { NOW } from '../helpers/github.ts';

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

describe('buildRecords', () => {
  it('rounds times to the hour and lines to 10', () => {
    const records = buildRecords(
      [
        {
          reviewId: 'r1',
          tMs: NOW - 31 * 60_000,
          action: 'approve',
          linesByClass: { production: 404 },
          commentedLinesByClass: { production: 20 },
          viewedLinesByClass: {},
          waitedHoursWithoutReview: 48.2,
        },
      ],
      [
        {
          prKey: '0f6f9a1e-5a7d-4c1b-9d2e-2b1d8c3f4a5b',
          readyAtMs: NOW - 2 * 3_600_000 - 1,
          linesByClass: { production: 396 },
        },
        {
          prKey: '1f6f9a1e-5a7d-4c1b-9d2e-2b1d8c3f4a5b',
          readyAtMs: NOW,
          linesByClass: {},
        },
      ],
    );
    expect(records).toEqual({
      up: [
        {
          tMs: Date.parse('2026-10-15T11:00:00Z'),
          action: 'approve',
          linesByClass: { production: 400 },
          commentedLinesByClass: { production: 20 },
          viewedLinesByClass: {},
          waitedHoursWithoutReview: 48.2,
        },
      ],
      down: [
        { readyAtMs: Date.parse('2026-10-15T10:00:00Z'), linesByClass: { production: 400 } },
        { readyAtMs: NOW, linesByClass: {} },
      ],
    });
  });

  it('keeps no identifier', () => {
    const records = buildRecords(
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
      [{ prKey: 'secret-key', readyAtMs: NOW, linesByClass: {} }],
    );
    expect(JSON.stringify(records)).not.toContain('secret');
  });

  it('refuses an invalid time', () => {
    expect(() =>
      buildRecords([], [{ prKey: 'k', readyAtMs: Number.NaN, linesByClass: {} }]),
    ).toThrow(TypeError);
  });
});

describe('buildRecords and the anchor invariant', () => {
  it('rounds an approve and an own PR of the same size the same way', () => {
    for (const lines of [5, 14, 15, 25, 333, 404, 405]) {
      const records = buildRecords(
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
            linesByClass: { production: lines },
          },
        ],
      );
      expect(records.up[0]!.linesByClass, `lines=${lines}`).toEqual(records.down[0]!.linesByClass);
    }
  });
});

describe('buildRecords within its limits', () => {
  const up = (i: number, tMs = NOW - i * 60_000) => ({
    reviewId: `r${i}`,
    tMs,
    action: 'thread_reply' as const,
    linesByClass: {},
    commentedLinesByClass: { production: 10 },
    viewedLinesByClass: {},
    waitedHoursWithoutReview: 0,
  });

  it('clamps a huge file', () => {
    const records = buildRecords(
      [],
      [
        {
          prKey: '0f6f9a1e-5a7d-4c1b-9d2e-2b1d8c3f4a5b',
          readyAtMs: NOW,
          linesByClass: { config: 1_200_000 },
        },
      ],
    );
    expect(records.down[0]!.linesByClass).toEqual({ config: MAX_LINES });
  });

  it('keeps the newest records when there are too many', () => {
    const many = Array.from({ length: MAX_UP_RECORDS + 20 }, (_, i) => up(i));
    const records = buildRecords(many, []);
    expect(records.up).toHaveLength(MAX_UP_RECORDS);
    const oldestKept = records.up[0]!.tMs;
    expect(oldestKept).toBeGreaterThanOrEqual(NOW - (MAX_UP_RECORDS + 1) * 60_000 - 3_600_000);
    const downs = Array.from({ length: MAX_DOWN_RECORDS + 5 }, (_, i) => ({
      prKey: `0f6f9a1e-5a7d-4c1b-9d2e-${String(i).padStart(12, '0')}`,
      readyAtMs: NOW - i * 3_600_000,
      linesByClass: {},
    }));
    expect(buildRecords([], downs).down).toHaveLength(MAX_DOWN_RECORDS);
  });

  it('orders records by time, so their order does not group them by PR', () => {
    const records = buildRecords([up(1, NOW), up(2, NOW - 7_200_000), up(3, NOW - 3_600_000)], []);
    const times = records.up.map((r) => r.tMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
