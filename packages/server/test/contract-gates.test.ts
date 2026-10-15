/**
 * CI gates of the contract (DESIGN.md › Code):
 * - every major is either supported or retired on purpose, never unknown;
 * - the fixtures of every supported major decode and score against the current server;
 * - the anchor invariant holds on every supported major.
 */
import { CONTRACT_MAJORS, FILE_CLASSES, HOUR_MS, roundToHour } from '@review-ratio/contract';
import { FIXTURES_BY_MAJOR } from '@review-ratio/contract/fixtures';
import { describe, expect, it } from 'vitest';

import { PUBLISHED_CLASSES } from '../src/classes.ts';
import { DECODERS, versionStatus } from '../src/decoders/index.ts';
import { CLASS_WEIGHTS, score } from '../src/formula.ts';
import { ANCHOR_BUILDERS } from './anchors.ts';

const supported = [...DECODERS.keys()];

describe('contract majors', () => {
  it('knows every major that exists', () => {
    for (const major of CONTRACT_MAJORS) {
      expect(versionStatus(major), `major ${major}`).not.toBe('unknown');
    }
  });

  it('has fixtures and an anchor builder for every supported major', () => {
    for (const major of supported) {
      expect(FIXTURES_BY_MAJOR[major]?.length, `fixtures of major ${major}`).toBeGreaterThan(0);
      expect(ANCHOR_BUILDERS[major], `anchor builder of major ${major}`).toBeTypeOf('function');
    }
  });
});

describe.each(supported)('major %i', (major) => {
  const decoder = DECODERS.get(major)!;

  it.each(FIXTURES_BY_MAJOR[major]!.map((f) => [f.name, f] as const))(
    'decodes and scores fixture %s',
    (_name, fixture) => {
      const decoded = decoder.decode(fixture.payload);
      expect(decoded.ok, decoded.ok ? '' : decoded.problems.join('; ')).toBe(true);
      if (!decoded.ok) return;
      const result = score(decoded.payload, Date.parse(fixture.now));
      expect(result.up).toBeGreaterThanOrEqual(0);
      expect(result.down).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result.up)).toBe(true);
      expect(Number.isInteger(result.down)).toBe(true);
      expect(result).toMatchSnapshot();
    },
  );

  it.each([0, 1, 23, 24, 36, 72, 120, 167])('holds the anchor invariant at age %ih', (ageHours) => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    const at = roundToHour(now - ageHours * HOUR_MS);
    for (const lines of [10, 100, 390, 400]) {
      const decoded = decoder.decode(ANCHOR_BUILDERS[major]!({ at, lines }));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      const result = score(decoded.payload, now);
      expect(result.ratio, `lines=${lines}`).toBe(1);
      expect(result.up).toBe(result.down);
    }
  });
});

describe('published classes', () => {
  it('publish names and globs only, never weights', () => {
    for (const cls of PUBLISHED_CLASSES) {
      expect(Object.keys(cls).sort()).toEqual(['globs', 'name']);
      expect(cls.globs.length).toBeGreaterThan(0);
    }
  });

  it('cover every class except the default, production', () => {
    const published = new Set(PUBLISHED_CLASSES.map((c) => c.name));
    expect(published.has('production')).toBe(false);
    for (const name of FILE_CLASSES) {
      if (name === 'production') continue;
      expect(published.has(name), name).toBe(true);
    }
    expect(Object.keys(CLASS_WEIGHTS).sort()).toEqual([...FILE_CLASSES].sort());
  });
});
