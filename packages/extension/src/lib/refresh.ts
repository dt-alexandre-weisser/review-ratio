/**
 * One refresh: settings → GitHub window → records → local score → cache.
 * Pure orchestration over injected dependencies so it can be tested without Chrome.
 */
import { createClassifier } from './classify.ts';
import { collectWindow } from './collect/index.ts';
import { GitHubAuthError, GitHubError, GitHubRateLimitError } from './github/client.ts';
import type { GitHubClient } from './github/types.ts';
import { CLASS_GLOBS } from './scoring/classes.ts';
import { score } from './scoring/formula.ts';
import { buildRecords } from './scoring/records.ts';
import type { BadgeCache, Store } from './storage.ts';
import { REFRESH_INTERVAL_MS, REFRESH_LOCK_MS } from './time.ts';

export interface RefreshDeps {
  store: Store;
  now: () => number;
  github: (token: string) => GitHubClient;
  randomUUID: () => string;
  log?: (message: string) => void;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** A GitHub rate limit never asks to wait longer than this; a later date comes from a clock jump. */
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Whether a refresh should start now: not in flight, not backing off, older than the interval.
 * Times in the future (the clock was set back) are ignored rather than blocking refreshes.
 */
export function isRefreshDue(cache: BadgeCache, nowMs: number): boolean {
  const past = (at: number | null): at is number => at !== null && at <= nowMs;
  if (
    cache.notBefore !== null &&
    nowMs < cache.notBefore &&
    cache.notBefore - nowMs <= MAX_BACKOFF_MS
  ) {
    return false;
  }
  if (past(cache.refreshStartedAt) && nowMs - cache.refreshStartedAt < REFRESH_LOCK_MS) {
    return false;
  }
  if (past(cache.attemptedAt) && nowMs - cache.attemptedAt < REFRESH_INTERVAL_MS) return false;
  return true;
}

export async function refreshIfDue(
  deps: RefreshDeps,
  reason?: string,
): Promise<{ cache: BadgeCache; refreshed: boolean }> {
  const cache = await deps.store.getBadge();
  if (!isRefreshDue(cache, deps.now())) return { cache, refreshed: false };
  return { cache: await refresh(deps, reason), refreshed: true };
}

/** `reason` says what asked for the refresh, for the log. */
export async function refresh(deps: RefreshDeps, reason?: string): Promise<BadgeCache> {
  const { store } = deps;
  await store.migrate();
  const settings = await store.getSettings();
  if (!settings.token) {
    // Once, not on every page load: without a token no refresh is ever recorded as attempted.
    if ((await store.getBadge()).status !== 'no_token') {
      deps.log?.('refresh skipped: no GitHub token');
    }
    return store.updateBadge({
      status: 'no_token',
      error: null,
      refreshStartedAt: null,
      unfinishedRefreshes: 0,
    });
  }

  const startedAt = deps.now();
  deps.log?.(`refresh started${reason ? ` (${reason})` : ''}`);
  const before = await store.getBadge();
  await store.updateBadge({
    refreshStartedAt: startedAt,
    attemptedAt: startedAt,
    notBefore: null,
    unfinishedRefreshes: before.unfinishedRefreshes + 1,
  });

  try {
    const collected = await collectWindow({
      github: deps.github(settings.token),
      settings,
      classify: createClassifier(CLASS_GLOBS),
      nowMs: startedAt,
      prKeys: await store.getPrKeys(),
      viewedSnapshots: await store.getViewedSnapshots(),
      compareCache: await store.getCompareCache(),
      randomUUID: deps.randomUUID,
    });
    await store.setPrKeys(collected.prKeys);
    await store.setViewedSnapshots(collected.viewedSnapshots);
    await store.setCompareCache(collected.compareCache);

    const records = buildRecords(collected.up, collected.down);
    const result = score(records, deps.now());
    deps.log?.(
      `refreshed: ${plural(records.up.length, 'review')}, ${plural(records.down.length, 'own PR')}, ` +
        `${collected.skipped} of ${plural(collected.total, 'PR')} skipped → ${JSON.stringify(result)}`,
    );
    return await store.updateBadge({
      status: 'ok',
      score: result,
      scoredAt: deps.now(),
      error:
        collected.skipped > 0 ? `${collected.skipped} pull request(s) could not be read` : null,
      refreshStartedAt: null,
      unfinishedRefreshes: 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.(`refresh failed: ${message}`);
    return store.updateBadge({
      ...failure(error),
      error: message,
      refreshStartedAt: null,
      unfinishedRefreshes: 0,
    });
  }
}

function failure(error: unknown): Pick<BadgeCache, 'status' | 'notBefore'> {
  if (error instanceof GitHubAuthError) return { status: 'bad_token', notBefore: null };
  if (error instanceof GitHubRateLimitError)
    return { status: 'github_error', notBefore: error.resetAtMs };
  if (error instanceof GitHubError) return { status: 'github_error', notBefore: null };
  return { status: 'stale', notBefore: null };
}
