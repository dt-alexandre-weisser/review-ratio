/**
 * Pure mapping from the cached state to what the badge shows. See DESIGN.md › Badge.
 */
import type { BadgeCache } from './storage.ts';
import { REFRESH_LOCK_MS, localClock } from './time.ts';

export type Tone = 'good' | 'neutral' | 'low';

export interface BadgeView {
  /** Main text, e.g. `↑ 64,129 RP · ↓ 43,002 RP | Ratio 1.49`. */
  text: string;
  /** Short text for narrow headers, e.g. `Ratio 1.49`. */
  short: string;
  /**
   * The three parts of `text` when it shows a score, coloured apart: ↑ like GitHub's added lines,
   * ↓ like its removed lines, the ratio by tone.
   */
  parts: { up: string; down: string; ratio: string } | null;
  tone: Tone;
  /** Greyed out: the numbers are old or there are none. */
  stale: boolean;
  tooltip: string;
}

const GIVEN_ASKED = 'given / asked';

export function formatRp(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} RP`;
}

export function formatRatio(ratio: number): string {
  return ratio.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function toneOf(ratio: number | null, up: number): Tone {
  if (ratio === null) return up > 0 ? 'good' : 'neutral';
  if (ratio >= 1) return 'good';
  if (ratio >= 0.5) return 'neutral';
  return 'low';
}

export function badgeView(cache: BadgeCache, nowMs: number): BadgeView {
  if (cache.status === 'no_token') {
    return {
      text: 'review-ratio: set up',
      short: 'set up',
      parts: null,
      tone: 'neutral',
      stale: true,
      tooltip: 'review-ratio is not connected to GitHub. Open the extension options to sign in.',
    };
  }
  if (cache.status === 'bad_token') {
    return {
      text: 'review-ratio: token rejected',
      short: 'token?',
      parts: null,
      tone: 'neutral',
      stale: true,
      tooltip: 'GitHub rejected the token. Check it in the extension options.',
    };
  }

  const stale = isStale(cache, nowMs);
  const score = cache.score;
  if (!score) {
    return {
      text: '↑ — · ↓ — | Ratio —',
      short: 'Ratio —',
      parts: { up: '↑ —', down: '↓ —', ratio: 'Ratio —' },
      tone: 'neutral',
      stale: true,
      tooltip: stale
        ? `review-ratio could not refresh${cache.error ? `: ${cache.error}` : ''}`
        : `review-ratio (${GIVEN_ASKED}): no activity in the last 7 days`,
    };
  }

  const { up, down, ratio } = score;
  let ratioText: string;
  let tone: Tone;
  if (down === 0 && up === 0) {
    ratioText = '—';
    tone = 'neutral';
  } else if (ratio === null) {
    ratioText = '∞';
    tone = 'good';
  } else {
    ratioText = formatRatio(ratio);
    tone = toneOf(ratio, up);
  }

  const parts = {
    up: `↑ ${formatRp(up)}`,
    down: `↓ ${formatRp(down)}`,
    ratio: `Ratio ${ratioText}`,
  };
  const text = `${parts.up} · ${parts.down} | ${parts.ratio}`;
  const tooltip = stale
    ? `stale since ${cache.scoredAt === null ? '?' : localClock(cache.scoredAt)}`
    : `review-ratio (${GIVEN_ASKED}), last 7 days`;
  return {
    text,
    short: parts.ratio,
    parts,
    tone: stale ? 'neutral' : tone,
    stale,
    tooltip,
  };
}

/**
 * Whether the score shown is out of date: the last refresh failed, a refresh that started never
 * finished (a service worker killed mid-refresh leaves the status `ok`), or the current refresh
 * follows one that died. A refresh that is merely running does not grey the badge.
 */
export function isStale(cache: BadgeCache, nowMs: number): boolean {
  if (cache.status === 'stale' || cache.status === 'github_error') return true;
  if (cache.unfinishedRefreshes > 1) return true;
  return cache.refreshStartedAt !== null && nowMs - cache.refreshStartedAt > REFRESH_LOCK_MS;
}
