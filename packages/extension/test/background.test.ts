import { beforeAll, describe, expect, it, vi } from 'vitest';

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

  it('ignores messages that are not requests', async () => {
    expect(await send({ type: 'hello' }, fromOptions)).toBeUndefined();
  });

  it('opens the options page from the toolbar button', () => {
    chromeMock.runtime.openOptionsPage.mockClear();
    listeners.clicked[0]!();
    expect(chromeMock.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
  });
});
