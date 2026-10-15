import { HOUR_MS } from '@review-ratio/contract';
import { describe, expect, it } from 'vitest';

import {
  ACTION_WEIGHTS,
  CLASS_WEIGHTS,
  PARAMETERS,
  WINDOW_HOURS,
  decay,
  score,
  scoreDown,
  scoreUp,
  sizeTiers,
  weightedLines,
} from '../src/formula.ts';
import type { DownRecord, UpRecord } from '../src/model.ts';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const hoursAgo = (h: number) => NOW - h * HOUR_MS;

function up(overrides: Partial<UpRecord> = {}): UpRecord {
  return {
    tMs: NOW,
    action: 'approve',
    linesByClass: { production: 400 },
    commentedLinesByClass: {},
    viewedLinesByClass: {},
    waitedHoursWithoutReview: 0,
    ...overrides,
  };
}

function down(overrides: Partial<DownRecord> = {}): DownRecord {
  return { prKey: 'k', readyAtMs: NOW, linesByClass: { production: 400 }, ...overrides };
}

describe('weightedLines', () => {
  it('sums class weight times lines', () => {
    expect(weightedLines({ production: 100, docs: 100 })).toBeCloseTo(
      100 + 100 * CLASS_WEIGHTS.docs,
    );
    expect(weightedLines({})).toBe(0);
  });

  it('weights production highest and generated lowest', () => {
    const sorted = Object.entries(CLASS_WEIGHTS).sort(([, a], [, b]) => b - a);
    expect(sorted[0]![0]).toBe('production');
    expect(sorted.at(-1)![0]).toBe('generated');
    for (const weight of Object.values(CLASS_WEIGHTS)) {
      expect(weight).toBeGreaterThan(0);
      expect(weight).toBeLessThanOrEqual(1);
    }
  });
});

describe('decay', () => {
  it('is 1.0 during the first 24h', () => {
    expect(decay(0)).toBe(1);
    expect(decay(12)).toBe(1);
    expect(decay(24)).toBe(1);
  });

  it('falls linearly to 0.3 at day 7', () => {
    expect(decay(WINDOW_HOURS)).toBe(0);
    expect(decay(WINDOW_HOURS - 1e-9)).toBeCloseTo(PARAMETERS.decayFloor, 6);
    const mid = 24 + (WINDOW_HOURS - 24) / 2;
    expect(decay(mid)).toBeCloseTo((1 + PARAMETERS.decayFloor) / 2);
    expect(decay(48)).toBeGreaterThan(decay(72));
  });

  it('is 0 after the window and 1 for the future or invalid ages', () => {
    expect(decay(WINDOW_HOURS + 1)).toBe(0);
    expect(decay(10_000)).toBe(0);
    expect(decay(-5)).toBe(1);
    expect(decay(Number.NaN)).toBe(0);
  });
});

describe('sizeTiers', () => {
  it('matches the worked example of the design: 1,200 lines cost 1,700', () => {
    expect(sizeTiers(1200)).toBe(400 + 600 * 1.5 + 200 * 2);
  });

  it('has no cliff at a tier boundary', () => {
    expect(sizeTiers(400)).toBe(400);
    expect(sizeTiers(401)).toBeCloseTo(401.5);
    expect(sizeTiers(1000)).toBe(400 + 600 * 1.5);
    expect(sizeTiers(1001)).toBeCloseTo(400 + 600 * 1.5 + 2);
  });

  it('is identity under 400 and 0 for nothing', () => {
    expect(sizeTiers(0)).toBe(0);
    expect(sizeTiers(-10)).toBe(0);
    expect(sizeTiers(399)).toBe(399);
  });
});

describe('scoreUp', () => {
  it('scores a plain approve at covered lines', () => {
    expect(scoreUp(up(), NOW)).toBe(400);
  });

  it('weights request changes like an approve and a comment-only review at 0.4', () => {
    expect(scoreUp(up({ action: 'request_changes' }), NOW)).toBe(400);
    expect(scoreUp(up({ action: 'comment' }), NOW)).toBeCloseTo(400 * ACTION_WEIGHTS.comment);
  });

  it('gives a thread reply the commented-lines term only', () => {
    const record = up({ action: 'thread_reply', commentedLinesByClass: { production: 10 } });
    expect(scoreUp(record, NOW)).toBe(10 * PARAMETERS.commentMultiplier);
  });

  it('adds comments and Viewed files', () => {
    const record = up({
      commentedLinesByClass: { production: 20 },
      viewedLinesByClass: { production: 400 },
    });
    expect(scoreUp(record, NOW)).toBeCloseTo(
      400 + 20 * PARAMETERS.commentMultiplier + 400 * PARAMETERS.viewedBonus,
    );
  });

  it('applies the rescue above 48h and not at 48h', () => {
    expect(scoreUp(up({ waitedHoursWithoutReview: 49 }), NOW)).toBe(400 * 1.5);
    expect(scoreUp(up({ waitedHoursWithoutReview: 48 }), NOW)).toBe(400);
  });

  it('decays with the age of the review', () => {
    expect(scoreUp(up({ tMs: hoursAgo(24) }), NOW)).toBe(400);
    expect(scoreUp(up({ tMs: hoursAgo(100) }), NOW)).toBeCloseTo(400 * decay(100));
    expect(scoreUp(up({ tMs: hoursAgo(WINDOW_HOURS) }), NOW)).toBe(0);
  });

  it('does not apply the size malus on ↑', () => {
    expect(scoreUp(up({ linesByClass: { production: 1200 } }), NOW)).toBe(1200);
  });
});

describe('scoreDown', () => {
  it('scores a small PR at its weighted lines', () => {
    expect(scoreDown(down(), NOW)).toBe(400);
  });

  it('applies the size malus to weighted lines', () => {
    expect(scoreDown(down({ linesByClass: { production: 1200 } }), NOW)).toBe(1700);
    const docsOnly = down({ linesByClass: { docs: 1200 } });
    expect(scoreDown(docsOnly, NOW)).toBeCloseTo(sizeTiers(1200 * CLASS_WEIGHTS.docs));
  });

  it('decays from the ready-for-review time and ignores the close time', () => {
    const open = down({ readyAtMs: hoursAgo(100) });
    const closed = down({ readyAtMs: hoursAgo(100), closedAtMs: hoursAgo(90) });
    expect(scoreDown(open, NOW)).toBeCloseTo(400 * decay(100));
    expect(scoreDown(closed, NOW)).toBe(scoreDown(open, NOW));
  });

  it('drops out at day 7 even when still open', () => {
    expect(scoreDown(down({ readyAtMs: hoursAgo(WINDOW_HOURS) }), NOW)).toBe(0);
  });
});

describe('score', () => {
  it('returns rounded totals and a 2-decimal ratio', () => {
    const result = score(
      { contractVersion: 1, up: [up({ linesByClass: { production: 600 } })], down: [down()] },
      NOW,
    );
    expect(result).toEqual({ up: 600, down: 400, ratio: 1.5 });
  });

  it('returns a null ratio when nothing was asked', () => {
    expect(score({ contractVersion: 1, up: [up()], down: [] }, NOW)).toEqual({
      up: 400,
      down: 0,
      ratio: null,
    });
    expect(score({ contractVersion: 1, up: [], down: [] }, NOW)).toEqual({
      up: 0,
      down: 0,
      ratio: null,
    });
  });

  it('returns ratio 0 when nothing was given', () => {
    expect(score({ contractVersion: 1, up: [], down: [down()] }, NOW)).toEqual({
      up: 0,
      down: 400,
      ratio: 0,
    });
  });
});
