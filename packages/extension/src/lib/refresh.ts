/**
 * One refresh: settings → class globs → GitHub window → payload → server score → cache.
 * Pure orchestration over injected dependencies so it can be tested without Chrome.
 */
import { createClassifier } from './classify.ts';
import { collectWindow } from './collect/index.ts';
import { GitHubAuthError } from './github/client.ts';
import type { GitHubClient } from './github/types.ts';
import { buildPayload } from './payload.ts';
import { UpgradeRequiredError, type ServerClient } from './server-client.ts';
import type { BadgeCache, Store } from './storage.ts';
import { CLASSES_TTL_MS, REFRESH_INTERVAL_MS, REFRESH_LOCK_MS } from './time.ts';

export interface RefreshDeps {
  store: Store;
  now: () => number;
  github: (token: string) => GitHubClient;
  server: (baseUrl: string) => ServerClient;
  randomUUID: () => string;
  log?: (message: string) => void;
}

/** Whether a refresh should start now: not in flight, and older than the interval. */
export function isRefreshDue(cache: BadgeCache, nowMs: number): boolean {
  if (cache.refreshStartedAt !== null && nowMs - cache.refreshStartedAt < REFRESH_LOCK_MS)
    return false;
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
  const settings = await store.getSettings();
  if (!settings.token) {
    return store.updateBadge({ status: 'no_token', error: null, refreshStartedAt: null });
  }

  const startedAt = deps.now();
  await store.updateBadge({ refreshStartedAt: startedAt, attemptedAt: startedAt });
  const server = deps.server(settings.serverUrl);

  try {
    const classes = await loadClasses(deps, server, startedAt);
    const collected = await collectWindow({
      github: deps.github(settings.token),
      settings,
      classify: createClassifier(classes),
      nowMs: startedAt,
      prKeys: await store.getPrKeys(),
      viewedSnapshots: await store.getViewedSnapshots(),
      randomUUID: deps.randomUUID,
    });
    await store.setPrKeys(collected.prKeys);
    await store.setViewedSnapshots(collected.viewedSnapshots);

    const payload = buildPayload(collected.up, collected.down);
    const score = await server.score(payload);
    deps.log?.(
      `refreshed: ${payload.up.length} reviews, ${payload.down.length} PRs → ${JSON.stringify(score)}`,
    );
    return await store.updateBadge({
      status: 'ok',
      score,
      scoredAt: deps.now(),
      error: null,
      refreshStartedAt: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.(`refresh failed: ${message}`);
    if (error instanceof UpgradeRequiredError) {
      return store.updateBadge({
        status: 'upgrade_required',
        error: message,
        refreshStartedAt: null,
      });
    }
    if (error instanceof GitHubAuthError) {
      return store.updateBadge({ status: 'bad_token', error: message, refreshStartedAt: null });
    }
    return store.updateBadge({ status: 'stale', error: message, refreshStartedAt: null });
  }
}

async function loadClasses(deps: RefreshDeps, server: ServerClient, nowMs: number) {
  const cached = await deps.store.getClasses();
  if (cached && nowMs - cached.fetchedAt < CLASSES_TTL_MS) return cached.classes;
  try {
    const classes = await server.fetchClasses();
    await deps.store.setClasses({ classes, fetchedAt: nowMs });
    return classes;
  } catch (error) {
    if (error instanceof UpgradeRequiredError || !cached) throw error;
    deps.log?.(
      `using cached class globs: ${error instanceof Error ? error.message : String(error)}`,
    );
    return cached.classes;
  }
}
