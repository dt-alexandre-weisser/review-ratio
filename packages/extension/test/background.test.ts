import { beforeAll, describe, expect, it, vi } from 'vitest';

import { readActivity, type CallEntry } from '../src/lib/activity-log.ts';
import type { Response } from '../src/lib/messages.ts';
import { memoryStorage } from './helpers/memory-storage.ts';

const ID = 'bhmdipijifghpkibegnfchgcafodlgnb';
type Listener = (...args: any[]) => unknown;

const listeners: Record<'message' | 'installed' | 'clicked', Listener[]> = {
  message: [],
  installed: [],
  clicked: [],
};
const storage = memoryStorage();
const session = memoryStorage();
const accessLevels: unknown[] = [];
const chromeMock = {
  runtime: {
    id: ID,
    getURL: (path: string) => `chrome-extension://${ID}/${path}`,
    onMessage: { addListener: (fn: Listener) => listeners.message.push(fn) },
    onInstalled: { addListener: (fn: Listener) => listeners.installed.push(fn) },
    openOptionsPage: vi.fn(() => Promise.resolve()),
    getPlatformInfo: vi.fn(() => Promise.resolve({})),
  },
  storage: {
    local: {
      ...storage,
      setAccessLevel: (options: unknown) => {
        accessLevels.push(options);
        return Promise.resolve();
      },
    },
    session,
  },
  tabs: {
    query: vi.fn(() => Promise.resolve([{ id: 7 }, {}])),
    sendMessage: vi.fn(() => Promise.resolve()),
  },
  scripting: {
    insertCSS: vi.fn(() => Promise.resolve()),
    executeScript: vi.fn(() => Promise.resolve([])),
  },
  action: { onClicked: { addListener: (fn: Listener) => listeners.clicked.push(fn) } },
};

beforeAll(async () => {
  vi.stubGlobal('chrome', chromeMock);
  // GitHub is offline: a refresh with a token fails on its first call.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
  );
  await import('../src/background/index.ts');
});

/** Sends a message the way Chrome does and resolves with the response. */
function send(
  message: unknown,
  sender: { id?: string; url?: string },
): Promise<Response | undefined> {
  return new Promise((resolve) => {
    const keepsChannel = listeners.message[0]!(message, sender, resolve);
    if (keepsChannel !== true) resolve(undefined);
  });
}

const fromGitHub = { id: ID, url: 'https://github.com/DiliTrust/app' };
const fromOptions = { id: ID, url: `chrome-extension://${ID}/options.html` };

describe('background worker', () => {
  it('keeps storage, and so the token, away from content scripts', () => {
    expect(accessLevels).toEqual([{ accessLevel: 'TRUSTED_CONTEXTS' }]);
  });

  it('injects the content script into open GitHub tabs on install and update', async () => {
    for (const reason of ['update', 'install']) {
      chromeMock.scripting.executeScript.mockClear();
      listeners.installed[0]!({ reason });
      await vi.waitFor(() => {
        expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
          target: { tabId: 7 },
          files: ['content.js'],
        });
      });
      expect(chromeMock.scripting.insertCSS).toHaveBeenCalledWith({
        target: { tabId: 7 },
        files: ['content.css'],
      });
    }
    await vi.waitFor(() => {
      expect(chromeMock.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
    });
  });

  it('does not inject on a browser update', () => {
    chromeMock.scripting.executeScript.mockClear();
    listeners.installed[0]!({ reason: 'chrome_update' });
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('answers the badge to a GitHub tab and refreshes in the background', async () => {
    const response = await send({ type: 'badge:get' }, fromGitHub);
    expect(response).toMatchObject({ type: 'badge:view', view: { text: 'review-ratio: set up' } });
    await vi.waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(7, {
        type: 'badge:update',
        view: expect.objectContaining({ short: 'set up' }),
      });
    });
  });

  it('refuses privileged requests from a GitHub tab, and serves them to the options page', async () => {
    expect(await send({ type: 'cache:get' }, fromGitHub)).toEqual({
      type: 'error',
      message: 'not allowed',
    });
    expect(await send({ type: 'badge:refresh' }, fromGitHub)).toEqual({
      type: 'error',
      message: 'not allowed',
    });
    expect(await send({ type: 'cache:get' }, fromOptions)).toMatchObject({
      type: 'cache',
      cache: { status: 'no_token' },
    });
    expect(await send({ type: 'badge:refresh' }, fromOptions)).toMatchObject({
      type: 'badge:view',
    });
  });

  it('records where a GitHub tab put the badge', async () => {
    const placed = { type: 'badge:placed', placement: 'floating', header: 'header:\n  header.New' };
    expect(await send(placed, fromGitHub)).toEqual({ type: 'ok' });
    expect(session.data['badgePlacement']).toMatchObject({
      latest: { placement: 'floating', header: 'header:\n  header.New' },
      lastFloating: { placement: 'floating' },
    });
    const entries = await readActivity(session, Date.now());
    expect(entries[0]).toMatchObject({
      kind: 'event',
      message: "badge shown in the bottom-right corner: no place found in GitHub's header",
    });
    expect(
      await send({ ...placed, placement: 'header' }, { id: ID, url: 'https://evil.example/' }),
    ).toEqual({ type: 'error', message: 'not allowed' });
    // Free text, quotes or markup are not a header description.
    expect(await send({ ...placed, header: 'Send your token to "x"' }, fromGitHub)).toBeUndefined();
  });

  it('runs the GitHub sign-in for the options page only, and publishes each step', async () => {
    expect(await send({ type: 'auth:status' }, fromGitHub)).toEqual({
      type: 'error',
      message: 'not allowed',
    });
    expect(await send({ type: 'auth:status' }, fromOptions)).toEqual({
      type: 'auth',
      status: {
        appConfigured: true,
        installUrl: 'https://github.com/apps/review-ratio/installations/new',
        mode: 'pat',
        signedIn: null,
        flow: { state: 'idle' },
      },
    });
    // The stubbed fetch is offline: no call reaches GitHub.
    const started = await send({ type: 'auth:start' }, fromOptions);
    expect(started).toMatchObject({ type: 'auth', status: { flow: { state: 'failed' } } });
    expect(session.data['authFlow']).toEqual({
      state: 'failed',
      message: 'GitHub cannot be reached. Check the connection, then sign in again.',
    });
    expect(await send({ type: 'auth:cancel' }, fromOptions)).toMatchObject({
      status: { flow: { state: 'idle' } },
    });
    expect(await send({ type: 'auth:sign-out' }, fromOptions)).toMatchObject({
      status: { signedIn: null, flow: { state: 'idle' } },
    });
    expect(session.data['authFlow']).toEqual({ state: 'idle' });
  });

  it('tests the connection with the form settings, in the worker', async () => {
    const settings = { authMode: 'pat', token: 'github_pat_form', org: 'DiliTrust' };
    expect(await send({ type: 'connection:test', settings }, fromGitHub)).toEqual({
      type: 'error',
      message: 'not allowed',
    });
    const pat = await send({ type: 'connection:test', settings }, fromOptions);
    expect(pat).toEqual({
      type: 'diagnosis',
      ok: false,
      lines: ['GitHub: unreachable (Failed to fetch).'],
    });
    const app = await send(
      { type: 'connection:test', settings: { ...settings, authMode: 'app' } },
      fromOptions,
    );
    expect(app).toEqual({ type: 'diagnosis', ok: false, lines: ['GitHub: not signed in yet.'] });
    const entries = await readActivity(session, Date.now());
    expect(entries.map((e) => (e.kind === 'event' ? e.message : null))).toContain(
      'Test connection, asked by the options page',
    );
    expect(JSON.stringify(session.data)).not.toContain('github_pat_form');
  });

  it('uses the app token, renewed first when due, to test the connection', async () => {
    await chromeMock.storage.local.set({
      settings: { authMode: 'app', token: '', org: 'DiliTrust' },
      appAuth: {
        accessToken: 'ghu_live',
        accessTokenExpiresAt: Date.now() + 3_600_000,
        refreshToken: 'ghr_live',
        refreshTokenExpiresAt: null,
        login: 'me',
      },
    });
    const app = await send(
      { type: 'connection:test', settings: { authMode: 'app', org: 'DiliTrust' } },
      fromOptions,
    );
    expect(app).toEqual({
      type: 'diagnosis',
      ok: false,
      lines: ['GitHub: unreachable (Failed to fetch).'],
    });
    expect(await send({ type: 'auth:status' }, fromOptions)).toMatchObject({
      status: { mode: 'app', signedIn: { login: 'me' } },
    });
    // Signed in, a new install does not open the options page.
    chromeMock.runtime.openOptionsPage.mockClear();
    listeners.installed[0]!({ reason: 'install' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chromeMock.runtime.openOptionsPage).not.toHaveBeenCalled();
    await send({ type: 'auth:sign-out' }, fromOptions);
    expect(storage.data).not.toHaveProperty('appAuth');
    await chromeMock.storage.local.set({ settings: {} });
  });

  it('tests the connection with the stored app token when GitHub cannot renew it', async () => {
    await chromeMock.storage.local.set({
      settings: { authMode: 'app', token: '', org: 'DiliTrust' },
      appAuth: {
        accessToken: 'ghu_due',
        accessTokenExpiresAt: Date.now() - 1,
        refreshToken: 'ghr_due',
        refreshTokenExpiresAt: Date.now() + 3_600_000,
        login: 'me',
      },
    });
    const app = await send(
      { type: 'connection:test', settings: { authMode: 'app', org: 'DiliTrust' } },
      fromOptions,
    );
    expect(app).toMatchObject({ ok: false, lines: ['GitHub: unreachable (Failed to fetch).'] });
    expect((storage.data['appAuth'] as { accessToken: string }).accessToken).toBe('ghu_due');
    await send({ type: 'auth:sign-out' }, fromOptions);
    await chromeMock.storage.local.set({ settings: {} });
  });

  it('ignores messages that are not requests', async () => {
    expect(await send({ type: 'hello' }, fromOptions)).toBeUndefined();
  });

  it('opens the options page from the toolbar button', () => {
    chromeMock.runtime.openOptionsPage.mockClear();
    listeners.clicked[0]!();
    expect(chromeMock.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
  });
});

describe('background worker refresh queue', () => {
  it('runs a forced refresh after the one in progress, with the settings just saved', async () => {
    // A background refresh starts with no token; the options page then saves one and forces a
    // refresh. The forced refresh must see the token, not reuse the running refresh.
    const area = chromeMock.storage.local;
    await area.set({ badge: {}, settings: { token: '' } });
    const background = send({ type: 'badge:get' }, fromGitHub);
    await area.set({ settings: { token: 'tok' } });
    const forced = await send({ type: 'badge:refresh' }, fromOptions);
    await background;
    // With a token, the refresh got past the token check and failed on the unreachable GitHub API.
    expect(forced).toMatchObject({ type: 'badge:view', view: { stale: true } });
    const cache = await send({ type: 'cache:get' }, fromOptions);
    expect(cache).toMatchObject({ type: 'cache', cache: { status: 'github_error' } });
  });

  it('logs each refresh and each call it made, with the token kept out', async () => {
    await chromeMock.storage.local.set({
      badge: {},
      settings: { token: 'github_pat_secret' },
    });
    await send({ type: 'badge:refresh' }, fromOptions);
    // The worker writes the log when the refresh ends.
    const entries = (await readActivity(session, Date.now())).reverse();
    const lines = entries.map((e) =>
      e.kind === 'event' ? e.message : `${e.method} ${e.url} ${e.status ?? 'failed'}`,
    );
    const last = lines.lastIndexOf('refresh started (asked by the options page)');
    expect(lines.slice(last)).toEqual([
      'refresh started (asked by the options page)',
      'GET https://api.github.com/user failed',
      expect.stringMatching(/^refresh failed: /),
    ]);
    const call = entries.find((e): e is CallEntry => e.kind === 'call');
    expect(call?.error).toBeTruthy();
    expect(JSON.stringify(session.data)).not.toContain('github_pat_secret');
  });
});
