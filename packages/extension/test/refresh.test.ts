import { describe, expect, it, vi } from 'vitest';

import { GitHubAuthError, GitHubError, GitHubRateLimitError } from '../src/lib/github/client.ts';
import { isRefreshDue, refresh, refreshIfDue, type RefreshDeps } from '../src/lib/refresh.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';
import { EMPTY_CACHE, STORAGE_VERSION, Store } from '../src/lib/storage.ts';
import { NOW, fakeGitHub, pr, review } from './helpers/github.ts';
import { memoryStorage } from './helpers/memory-storage.ts';

async function setup(
  options: {
    token?: string;
    github?: ReturnType<typeof fakeGitHub>;
  } = {},
) {
  const area = memoryStorage();
  const store = new Store(area);
  await store.setSettings({
    ...DEFAULT_SETTINGS,
    token: options.token ?? 'tok',
  });
  let clock = NOW;
  const github = options.github ?? fakeGitHub({ prs: [pr({ myReviews: [review({ id: 'r1' })] })] });
  const deps: RefreshDeps = {
    store,
    now: () => clock,
    github: vi.fn(() => github),
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
  };
  return { area, store, deps, github, advance: (ms: number) => (clock += ms) };
}

describe('isRefreshDue', () => {
  it('is due on an empty cache, not within 5 minutes, and not while a refresh runs', () => {
    expect(isRefreshDue(EMPTY_CACHE, NOW)).toBe(true);
    expect(isRefreshDue({ ...EMPTY_CACHE, attemptedAt: NOW - 4 * 60_000 }, NOW)).toBe(false);
    expect(isRefreshDue({ ...EMPTY_CACHE, attemptedAt: NOW - 5 * 60_000 }, NOW)).toBe(true);
    expect(isRefreshDue({ ...EMPTY_CACHE, refreshStartedAt: NOW - 60_000 }, NOW)).toBe(false);
    expect(isRefreshDue({ ...EMPTY_CACHE, refreshStartedAt: NOW - 4 * 60_000 }, NOW)).toBe(false);
    // A refresh started long ago died with its worker; another may start.
    expect(isRefreshDue({ ...EMPTY_CACHE, refreshStartedAt: NOW - 6 * 60_000 }, NOW)).toBe(true);
  });

  it('ignores times left in the future by a clock jump', () => {
    const later = NOW + 24 * 3_600_000;
    expect(isRefreshDue({ ...EMPTY_CACHE, attemptedAt: later, refreshStartedAt: later }, NOW)).toBe(
      true,
    );
    expect(isRefreshDue({ ...EMPTY_CACHE, notBefore: later }, NOW)).toBe(true);
  });

  it('waits for a GitHub rate limit to reset', () => {
    expect(isRefreshDue({ ...EMPTY_CACHE, notBefore: NOW + 1 }, NOW)).toBe(false);
    expect(isRefreshDue({ ...EMPTY_CACHE, notBefore: NOW }, NOW)).toBe(true);
  });
});

describe('refresh', () => {
  it('scores the window locally and caches the result', async () => {
    const { area, deps } = await setup();
    const cache = await refresh(deps);
    expect(cache).toMatchObject({
      status: 'ok',
      score: { up: 400, down: 0, ratio: null },
      scoredAt: NOW,
      error: null,
      refreshStartedAt: null,
    });
    expect(area.data['storageVersion']).toBe(STORAGE_VERSION);
  });

  it('balances a review and an own PR of the same size at ratio 1', async () => {
    const github = fakeGitHub({
      prs: [
        pr({ number: 1, myReviews: [review()] }),
        pr({ number: 2, author: { login: 'me', type: 'User' }, createdAt: '2026-10-15T11:00:00Z' }),
      ],
    });
    const { deps } = await setup({ github });
    expect((await refresh(deps)).score).toEqual({ up: 400, down: 400, ratio: 1 });
  });

  it('counts refreshes that never finish, and resets the count when one does', async () => {
    const { deps, store } = await setup();
    // Two refreshes that died with their worker.
    await store.updateBadge({ unfinishedRefreshes: 2 });
    const cache = await refresh(deps);
    expect(cache).toMatchObject({ status: 'ok', unfinishedRefreshes: 0 });
  });

  it('stops when classifying the files takes too long', async () => {
    const { deps } = await setup();
    const realNow = performance.now.bind(performance);
    let shift = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + (shift += 50));
    try {
      const cache = await refresh(deps);
      expect(cache).toMatchObject({
        status: 'stale',
        error: 'classifying files took too long',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('does nothing but flag the badge without a token', async () => {
    const { deps, github, store } = await setup({ token: '' });
    const viewer = vi.spyOn(github, 'viewer');
    const log = vi.fn();
    await store.migrate();
    await store.updateBadge({ status: 'ok', unfinishedRefreshes: 1 });
    expect(await refresh({ ...deps, log })).toMatchObject({
      status: 'no_token',
      unfinishedRefreshes: 0,
    });
    expect(viewer).not.toHaveBeenCalled();
    // Logged when the token goes away, not again on every page load.
    await refresh({ ...deps, log });
    expect(log.mock.calls).toEqual([['refresh skipped: no GitHub token']]);
  });

  it('logs why a refresh started and how it ended', async () => {
    const { deps } = await setup();
    const log = vi.fn();
    await refresh({ ...deps, log }, 'asked by the options page');
    await refresh({ ...deps, log });
    expect(log.mock.calls.map(([line]) => line as string)).toEqual([
      'refresh started (asked by the options page)',
      expect.stringMatching(/^refreshed: 1 review, 0 own PRs, 0 of 1 PR skipped → \{"up":400/),
      'refresh started',
      expect.stringMatching(/^refreshed: /),
    ]);
  });

  it('keeps the last score and marks it stale when a refresh fails', async () => {
    const github = fakeGitHub({ prs: [pr({ myReviews: [review({ id: 'r1' })] })] });
    const { deps, store, advance } = await setup({ github });
    await refresh(deps);
    advance(11 * 60_000);
    github.viewer = () => Promise.reject(new Error('Failed to fetch'));
    const cache = await refresh(deps);
    expect(cache).toMatchObject({
      status: 'stale',
      score: { up: 400 },
      scoredAt: NOW,
      error: 'Failed to fetch',
    });
    expect((await store.getBadge()).attemptedAt).toBe(NOW + 11 * 60_000);
  });

  it('flags a rejected token', async () => {
    const github = fakeGitHub({ prs: [] });
    github.viewer = () => Promise.reject(new GitHubAuthError(401));
    const { deps } = await setup({ github });
    expect((await refresh(deps)).status).toBe('bad_token');
  });

  it('flags GitHub errors apart from other failures, and backs off until a rate limit resets', async () => {
    const down = fakeGitHub({ prs: [] });
    down.viewer = () => Promise.reject(new GitHubError('GitHub answered 502', 502));
    const first = await setup({ github: down });
    expect(await refresh(first.deps)).toMatchObject({ status: 'github_error', notBefore: null });

    const limited = fakeGitHub({ prs: [] });
    limited.viewer = () => Promise.reject(new GitHubRateLimitError(NOW + 30 * 60_000));
    const second = await setup({ github: limited });
    expect(await refresh(second.deps)).toMatchObject({
      status: 'github_error',
      notBefore: NOW + 30 * 60_000,
    });
    second.advance(20 * 60_000);
    expect((await refreshIfDue(second.deps)).refreshed).toBe(false);
  });

  it('reports PRs it had to skip without failing', async () => {
    const github = fakeGitHub({
      prs: [1, 2, 3].map((n) => pr({ number: n, myReviews: [review()] })),
    });
    const base = github.pullRequest;
    github.pullRequest = (o, r, n, me) =>
      n === 2 ? Promise.reject(new GitHubError('not found', 404)) : base(o, r, n, me);
    const { deps } = await setup({ github });
    expect(await refresh(deps)).toMatchObject({
      status: 'ok',
      error: '1 pull request(s) could not be read',
    });
  });

  it('stores PR keys, Viewed snapshots and the compare cache', async () => {
    const github = fakeGitHub({
      prs: [
        pr({
          number: 1,
          files: [{ path: 'src/app.ts', additions: 10, deletions: 0, viewerViewedState: 'VIEWED' }],
          myReviews: [
            review({ id: 'r0', commitOid: 'c0', submittedAt: '2026-10-15T08:00:00Z' }),
            review({ id: 'r1' }),
          ],
        }),
        pr({ number: 2, author: { login: 'me', type: 'User' } }),
      ],
    });
    const { deps, store } = await setup({ github });
    await refresh(deps);
    expect(await store.getPrKeys()).toEqual({
      'dilitrust/app#2': '00000000-0000-4000-8000-000000000001',
    });
    expect(Object.keys(await store.getViewedSnapshots())).toEqual(['r1']);
    expect(Object.keys(await store.getCompareCache()).sort()).toEqual([
      'dilitrust/app:c0...head',
      'dilitrust/app:fork...c0',
    ]);
  });
});

describe('refreshIfDue', () => {
  it('refreshes at most once every 5 minutes', async () => {
    const { deps, store, advance } = await setup();
    expect((await refreshIfDue(deps)).refreshed).toBe(true);
    advance(4 * 60_000);
    expect((await refreshIfDue(deps)).refreshed).toBe(false);
    advance(60_000);
    expect((await refreshIfDue(deps)).refreshed).toBe(true);
    expect((await store.getBadge()).scoredAt).toBe(NOW + 5 * 60_000);
  });

  it('passes the reason on to the log', async () => {
    const { deps } = await setup();
    const log = vi.fn();
    await refreshIfDue({ ...deps, log }, 'a github.com tab asked for the badge');
    expect(log).toHaveBeenCalledWith('refresh started (a github.com tab asked for the badge)');
  });
});
