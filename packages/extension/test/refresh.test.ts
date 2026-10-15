import { describe, expect, it, vi } from 'vitest';

import { GitHubAuthError } from '../src/lib/github/client.ts';
import { isRefreshDue, refresh, refreshIfDue, type RefreshDeps } from '../src/lib/refresh.ts';
import { ServerError, UpgradeRequiredError, type ServerClient } from '../src/lib/server-client.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';
import { EMPTY_CACHE, Store } from '../src/lib/storage.ts';
import { NOW, fakeGitHub, pr, review } from './helpers/github.ts';
import { memoryStorage } from './helpers/memory-storage.ts';

function server(overrides: Partial<ServerClient> = {}): ServerClient & { scored: unknown[] } {
  const scored: unknown[] = [];
  return {
    scored,
    fetchClasses: vi.fn(() =>
      Promise.resolve([{ name: 'test' as const, globs: ['**/*.test.ts'] }]),
    ),
    score: vi.fn((payload) => {
      scored.push(payload);
      return Promise.resolve({ up: 400, down: 0, ratio: null });
    }),
    ...overrides,
  };
}

async function setup(
  options: {
    token?: string;
    server?: ReturnType<typeof server>;
    github?: ReturnType<typeof fakeGitHub>;
  } = {},
) {
  const area = memoryStorage();
  const store = new Store(area);
  await store.setSettings({ ...DEFAULT_SETTINGS, token: options.token ?? 'tok' });
  let clock = NOW;
  const srv = options.server ?? server();
  const github = options.github ?? fakeGitHub({ prs: [pr({ reviews: [review({ id: 'r1' })] })] });
  const deps: RefreshDeps = {
    store,
    now: () => clock,
    github: vi.fn(() => github),
    server: vi.fn(() => srv),
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
  };
  return { area, store, deps, srv, github, advance: (ms: number) => (clock += ms) };
}

describe('isRefreshDue', () => {
  it('is due on an empty cache, not within 10 minutes, and not while a refresh runs', () => {
    expect(isRefreshDue(EMPTY_CACHE, NOW)).toBe(true);
    expect(isRefreshDue({ ...EMPTY_CACHE, attemptedAt: NOW - 9 * 60_000 }, NOW)).toBe(false);
    expect(isRefreshDue({ ...EMPTY_CACHE, attemptedAt: NOW - 10 * 60_000 }, NOW)).toBe(true);
    expect(isRefreshDue({ ...EMPTY_CACHE, refreshStartedAt: NOW - 60_000 }, NOW)).toBe(false);
    // A refresh started long ago died with its worker; another may start.
    expect(isRefreshDue({ ...EMPTY_CACHE, refreshStartedAt: NOW - 4 * 60_000 }, NOW)).toBe(true);
  });
});

describe('refresh', () => {
  it('scores the window and caches the result', async () => {
    const { store, deps, srv } = await setup();
    const cache = await refresh(deps);
    expect(cache).toMatchObject({
      status: 'ok',
      score: { up: 400, down: 0, ratio: null },
      scoredAt: NOW,
      error: null,
      refreshStartedAt: null,
    });
    expect(srv.scored).toHaveLength(1);
    expect(srv.scored[0]).toMatchObject({
      contractVersion: 1,
      up: [{ action: 'approve' }],
      down: [],
    });
    expect((await store.getClasses())?.fetchedAt).toBe(NOW);
  });

  it('does nothing but flag the badge without a token', async () => {
    const { deps, srv } = await setup({ token: '' });
    expect((await refresh(deps)).status).toBe('no_token');
    expect(srv.scored).toHaveLength(0);
  });

  it('keeps the last score and marks it stale when the server is down', async () => {
    const srv = server();
    const { deps, store, advance } = await setup({ server: srv });
    await refresh(deps);
    advance(11 * 60_000);
    srv.score = () => Promise.reject(new ServerError('server unreachable (Failed to fetch)', null));
    const cache = await refresh(deps);
    expect(cache).toMatchObject({
      status: 'stale',
      score: { up: 400 },
      scoredAt: NOW,
      error: expect.stringContaining('unreachable'),
    });
    expect((await store.getBadge()).attemptedAt).toBe(NOW + 11 * 60_000);
  });

  it('flags 426 as upgrade required', async () => {
    const { deps } = await setup({
      server: server({ fetchClasses: () => Promise.reject(new UpgradeRequiredError()) }),
    });
    expect((await refresh(deps)).status).toBe('upgrade_required');
  });

  it('flags a rejected token', async () => {
    const github = fakeGitHub({ prs: [] });
    github.viewer = () => Promise.reject(new GitHubAuthError(401));
    const { deps } = await setup({ github });
    expect((await refresh(deps)).status).toBe('bad_token');
  });

  it('reuses cached class globs within a day, and when the server cannot serve new ones', async () => {
    const srv = server();
    const { deps, advance } = await setup({ server: srv });
    await refresh(deps);
    advance(60 * 60_000);
    await refresh(deps);
    expect(srv.fetchClasses).toHaveBeenCalledTimes(1);
    advance(24 * 60 * 60_000);
    srv.fetchClasses = vi.fn(() => Promise.reject(new ServerError('down', 503)));
    expect((await refresh(deps)).status).toBe('ok');
  });

  it('fails stale when there are no class globs at all', async () => {
    const { deps } = await setup({
      server: server({ fetchClasses: () => Promise.reject(new ServerError('down', 503)) }),
    });
    expect((await refresh(deps)).status).toBe('stale');
  });

  it('stores PR keys and Viewed snapshots', async () => {
    const github = fakeGitHub({
      prs: [
        pr({
          number: 1,
          files: [{ path: 'a.ts', additions: 10, deletions: 0, viewerViewedState: 'VIEWED' }],
          reviews: [review({ id: 'r1' })],
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
  });
});

describe('refreshIfDue', () => {
  it('refreshes at most once every 10 minutes', async () => {
    const { deps, srv, advance } = await setup();
    expect((await refreshIfDue(deps)).refreshed).toBe(true);
    advance(5 * 60_000);
    expect((await refreshIfDue(deps)).refreshed).toBe(false);
    advance(5 * 60_000);
    expect((await refreshIfDue(deps)).refreshed).toBe(true);
    expect(srv.scored).toHaveLength(2);
  });
});
