/**
 * Background service worker. Owns the refresh: the content script only ever asks for the
 * badge, and the worker decides whether the cache is fresh enough. Owns the GitHub tokens too:
 * the GitHub App sign-in runs here, and only here are app tokens used and renewed.
 */
import { ActivityLog, chromeSessionArea, loggingFetch } from '../lib/activity-log.ts';
import { GITHUB_APP_CLIENT_ID, GITHUB_APP_SLUG, installUrl } from '../lib/auth/app-config.ts';
import { createAuth } from '../lib/auth/index.ts';
import { FLOW_KEY, createSignIn } from '../lib/auth/sign-in.ts';
import { badgeView } from '../lib/badge-state.ts';
import { diagnose } from '../lib/diagnose.ts';
import { createGitHubClient } from '../lib/github/client.ts';
import { isRequest, type BadgeUpdate, type Request, type Response } from '../lib/messages.ts';
import { refresh, refreshIfDue, type RefreshDeps } from '../lib/refresh.ts';
import { recordPlacement } from '../lib/placement.ts';
import { coerceSettings } from '../lib/settings.ts';
import { Store, chromeStorageArea } from '../lib/storage.ts';
import { isTrustedFor } from './senders.ts';

/** Extension API calls reset the service worker's 30 s idle timer; fetches alone do not. */
const KEEP_ALIVE_MS = 20_000;
const GITHUB_TABS = 'https://github.com/*';

const store = new Store(chromeStorageArea());
const session = chromeSessionArea();
const activity = new ActivityLog(session, {
  onError: (error) => {
    console.warn('[review-ratio] cannot write the activity log', error);
  },
});
// Resolved at call time, so the worker always uses the current global fetch.
const loggedFetch = loggingFetch((input, init) => fetch(input, init), activity);

// The GitHub tokens live in storage.local. Content scripts never need it: keep it out of reach
// of a compromised github.com renderer. Firefox has no setAccessLevel (bug 1724754), and calling
// it would stop the worker before it listens to anything.
if ('setAccessLevel' in chrome.storage.local) {
  chrome.storage.local
    .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    .catch((error: unknown) => {
      console.warn('[review-ratio] cannot restrict storage access', error);
    });
}

function log(message: string): void {
  console.info(`[review-ratio] ${message}`);
  activity.event(message);
}

/** Extension API calls reset the worker's idle timer; a long run of fetches does not. */
function keepAlive(): () => void {
  const timer = setInterval(() => {
    void chrome.runtime.getPlatformInfo();
  }, KEEP_ALIVE_MS);
  return () => {
    clearInterval(timer);
  };
}

const auth = createAuth({
  store,
  fetchImpl: loggedFetch,
  now: () => Date.now(),
  clientId: GITHUB_APP_CLIENT_ID,
  log,
});

const signIn = createSignIn({
  auth,
  store,
  fetchImpl: loggedFetch,
  now: () => Date.now(),
  clientId: GITHUB_APP_CLIENT_ID,
  slug: GITHUB_APP_SLUG,
  publish: async (view) => {
    await chrome.storage.session.set({ [FLOW_KEY]: view });
    await activity.flush();
  },
  keepAlive,
  log,
});

const deps: RefreshDeps = {
  store,
  now: () => Date.now(),
  auth,
  github: (source) => createGitHubClient({ auth: source, fetchImpl: loggedFetch }),
  randomUUID: () => crypto.randomUUID(),
  log,
};

/**
 * Refreshes run one after another. A forced refresh (options page) always runs, after the one in
 * progress, so it sees the settings just saved. Background checks from GitHub tabs are deduplicated:
 * at most one waits in the queue. The storage lock covers worker restarts.
 */
let queue: Promise<void> = Promise.resolve();
let placements: Promise<void> = Promise.resolve();
let backgroundQueued = false;

function enqueue(task: () => Promise<unknown>): Promise<void> {
  const run = queue.then(async () => {
    const stopKeepAlive = keepAlive();
    try {
      await task();
    } catch (error) {
      console.error('[review-ratio] refresh crashed', error);
      activity.event(`refresh crashed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      stopKeepAlive();
      await activity.flush();
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
    const { refreshed } = await refreshIfDue(deps, 'a github.com tab asked for the badge');
    if (refreshed) await broadcastBadge();
  });
}

/** Test connection: the form's PAT as typed, or the app token, renewed first when due. */
async function testConnection(raw: unknown): Promise<Response> {
  const settings = coerceSettings(raw);
  log('Test connection, asked by the options page');
  try {
    if (settings.authMode === 'pat') {
      const { ok, lines } = await diagnose(settings, loggedFetch);
      return { type: 'diagnosis', ok, lines };
    }
    // GitHub out of reach for the renewal: test with the stored token, so the diagnosis says why.
    const creds = await store.getAppAuth();
    const token = (await auth.getAccessToken().catch(() => creds?.accessToken ?? null)) ?? '';
    const { ok, lines } = await diagnose({ ...settings, token }, loggedFetch, Date.now(), {
      accessTokenExpiresAt: creds?.accessTokenExpiresAt ?? null,
      installUrl: installUrl(GITHUB_APP_SLUG),
    });
    return { type: 'diagnosis', ok, lines };
  } finally {
    await activity.flush();
  }
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
        await refresh(deps, 'asked by the options page');
        await broadcastBadge();
      });
      return { type: 'badge:view', view: badgeView(await store.getBadge(), Date.now()) };
    }
    case 'cache:get':
      return { type: 'cache', cache: await store.getBadge() };
    case 'auth:status':
      return { type: 'auth', status: await signIn.status() };
    case 'auth:start':
      return { type: 'auth', status: await signIn.start() };
    case 'auth:cancel':
      return { type: 'auth', status: await signIn.cancel() };
    case 'auth:sign-out':
      return { type: 'auth', status: await signIn.signOut() };
    case 'connection:test':
      return testConnection(request.settings);
    case 'badge:placed': {
      const report = { placement: request.placement, header: request.header, at: Date.now() };
      // One at a time: a report reads the previous one before writing.
      placements = placements
        .then(() => recordPlacement(session, activity, report))
        .catch((error: unknown) => {
          console.warn('[review-ratio] cannot record the badge placement', error);
        });
      await placements;
      await activity.flush();
      return { type: 'ok' };
    }
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
    void auth.hasCredential().then((connected) => {
      if (!connected) void chrome.runtime.openOptionsPage();
    });
  }
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
