import { describe, expect, it } from 'vitest';

import { badgeView, formatRatio, formatRp, isStale, toneOf } from '../src/lib/badge-state.ts';
import { EMPTY_CACHE, type BadgeCache } from '../src/lib/storage.ts';

const NOW = Date.parse('2026-10-15T12:30:00Z');

function cache(patch: Partial<BadgeCache>): BadgeCache {
  return { ...EMPTY_CACHE, status: 'ok', scoredAt: Date.parse('2026-10-15T12:00:00Z'), ...patch };
}

describe('formatting', () => {
  it('formats RP with thousands separators', () => {
    expect(formatRp(64129)).toBe('64,129 RP');
    expect(formatRp(0)).toBe('0 RP');
    expect(formatRp(12.6)).toBe('13 RP');
  });

  it('formats the ratio with two decimals', () => {
    expect(formatRatio(1.49)).toBe('1.49');
    expect(formatRatio(1)).toBe('1.00');
    expect(formatRatio(0.456)).toBe('0.46');
    expect(formatRatio(1234.5)).toBe('1,234.50');
  });
});

describe('toneOf', () => {
  it.each([
    [1.0, 'good'],
    [3.2, 'good'],
    [0.99, 'neutral'],
    [0.5, 'neutral'],
    [0.49, 'low'],
    [0, 'low'],
  ] as const)('ratio %d → %s', (ratio, tone) => {
    expect(toneOf(ratio, 10)).toBe(tone);
  });

  it('treats a null ratio as ∞ when something was given', () => {
    expect(toneOf(null, 1)).toBe('good');
    expect(toneOf(null, 0)).toBe('neutral');
  });
});

describe('badgeView', () => {
  it('shows the design example', () => {
    const view = badgeView(cache({ score: { up: 64129, down: 43002, ratio: 1.49 } }), NOW);
    expect(view.text).toBe('↑ 64,129 RP · ↓ 43,002 RP | Ratio 1.49');
    expect(view.short).toBe('Ratio 1.49');
    expect(view.tone).toBe('good');
    expect(view.stale).toBe(false);
    expect(view.tooltip).toContain('given / asked');
  });

  it('is amber below 0.5, never red', () => {
    const view = badgeView(cache({ score: { up: 10, down: 100, ratio: 0.1 } }), NOW);
    expect(view.tone).toBe('low');
  });

  it('shows ∞ in green when nothing was asked', () => {
    const view = badgeView(cache({ score: { up: 120, down: 0, ratio: null } }), NOW);
    expect(view.text).toBe('↑ 120 RP · ↓ 0 RP | Ratio ∞');
    expect(view.tone).toBe('good');
  });

  it('shows — in grey when both sides are 0, and stays visible', () => {
    const view = badgeView(cache({ score: { up: 0, down: 0, ratio: null } }), NOW);
    expect(view.text).toContain('Ratio —');
    expect(view.tone).toBe('neutral');
  });

  it('greys the last ratio with "stale since HH:MM" when a refresh failed', () => {
    const scoredAt = new Date(2026, 9, 15, 9, 5).getTime();
    const view = badgeView(
      cache({ status: 'stale', scoredAt, score: { up: 10, down: 5, ratio: 2 } }),
      NOW,
    );
    expect(view.text).toContain('Ratio 2.00');
    expect(view.stale).toBe(true);
    expect(view.tone).toBe('neutral');
    expect(view.tooltip).toBe('stale since 09:05');
  });

  it('shows placeholders when stale without any score, with the reason', () => {
    const view = badgeView(
      cache({ status: 'stale', score: null, error: 'classifying files took too long' }),
      NOW,
    );
    expect(view.text).toContain('Ratio —');
    expect(view.stale).toBe(true);
    expect(view.tooltip).toBe('review-ratio could not refresh: classifying files took too long');
    const github = badgeView(
      cache({ status: 'github_error', score: null, error: 'GitHub answered 403' }),
      NOW,
    );
    expect(github.tooltip).toBe('review-ratio could not refresh: GitHub answered 403');
  });

  it('greys the last ratio on a GitHub error too', () => {
    const scoredAt = new Date(2026, 9, 15, 9, 5).getTime();
    const view = badgeView(
      cache({ status: 'github_error', scoredAt, score: { up: 10, down: 5, ratio: 2 } }),
      NOW,
    );
    expect(view).toMatchObject({ stale: true, tone: 'neutral', tooltip: 'stale since 09:05' });
  });

  it('asks for set up without a token and flags a rejected token', () => {
    expect(badgeView(cache({ status: 'no_token' }), NOW).text).toContain('set up');
    expect(badgeView(cache({ status: 'bad_token' }), NOW).text).toContain('token rejected');
  });

  it('shows the no-activity state on a fresh ok cache without a score', () => {
    const view = badgeView(cache({ status: 'ok', score: null }), NOW);
    expect(view.tooltip).toContain('no activity');
  });
});

describe('isStale', () => {
  it('is fresh after a refresh, and while one is running', () => {
    expect(isStale(cache({ refreshStartedAt: null }), NOW)).toBe(false);
    expect(isStale(cache({ refreshStartedAt: NOW - 60_000 }), NOW)).toBe(false);
    // Last score an hour old, a new refresh just started: still not stale.
    expect(isStale(cache({ scoredAt: NOW - 3_600_000, refreshStartedAt: NOW - 1_000 }), NOW)).toBe(
      false,
    );
  });

  it('is stale when a refresh started and never finished (killed worker)', () => {
    expect(isStale(cache({ refreshStartedAt: NOW - 4 * 60_000 }), NOW)).toBe(false);
    expect(isStale(cache({ refreshStartedAt: NOW - 6 * 60_000 }), NOW)).toBe(true);
    // The refresh running now follows one that died: greyed from its start.
    expect(isStale(cache({ refreshStartedAt: NOW - 1_000, unfinishedRefreshes: 2 }), NOW)).toBe(
      true,
    );
    expect(isStale(cache({ refreshStartedAt: NOW - 1_000, unfinishedRefreshes: 1 }), NOW)).toBe(
      false,
    );
    const view = badgeView(
      cache({ refreshStartedAt: NOW - 30 * 60_000, score: { up: 1, down: 1, ratio: 1 } }),
      NOW,
    );
    expect(view.stale).toBe(true);
  });

  it('is stale after a failed refresh', () => {
    expect(isStale(cache({ status: 'stale' }), NOW)).toBe(true);
    expect(isStale(cache({ status: 'github_error' }), NOW)).toBe(true);
  });
});
