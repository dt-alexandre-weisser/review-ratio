/**
 * Background service worker. Owns the refresh: the content script only ever asks for the
 * badge, and the worker decides whether the cache is fresh enough.
 */
import { badgeView } from '../lib/badge-state.ts';
import { createGitHubClient } from '../lib/github/client.ts';
import { isRequest, type BadgeUpdate, type Request, type Response } from '../lib/messages.ts';
import { refresh, refreshIfDue, type RefreshDeps } from '../lib/refresh.ts';
import { createServerClient } from '../lib/server-client.ts';
import { Store, chromeStorageArea } from '../lib/storage.ts';

const store = new Store(chromeStorageArea());

const deps: RefreshDeps = {
  store,
  now: () => Date.now(),
  github: (token) => createGitHubClient({ token }),
  server: (baseUrl) => createServerClient(baseUrl),
  randomUUID: () => crypto.randomUUID(),
  log: (message) => {
    console.info(`[review-ratio] ${message}`);
  },
};

/** One refresh at a time per worker instance. The storage lock covers worker restarts. */
let inFlight: Promise<void> | null = null;

function runExclusive(task: () => Promise<unknown>): Promise<void> {
  inFlight ??= task()
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error('[review-ratio] refresh crashed', error);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function broadcastBadge(): Promise<void> {
  const view = badgeView(await store.getBadge());
  const message: BadgeUpdate = { type: 'badge:update', view };
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: 'https://github.com/*' });
  } catch (error) {
    console.warn('[review-ratio] cannot list tabs', error);
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch {
        // No content script in that tab (e.g. an error page). Nothing to update.
      }
    }),
  );
}

function refreshInBackground(force: boolean): void {
  void runExclusive(async () => {
    const result = force
      ? { refreshed: true, cache: await refresh(deps) }
      : await refreshIfDue(deps);
    if (result.refreshed) await broadcastBadge();
  });
}

async function handle(request: Request): Promise<Response> {
  switch (request.type) {
    case 'badge:get': {
      const cache = await store.getBadge();
      refreshInBackground(false);
      return { type: 'badge:view', view: badgeView(cache) };
    }
    case 'badge:refresh': {
      await runExclusive(async () => {
        await refresh(deps);
        await broadcastBadge();
      });
      return { type: 'badge:view', view: badgeView(await store.getBadge()) };
    }
    case 'cache:get':
      return { type: 'cache', cache: await store.getBadge() };
  }
}

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response: Response) => void) => {
    if (!isRequest(message)) return false;
    handle(message)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  },
);

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    void store.getSettings().then((settings) => {
      if (!settings.token) void chrome.runtime.openOptionsPage();
    });
  }
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
