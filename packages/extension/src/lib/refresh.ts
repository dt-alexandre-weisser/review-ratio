/**
 * One refresh: settings → class globs → GitHub window → payload → server score → cache.
 * Pure orchestration over injected dependencies so it can be tested without Chrome.
 */
import { createClassifier } from './classify.ts';
import { collectWindow } from './collect/index.ts';
import { GitHubAuthError, GitHubError, GitHubRateLimitError } from './github/client.ts';
import type { GitHubClient } from './github/types.ts';
import { buildPayload } from './payload.ts';
import { UpgradeRequiredError, type ServerClient } from './server-client.ts';
import { serverUrlProblem } from './settings.ts';
import type { BadgeCache, Store } from './storage.ts';
import { REFRESH_INTERVAL_MS, REFRESH_LOCK_MS } from './time.ts';

export interface RefreshDeps {
  store: Store;
  now: () => number;
  github: (token: string) => GitHubClient;
  server: (baseUrl: string) => ServerClient;
  randomUUID: () => string;
  log?: (message: string) => void;
}

/** Whether a refresh should start now: not in flight, not backing off, older than the interval. */
export function isRefreshDue(cache: BadgeCache, nowMs: number): boolean {
  if (cache.notBefore !== null && nowMs < cache.notBefore) return false;
  if (cache.refreshStartedAt !== null && nowMs - cache.refreshStartedAt < REFRESH_LOCK_MS) {
    return false;
  }
  if (cache.attemptedAt !== null && nowMs - cache.attemptedAt < REFRESH_INTERVAL_MS) return false;
  return true;
}

export async function refreshIfDue(
  deps: RefreshDeps,
): Promise<{ cache: BadgeCache; refreshed: boolean }> {
  const cache = await deps.store.getBadge();
  if (!isRefreshDue(cache, deps.now())) return { cache, refreshed: false };
  return { cache: await refresh(deps), refreshed: true };
}

export async function refresh(deps: RefreshDeps): Promise<BadgeCache> {
  const { store } = deps;
  await store.migrate();
  const settings = await store.getSettings();
  if (!settings.token) {
    return store.updateBadge({ status: 'no_token', error: null, refreshStartedAt: null });
  }

  const startedAt = deps.now();
  await store.updateBadge({ refreshStartedAt: startedAt, attemptedAt: startedAt, notBefore: null });

  try {
    const urlProblem = serverUrlProblem(settings.serverUrl);
    if (urlProblem) throw new Error(urlProblem);
    const server = deps.server(settings.serverUrl);
    // First, and every time: proves the server is up before spending GitHub calls, and keeps
    // the globs current.
    const classes = await server.fetchClasses();
    const collected = await collectWindow({
      github: deps.github(settings.token),
      settings,
      classify: createClassifier(classes),
      nowMs: startedAt,
      prKeys: await store.getPrKeys(),
      viewedSnapshots: await store.getViewedSnapshots(),
      compareCache: await store.getCompareCache(),
      randomUUID: deps.randomUUID,
    });
    await store.setPrKeys(collected.prKeys);
    await store.setViewedSnapshots(collected.viewedSnapshots);
    await store.setCompareCache(collected.compareCache);

    const payload = buildPayload(collected.up, collected.down);
    const score = await server.score(payload);
    deps.log?.(
      `refreshed: ${payload.up.length} reviews, ${payload.down.length} PRs, ` +
        `${collected.skipped} of ${collected.total} PRs skipped → ${JSON.stringify(score)}`,
    );
    return await store.updateBadge({
      status: 'ok',
      score,
      scoredAt: deps.now(),
      error:
        collected.skipped > 0 ? `${collected.skipped} pull request(s) could not be read` : null,
      refreshStartedAt: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.(`refresh failed: ${message}`);
    return store.updateBadge({ ...failure(error), error: message, refreshStartedAt: null });
  }
}

function failure(error: unknown): Pick<BadgeCache, 'status' | 'notBefore'> {
  if (error instanceof UpgradeRequiredError) return { status: 'upgrade_required', notBefore: null };
  if (error instanceof GitHubAuthError) return { status: 'bad_token', notBefore: null };
  if (error instanceof GitHubRateLimitError)
    return { status: 'github_error', notBefore: error.resetAtMs };
  if (error instanceof GitHubError) return { status: 'github_error', notBefore: null };
  return { status: 'stale', notBefore: null };
}
