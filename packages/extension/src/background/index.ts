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
import { isTrustedFor } from './senders.ts';

/** Extension API calls reset the service worker's 30 s idle timer; fetches alone do not. */
const KEEP_ALIVE_MS = 20_000;
const GITHUB_TABS = 'https://github.com/*';

const store = new Store(chromeStorageArea());

// The GitHub token lives in storage.local. Content scripts never need it: keep it out of reach
// of a compromised github.com renderer.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch((error: unknown) => {
  console.warn('[review-ratio] cannot restrict storage access', error);
});

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

/**
 * Refreshes run one after another. A forced refresh (options page) always runs, after the one in
 * progress, so it sees the settings just saved. Background checks from GitHub tabs are deduplicated:
 * at most one waits in the queue. The storage lock covers worker restarts.
 */
let queue: Promise<void> = Promise.resolve();
let backgroundQueued = false;

function enqueue(task: () => Promise<unknown>): Promise<void> {
  const run = queue.then(async () => {
    // Extension API calls reset the worker's idle timer; a long refresh of fetches does not.
    const keepAlive = setInterval(() => {
      void chrome.runtime.getPlatformInfo();
    }, KEEP_ALIVE_MS);
    try {
      await task();
    } catch (error) {
      console.error('[review-ratio] refresh crashed', error);
    } finally {
      clearInterval(keepAlive);
    }
  });
  queue = run;
  return run;
}

async function broadcastBadge(): Promise<void> {
  const view = badgeView(await store.getBadge(), Date.now());
  const message: BadgeUpdate = { type: 'badge:update', view };
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: GITHUB_TABS });
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

function refreshInBackground(): void {
  if (backgroundQueued) return;
  backgroundQueued = true;
  void enqueue(async () => {
    backgroundQueued = false;
    if ((await refreshIfDue(deps)).refreshed) await broadcastBadge();
  });
}

async function handle(request: Request): Promise<Response> {
  switch (request.type) {
    case 'badge:get': {
      const cache = await store.getBadge();
      refreshInBackground();
      return { type: 'badge:view', view: badgeView(cache, Date.now()) };
    }
    case 'badge:refresh': {
      await enqueue(async () => {
        await refresh(deps);
        await broadcastBadge();
      });
      return { type: 'badge:view', view: badgeView(await store.getBadge(), Date.now()) };
    }
    case 'cache:get':
      return { type: 'cache', cache: await store.getBadge() };
  }
}

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse: (response: Response) => void) => {
    if (!isRequest(message)) return false;
    if (!isTrustedFor(message, sender, chrome.runtime.id, chrome.runtime.getURL(''))) {
      sendResponse({ type: 'error', message: 'not allowed' });
      return false;
    }
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

/**
 * Chrome injects manifest content scripts on navigation only. GitHub tabs live for days, so after
 * an install or an update the open tabs get the new content script here.
 */
async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: GITHUB_TABS });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      } catch {
        // Discarded or restricted tab: it gets the script on its next navigation.
      }
    }),
  );
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    void injectIntoOpenTabs();
  }
  if (details.reason === 'install') {
    void store.getSettings().then((settings) => {
      if (!settings.token) void chrome.runtime.openOptionsPage();
    });
  }
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
