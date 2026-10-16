/**
 * Gates of the formula (DESIGN.md › Formula):
 * - the fixtures score to the snapshot, so a change of the formula shows in review;
 * - the anchor invariant holds through the whole local pipeline, rounding included;
 * - the bundled globs cover every class but the default one.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CLASS_GLOBS, FILE_CLASSES, type LinesByClass } from '../../src/lib/scoring/classes.ts';
import { CLASS_WEIGHTS, score, scoreDown, scoreUp } from '../../src/lib/scoring/formula.ts';
import type { Records, ReviewAction } from '../../src/lib/scoring/model.ts';
import { buildRecords } from '../../src/lib/scoring/records.ts';
import { HOUR_MS, roundToHour } from '../../src/lib/scoring/rounding.ts';

/** A fixture as stored: the records with ISO times, easier to read and write by hand. */
interface Fixture {
  description: string;
  now: string;
  records: {
    up: {
      t: string;
      action: ReviewAction;
      linesByClass: LinesByClass;
      commentedLinesByClass: LinesByClass;
      viewedLinesByClass: LinesByClass;
      waitedHoursWithoutReview: number;
    }[];
    down: { readyAt: string; linesByClass: LinesByClass }[];
  };
}

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');
const FIXTURES = readdirSync(FIXTURES_DIR)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as Fixture;
    return [file.replace(/\.json$/, ''), fixture] as const;
  });

function toRecords({ records }: Fixture): Records {
  return {
    up: records.up.map(({ t, ...rest }) => ({ ...rest, tMs: Date.parse(t) })),
    down: records.down.map(({ readyAt, linesByClass }) => ({
      readyAtMs: Date.parse(readyAt),
      linesByClass,
    })),
  };
}

describe('fixtures', () => {
  it('exist', () => {
    expect(FIXTURES.map(([name]) => name)).toEqual([
      'anchor',
      'clock-skew',
      'down-only',
      'empty',
      'mixed',
      'up-only',
    ]);
  });

  it.each(FIXTURES)('scores fixture %s', (_name, fixture) => {
    const result = score(toRecords(fixture), Date.parse(fixture.now));
    expect(result.up).toBeGreaterThanOrEqual(0);
    expect(result.down).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.up)).toBe(true);
    expect(Number.isInteger(result.down)).toBe(true);
    expect(result).toMatchSnapshot();
  });
});

describe('anchor invariant', () => {
  it.each([0, 1, 23, 24, 36, 72, 120, 167])('holds at age %ih', (ageHours) => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    const at = roundToHour(now - ageHours * HOUR_MS);
    for (const lines of [10, 100, 390, 400]) {
      const records = buildRecords(
        [
          {
            reviewId: 'PRR_anchor',
            tMs: at,
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
            readyAtMs: at,
            linesByClass: { production: lines },
          },
        ],
      );
      const result = score(records, now);
      expect(result.ratio, `lines=${lines}`).toBe(1);
      expect(result.up).toBe(result.down);
      // Exact, before rounding: a weight of 1.001 must not hide behind the rounding.
      const [up] = records.up;
      const [down] = records.down;
      expect(scoreUp(up!, now)).toBe(scoreDown(down!, now));
    }
  });
});

describe('bundled classes', () => {
  it('hold names and globs only, never weights', () => {
    for (const cls of CLASS_GLOBS) {
      expect(Object.keys(cls).sort()).toEqual(['globs', 'name']);
      expect(cls.globs.length).toBeGreaterThan(0);
    }
  });

  it('cover every class except the default, production', () => {
    const bundled = new Set(CLASS_GLOBS.map((c) => c.name));
    expect(bundled.has('production')).toBe(false);
    for (const name of FILE_CLASSES) {
      if (name === 'production') continue;
      expect(bundled.has(name), name).toBe(true);
    }
    expect(Object.keys(CLASS_WEIGHTS).sort()).toEqual([...FILE_CLASSES].sort());
  });
});
