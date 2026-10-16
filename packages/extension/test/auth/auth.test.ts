import { describe, expect, it, vi } from 'vitest';

import { RENEW_MARGIN_MS, createAuth } from '../../src/lib/auth/index.ts';
import { GitHubError } from '../../src/lib/github/client.ts';
import { DEFAULT_SETTINGS } from '../../src/lib/settings.ts';
import { Store, type AppAuth } from '../../src/lib/storage.ts';
import { fakeFetch, json } from '../helpers/fetch.ts';
import { memoryStorage } from '../helpers/memory-storage.ts';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const HOUR = 3_600_000;

const SIGNED_IN: AppAuth = {
  accessToken: 'ghu_1',
  accessTokenExpiresAt: NOW + 8 * HOUR,
  refreshToken: 'ghr_1',
  refreshTokenExpiresAt: NOW + 4_000 * HOUR,
  login: 'me',
};

function renewal(n: number) {
  return json({
    access_token: `ghu_${n}`,
    expires_in: 28_800,
    refresh_token: `ghr_${n}`,
    refresh_token_expires_in: 15_897_600,
  });
}

async function setup(
  options: {
    mode?: 'app' | 'pat';
    token?: string;
    appAuth?: AppAuth | null;
    answer?: () => Response | Promise<Response>;
  } = {},
) {
  const store = new Store(memoryStorage());
  await store.setSettings({
    ...DEFAULT_SETTINGS,
    authMode: options.mode ?? 'app',
    token: options.token ?? '',
  });
  const appAuth = options.appAuth === undefined ? SIGNED_IN : options.appAuth;
  if (appAuth) await store.setAppAuth(appAuth);
  let clock = NOW;
  let renewals = 1;
  const fetchImpl = fakeFetch(options.answer ?? (() => renewal(++renewals)));
  const log = vi.fn();
  const auth = createAuth({ store, fetchImpl, now: () => clock, clientId: 'Iv1.x', log });
  return { auth, store, fetchImpl, log, advance: (ms: number) => (clock += ms) };
}

describe('createAuth, token mode', () => {
  it('uses the pasted token as is, and never renews it', async () => {
    const { auth, fetchImpl } = await setup({ mode: 'pat', token: 'github_pat_x' });
    expect(await auth.getAccessToken()).toBe('github_pat_x');
    expect(await auth.hasCredential()).toBe(true);
    expect(await auth.renewAfterUnauthorized('github_pat_x')).toBeNull();
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('has no token when none was pasted, even with an app sign-in stored', async () => {
    const { auth } = await setup({ mode: 'pat' });
    expect(await auth.getAccessToken()).toBeNull();
    expect(await auth.hasCredential()).toBe(false);
  });
});

describe('createAuth, app mode', () => {
  it('uses the access token while it has more than 5 minutes left', async () => {
    const { auth, fetchImpl, advance } = await setup();
    expect(await auth.getAccessToken()).toBe('ghu_1');
    advance(8 * HOUR - RENEW_MARGIN_MS - 1);
    expect(await auth.getAccessToken()).toBe('ghu_1');
    expect(await auth.hasCredential()).toBe(true);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('renews shortly before expiry and keeps the rotated refresh token', async () => {
    const { auth, store, fetchImpl, log, advance } = await setup();
    advance(8 * HOUR - RENEW_MARGIN_MS);
    expect(await auth.getAccessToken()).toBe('ghu_2');
    expect(await store.getAppAuth()).toEqual({
      accessToken: 'ghu_2',
      accessTokenExpiresAt: NOW + 16 * HOUR - RENEW_MARGIN_MS,
      refreshToken: 'ghr_2',
      refreshTokenExpiresAt: NOW + 8 * HOUR - RENEW_MARGIN_MS + 15_897_600_000,
      login: 'me',
    });
    expect(Object.fromEntries(fetchImpl.calls[0]!.init.body as URLSearchParams)).toMatchObject({
      refresh_token: 'ghr_1',
    });
    expect(log).toHaveBeenCalledWith('renewed the GitHub sign-in');
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/gh[ur]_/);
  });

  it('renews once for concurrent callers, so the refresh token is used once', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let n = 1;
    const { auth, fetchImpl, advance } = await setup({
      answer: async () => {
        await gate;
        return renewal(++n);
      },
    });
    advance(8 * HOUR);
    const tokens = Promise.all([
      auth.getAccessToken(),
      auth.getAccessToken(),
      auth.renewAfterUnauthorized('ghu_1'),
    ]);
    await vi.waitFor(() => {
      expect(fetchImpl.calls).toHaveLength(1);
    });
    release();
    expect(await tokens).toEqual(['ghu_2', 'ghu_2', 'ghu_2']);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('renews after a 401, unless another caller already did', async () => {
    const { auth, fetchImpl } = await setup();
    expect(await auth.renewAfterUnauthorized('ghu_1')).toBe('ghu_2');
    // A call that started with the old token got its 401 after the renewal.
    expect(await auth.renewAfterUnauthorized('ghu_1')).toBe('ghu_2');
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('signs out when GitHub refuses the refresh token', async () => {
    const { auth, store, log, advance } = await setup({
      answer: () => json({ error: 'bad_refresh_token' }),
    });
    advance(8 * HOUR);
    expect(await auth.getAccessToken()).toBeNull();
    expect(await store.getAppAuth()).toBeNull();
    expect(await auth.hasCredential()).toBe(false);
    expect(log).toHaveBeenCalledWith(
      'signed out of GitHub: GitHub refused to renew it (bad_refresh_token)',
    );
  });

  it('signs out without a call once the refresh token expired', async () => {
    const { auth, store, fetchImpl, log, advance } = await setup();
    advance(4_000 * HOUR);
    expect(await auth.getAccessToken()).toBeNull();
    expect(await store.getAppAuth()).toBeNull();
    expect(fetchImpl.calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('signed out of GitHub: the sign-in expired');
  });

  it('keeps a token that does not expire until GitHub rejects it', async () => {
    const forever = {
      ...SIGNED_IN,
      accessTokenExpiresAt: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
    };
    const { auth, store, fetchImpl, advance } = await setup({ appAuth: forever });
    advance(10_000 * HOUR);
    expect(await auth.getAccessToken()).toBe('ghu_1');
    expect(await auth.renewAfterUnauthorized('ghu_1')).toBeNull();
    expect(await store.getAppAuth()).toBeNull();
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('keeps the current token while GitHub is unreachable, until it actually expires', async () => {
    const { auth, store, advance } = await setup({
      answer: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    advance(8 * HOUR - 60_000);
    expect(await auth.getAccessToken()).toBe('ghu_1');
    await expect(auth.renewAfterUnauthorized('ghu_1')).rejects.toBeInstanceOf(GitHubError);
    advance(60_000);
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(GitHubError);
    // Nothing is lost: the next renewal may work.
    expect(await store.getAppAuth()).toEqual(SIGNED_IN);
  });

  it('has nothing to give when signed out', async () => {
    const { auth, fetchImpl } = await setup({ appAuth: null });
    expect(await auth.getAccessToken()).toBeNull();
    expect(await auth.renewAfterUnauthorized('ghu_1')).toBeNull();
    expect(await auth.hasCredential()).toBe(false);
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe('createAuth, switching modes', () => {
  it('switches to the app on sign-in, dropping the pasted token', async () => {
    const { auth, store, log } = await setup({ mode: 'pat', token: 'github_pat_x', appAuth: null });
    const { login: _login, ...tokens } = SIGNED_IN;
    await auth.completeSignIn(tokens, 'me');
    expect(await store.getSettings()).toMatchObject({ authMode: 'app', token: '' });
    expect(await store.getAppAuth()).toEqual(SIGNED_IN);
    expect(await auth.getAccessToken()).toBe('ghu_1');
    expect(log).toHaveBeenCalledWith('signed in to GitHub as me with the GitHub App');
    await auth.completeSignIn(tokens, null);
    expect(log).toHaveBeenLastCalledWith('signed in to GitHub with the GitHub App');
  });

  it('signs out during a renewal, which then cannot write the tokens back', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { auth, store, fetchImpl, log, advance } = await setup({
      answer: async () => {
        await gate;
        return renewal(2);
      },
    });
    advance(8 * HOUR);
    const renewing = auth.getAccessToken();
    await vi.waitFor(() => {
      expect(fetchImpl.calls).toHaveLength(1);
    });
    await auth.signOut();
    release();
    expect(await renewing).toBeNull();
    expect(await store.getAppAuth()).toBeNull();
    expect(log).toHaveBeenLastCalledWith('signed out of GitHub: signed out on the options page');
    log.mockClear();
    await auth.signOut();
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps a sign-in made during a renewal, and a refusal then signs nothing out', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { auth, store, fetchImpl, advance } = await setup({
      answer: async () => {
        await gate;
        return json({ error: 'bad_refresh_token' });
      },
    });
    advance(8 * HOUR);
    const renewing = auth.renewAfterUnauthorized('ghu_1');
    await vi.waitFor(() => {
      expect(fetchImpl.calls).toHaveLength(1);
    });
    const fresh = { ...SIGNED_IN, accessToken: 'ghu_fresh', accessTokenExpiresAt: NOW + 16 * HOUR };
    const { login: _login, ...tokens } = fresh;
    await auth.completeSignIn(tokens, 'me');
    release();
    expect(await renewing).toBeNull();
    expect(await store.getAppAuth()).toEqual(fresh);
  });

  it('answers the tokens of a sign-in made while GitHub renewed the old ones', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { auth, store, fetchImpl, advance } = await setup({
      answer: async () => {
        await gate;
        return renewal(2);
      },
    });
    advance(8 * HOUR);
    const renewing = auth.getAccessToken();
    await vi.waitFor(() => {
      expect(fetchImpl.calls).toHaveLength(1);
    });
    const { login: _login, ...tokens } = { ...SIGNED_IN, accessToken: 'ghu_fresh' };
    await auth.completeSignIn(tokens, 'me');
    release();
    expect(await renewing).toBe('ghu_fresh');
    expect((await store.getAppAuth())?.accessToken).toBe('ghu_fresh');
  });
});
