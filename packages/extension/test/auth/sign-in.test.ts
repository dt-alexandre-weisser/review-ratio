import { describe, expect, it, vi } from 'vitest';

import { DeviceFlowError } from '../../src/lib/auth/device-flow.ts';
import { createAuth, type Auth } from '../../src/lib/auth/index.ts';
import { createSignIn, type FlowView, type SignInDeps } from '../../src/lib/auth/sign-in.ts';
import { DEFAULT_SETTINGS } from '../../src/lib/settings.ts';
import { Store } from '../../src/lib/storage.ts';
import { fakeFetch, json } from '../helpers/fetch.ts';
import { memoryStorage } from '../helpers/memory-storage.ts';

const NOW = Date.parse('2026-10-15T12:00:00Z');

const CODE_ANSWER = {
  device_code: 'dev_secret',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};

const GRANTED = {
  access_token: 'ghu_new',
  expires_in: 28_800,
  refresh_token: 'ghr_new',
  refresh_token_expires_in: 15_897_600,
};

type Route = (url: URL) => Response | Promise<Response>;

/** github.com/login and the user lookup, as GitHub answers once the code is entered. */
function github(overrides: { code?: Route; token?: Route; user?: Route } = {}) {
  let polls = 0;
  return fakeFetch((url) => {
    if (url.pathname === '/login/device/code')
      return (overrides.code ?? (() => json(CODE_ANSWER)))(url);
    if (url.pathname === '/login/oauth/access_token') {
      if (overrides.token) return overrides.token(url);
      polls += 1;
      return json(polls === 1 ? { error: 'authorization_pending' } : GRANTED);
    }
    if (url.host === 'api.github.com' && url.pathname === '/user') {
      return (overrides.user ?? (() => json({ login: 'me' })))(url);
    }
    return json({}, { status: 404 });
  });
}

/** A sleep that only ends when the flow is cancelled. */
function forever(_ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new DeviceFlowError('cancelled'));
    });
  });
}

async function setup(
  options: {
    fetchImpl?: ReturnType<typeof github>;
    clientId?: string;
    slug?: string;
    sleep?: SignInDeps['sleep'];
    auth?: (auth: Auth) => Auth;
    keepAlive?: false;
  } = {},
) {
  const store = new Store(memoryStorage());
  await store.setSettings({ ...DEFAULT_SETTINGS, token: 'github_pat_old' });
  let clock = NOW;
  const fetchImpl = options.fetchImpl ?? github();
  const now = () => clock;
  const log = vi.fn();
  const real = createAuth({ store, fetchImpl, now, clientId: 'Iv1.x', log });
  const auth = options.auth ? options.auth(real) : real;
  const views: FlowView[] = [];
  const stopKeepAlive = vi.fn();
  const keepAlive = vi.fn(() => stopKeepAlive);
  const signIn = createSignIn({
    auth,
    store,
    fetchImpl,
    now,
    clientId: options.clientId ?? 'Iv1.x',
    slug: options.slug ?? 'review-ratio',
    publish: (view) => {
      views.push(view);
      return Promise.resolve();
    },
    sleep:
      options.sleep ??
      ((ms) => {
        clock += ms;
        return Promise.resolve();
      }),
    ...(options.keepAlive === false ? {} : { keepAlive }),
    log,
  });
  return { signIn, store, fetchImpl, views, log, keepAlive, stopKeepAlive };
}

describe('createSignIn', () => {
  it('reports the token mode and no sign-in on a fresh install', async () => {
    const { signIn } = await setup();
    expect(await signIn.status()).toEqual({
      appConfigured: true,
      installUrl: 'https://github.com/apps/review-ratio/installations/new',
      mode: 'pat',
      signedIn: null,
      flow: { state: 'idle' },
    });
  });

  it('shows the code, polls in the background, then switches to the app', async () => {
    const { signIn, store, views, log, keepAlive, stopKeepAlive, fetchImpl } = await setup();
    const started = await signIn.start();
    expect(started.flow).toEqual({
      state: 'waiting',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      expiresAt: NOW + 900_000,
    });
    await signIn.settled();
    expect(views.map((v) => v.state)).toEqual(['waiting', 'signed_in']);
    expect(views[1]).toEqual({ state: 'signed_in', login: 'me' });
    expect(await signIn.status()).toMatchObject({
      mode: 'app',
      signedIn: { login: 'me', accessTokenExpiresAt: NOW + 10_000 + 28_800_000 },
      flow: { state: 'signed_in', login: 'me' },
    });
    expect((await store.getSettings()).token).toBe('');
    expect(keepAlive).toHaveBeenCalledTimes(1);
    expect(stopKeepAlive).toHaveBeenCalledTimes(1);
    const user = fetchImpl.calls.find((c) => c.url === 'https://api.github.com/user')!;
    expect((user.init.headers as Record<string, string>)['authorization']).toBe('Bearer ghu_new');
    // The device code and the tokens stay out of what the page sees and of the log.
    expect(JSON.stringify([views, log.mock.calls])).not.toMatch(/dev_secret|ghu_|ghr_/);
    expect(log.mock.calls.map(([m]) => m as string)).toEqual([
      'GitHub sign-in started: waiting for the code to be entered on GitHub',
      'signed in to GitHub as me with the GitHub App',
    ]);
  });

  it('signs in without a way to keep the worker awake', async () => {
    const { signIn, views } = await setup({ keepAlive: false });
    await signIn.start();
    await signIn.settled();
    expect(views.at(-1)).toEqual({ state: 'signed_in', login: 'me' });
  });

  it('signs in without a login when GitHub does not say who it is', async () => {
    for (const user of [
      () => json({}, { status: 403 }),
      () => json({ login: 3 }),
      () => Promise.reject(new TypeError('Failed to fetch')),
    ]) {
      const { signIn, views } = await setup({ fetchImpl: github({ user }) });
      await signIn.start();
      await signIn.settled();
      expect(views.at(-1)).toEqual({ state: 'signed_in', login: null });
    }
  });

  it('refuses to sign in with a placeholder app, without calling GitHub', async () => {
    const { signIn, fetchImpl, views } = await setup({ clientId: 'REPLACE_WITH_CLIENT_ID' });
    const status = await signIn.start();
    expect(status.appConfigured).toBe(false);
    expect(status.flow).toEqual({
      state: 'failed',
      message: 'This build has no GitHub App to sign in with. Paste a token instead.',
    });
    expect(views).toHaveLength(1);
    expect(fetchImpl.calls).toHaveLength(0);
    const noSlug = await setup({ slug: 'REPLACE_WITH_APP_SLUG' });
    expect((await noSlug.signIn.start()).flow.state).toBe('failed');
  });

  it('shows why GitHub gave no code', async () => {
    const fetchImpl = github({ code: () => json({ error: 'device_flow_disabled' }) });
    const { signIn, log } = await setup({ fetchImpl });
    const status = await signIn.start();
    expect(status.flow).toEqual({
      state: 'failed',
      message: new DeviceFlowError('disabled').message,
    });
    expect(log).toHaveBeenCalledWith(
      `GitHub sign-in failed: ${new DeviceFlowError('disabled').message}`,
    );
    await signIn.settled();
  });

  it('shows why the sign-in ended, and keeps the token mode', async () => {
    const fetchImpl = github({ token: () => json({ error: 'access_denied' }) });
    const { signIn, store, views } = await setup({ fetchImpl });
    await signIn.start();
    await signIn.settled();
    expect(views.at(-1)).toEqual({
      state: 'failed',
      message: 'Sign-in was refused on GitHub. Sign in again to retry.',
    });
    expect(await store.getSettings()).toMatchObject({ authMode: 'pat', token: 'github_pat_old' });
    expect(await store.getAppAuth()).toBeNull();
  });

  it('reports an unexpected failure after GitHub granted the tokens', async () => {
    const { signIn, views } = await setup({
      auth: (auth) => ({ ...auth, completeSignIn: () => Promise.reject(new Error('quota')) }),
    });
    await signIn.start();
    await signIn.settled();
    expect(views.at(-1)).toEqual({ state: 'failed', message: 'Sign-in failed: quota' });
  });

  it('cancels a sign-in that waits for the code, quietly', async () => {
    const { signIn, store, views, log, stopKeepAlive } = await setup({ sleep: forever });
    await signIn.start();
    expect((await signIn.cancel()).flow).toEqual({ state: 'idle' });
    await signIn.settled();
    expect(views.map((v) => v.state)).toEqual(['waiting', 'idle']);
    expect(await store.getAppAuth()).toBeNull();
    expect(stopKeepAlive).toHaveBeenCalled();
    expect(log).toHaveBeenLastCalledWith('GitHub sign-in cancelled');
    log.mockClear();
    await signIn.cancel();
    expect(log).not.toHaveBeenCalled();
  });

  it('drops a code that arrives after the cancel', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = github({
      code: async () => {
        await gate;
        return json(CODE_ANSWER);
      },
    });
    const { signIn, views } = await setup({ fetchImpl });
    const starting = signIn.start();
    await vi.waitFor(() => {
      expect(fetchImpl.calls).toHaveLength(1);
    });
    await signIn.cancel();
    release();
    expect((await starting).flow).toEqual({ state: 'idle' });
    expect(views.map((v) => v.state)).toEqual(['idle']);
  });

  it('replaces a sign-in in progress with a new one', async () => {
    const { signIn, views } = await setup({ sleep: forever });
    await signIn.start();
    await signIn.start();
    expect(views.map((v) => v.state)).toEqual(['waiting', 'waiting']);
    await signIn.cancel();
    await signIn.settled();
    expect(views.map((v) => v.state)).toEqual(['waiting', 'waiting', 'idle']);
  });

  it('signs out, stopping any sign-in in progress', async () => {
    const { signIn, store } = await setup();
    await signIn.start();
    await signIn.settled();
    const status = await signIn.signOut();
    expect(status).toMatchObject({ mode: 'app', signedIn: null, flow: { state: 'idle' } });
    expect(await store.getAppAuth()).toBeNull();
  });
});
