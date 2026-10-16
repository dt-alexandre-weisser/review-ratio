/**
 * Options page: GitHub access (app sign-in or token), the scope, a few diagnostics and the
 * activity log. The sign-in and Test connection run in the service worker, which owns the tokens.
 */
import {
  chromeSessionArea,
  clearActivity,
  formatBody,
  readActivity,
  readQuery,
  rowOf,
  summarize,
  toText,
  type ActivityEntry,
  type CallEntry,
} from '../lib/activity-log.ts';
import { FLOW_KEY, type AuthStatus } from '../lib/auth/sign-in.ts';
import { clearPlacement, readPlacement } from '../lib/placement.ts';
import type { Request, Response } from '../lib/messages.ts';
import {
  DEFAULT_SETTINGS,
  isValidOrg,
  parseExcludeList,
  type AuthMode,
  type Settings,
} from '../lib/settings.ts';
import { Store, chromeStorageArea, type BadgeCache } from '../lib/storage.ts';
import { localClock, localTime } from '../lib/time.ts';

const store = new Store(chromeStorageArea());
const sessionArea = chromeSessionArea();
/** Rows rendered at most; Copy as text includes every entry. */
const MAX_ROWS = 500;

function el<T extends HTMLElement>(id: string, kind: abstract new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof kind)) throw new Error(`#${id} is missing or not a ${kind.name}`);
  return node;
}

const form = el('settings', HTMLFormElement);
const tokenInput = el('token', HTMLInputElement);
const orgInput = el('org', HTMLInputElement);
const excludedInput = el('excluded', HTMLTextAreaElement);
const status = el('status', HTMLParagraphElement);
const buttons = {
  save: el('save', HTMLButtonElement),
  test: el('test', HTMLButtonElement),
  refresh: el('refresh', HTMLButtonElement),
  forget: el('forget', HTMLButtonElement),
  toggleToken: el('toggle-token', HTMLButtonElement),
};
const modeInputs = { app: el('mode-app', HTMLInputElement), pat: el('mode-pat', HTMLInputElement) };
const app = {
  panel: el('app-panel', HTMLDivElement),
  patPanel: el('pat-panel', HTMLDivElement),
  unavailable: el('app-unavailable', HTMLParagraphElement),
  installLink: el('install-link', HTMLAnchorElement),
  signedOut: el('app-signed-out', HTMLDivElement),
  waiting: el('app-waiting', HTMLDivElement),
  signedIn: el('app-signed-in', HTMLDivElement),
  userCode: el('user-code', HTMLOutputElement),
  verifyLink: el('verify-link', HTMLAnchorElement),
  waitingHint: el('waiting-hint', HTMLParagraphElement),
  login: el('signed-in-login', HTMLElement),
  signIn: el('sign-in', HTMLButtonElement),
  copyCode: el('copy-code', HTMLButtonElement),
  cancel: el('cancel-sign-in', HTMLButtonElement),
  signOut: el('sign-out', HTMLButtonElement),
};
const copyButton = el('copy-activity', HTMLButtonElement);
const activityRows = el('activity-rows', HTMLTableSectionElement);
const activitySummary = el('activity-summary', HTMLParagraphElement);
const payload = {
  section: el('payload', HTMLElement),
  title: el('payload-title', HTMLHeadingElement),
  meta: el('payload-meta', HTMLParagraphElement),
  text: el('payload-text', HTMLPreElement),
  copy: el('copy-payload', HTMLButtonElement),
  close: el('close-payload', HTMLButtonElement),
};

function setStatus(kind: 'ok' | 'error' | 'warn' | 'info', text: string): void {
  status.dataset['kind'] = kind;
  status.textContent = text;
}

/** What the worker last said about the sign-in; `null` until it answered. */
let authStatus: AuthStatus | null = null;
/** Set by Cancel, so that the end of the flow does not read as a worker restart. */
let cancelled = false;

function selectedMode(): AuthMode {
  return modeInputs.app.checked ? 'app' : 'pat';
}

/** The settings as the form says; the token only in token mode. */
function readForm(): Settings {
  const authMode = selectedMode();
  return {
    authMode,
    token: authMode === 'pat' ? tokenInput.value.trim() : '',
    org: orgInput.value.trim() || DEFAULT_SETTINGS.org,
    excludedRepos: parseExcludeList(excludedInput.value),
  };
}

function showOrg(org: string): void {
  el('org-hint', HTMLElement).textContent = org;
  el('org-hint-app', HTMLElement).textContent = org;
}

function fillForm(settings: Settings): void {
  tokenInput.value = settings.token;
  orgInput.value = settings.org;
  excludedInput.value = settings.excludedRepos.join('\n');
  showOrg(settings.org);
}

function showMode(mode: AuthMode): void {
  modeInputs[mode].checked = true;
  app.panel.hidden = mode !== 'app';
  app.patPanel.hidden = mode !== 'pat';
}

async function send(request: Request): Promise<Response> {
  return chrome.runtime.sendMessage<Request, Response>(request);
}

/**
 * Shows the sign-in as the worker reports it, and says what changed since the last report. The
 * first report also picks the radio: the stored mode, or the app for a fresh install.
 */
function renderAuth(next: AuthStatus, initial: boolean): void {
  const before = authStatus?.flow.state ?? 'idle';
  authStatus = next;
  modeInputs.app.disabled = !next.appConfigured;
  app.unavailable.hidden = next.appConfigured;
  app.installLink.href = next.installUrl;
  if (initial) {
    const preferApp = next.mode === 'app' || !tokenInput.value;
    showMode(next.appConfigured && preferApp ? 'app' : 'pat');
  }
  const { flow } = next;
  const waiting = flow.state === 'waiting';
  app.waiting.hidden = !waiting;
  app.signedIn.hidden = waiting || next.signedIn === null;
  app.signedOut.hidden = waiting || next.signedIn !== null;
  app.login.textContent = next.signedIn?.login ?? 'your GitHub account';
  if (flow.state === 'waiting') {
    app.userCode.value = flow.userCode;
    app.verifyLink.href = flow.verificationUri;
    app.waitingHint.textContent = `Waiting for GitHub… The code works until ${localClock(flow.expiresAt)}. This page can be closed: the sign-in goes on.`;
  }
  if (initial || flow.state === before) return;
  // The code is on screen: "Asking GitHub for a code…" is over.
  if (flow.state === 'waiting') status.textContent = '';
  if (flow.state === 'failed') setStatus('error', flow.message);
  if (flow.state === 'idle' && before === 'waiting' && !next.signedIn && !cancelled) {
    setStatus('warn', 'The sign-in stopped: the extension restarted. Sign in again.');
  }
  cancelled = false;
  if (flow.state === 'signed_in') {
    void busy(app.signIn, () =>
      refreshBadge(`Signed in as ${flow.login ?? 'your GitHub account'}. `),
    );
  }
}

async function loadAuth(initial = false): Promise<void> {
  const response = await send({ type: 'auth:status' });
  if (response.type === 'auth') renderAuth(response.status, initial);
}

function describeCache(cache: BadgeCache): void {
  el('diag-status', HTMLElement).textContent = cache.status;
  el('diag-score', HTMLElement).textContent = cache.score
    ? `up ${cache.score.up} · down ${cache.score.down} · ratio ${cache.score.ratio ?? '∞ / —'}`
    : '—';
  el('diag-refreshed', HTMLElement).textContent = cache.scoredAt
    ? new Date(cache.scoredAt).toLocaleString()
    : 'never';
  el('diag-error', HTMLElement).textContent = cache.error ?? '—';
}

const GITHUB_PAGES = { origins: ['https://github.com/*'] };

async function showPlacement(): Promise<void> {
  const state = await readPlacement(sessionArea);
  const where = el('diag-placement', HTMLElement);
  const details = el('diag-header-wrap', HTMLDetailsElement);
  // Site access set to "on click", or an enterprise policy, keeps the badge off github.com.
  const allowed = await chrome.permissions.contains(GITHUB_PAGES);
  if (!allowed) {
    where.textContent =
      'Chrome does not let the extension run on github.com. In chrome://extensions, open Details and set Site access to allow github.com.';
  } else if (!state) {
    where.textContent = 'no badge yet: open or reload a github.com page';
  } else {
    const { placement, at } = state.latest;
    where.textContent =
      placement === 'header'
        ? `in the GitHub header (${localTime(at)})`
        : `bottom-right corner: no place found in GitHub's header (${localTime(at)})`;
  }
  const floating = state?.lastFloating ?? null;
  details.hidden = floating === null;
  if (floating) {
    el('diag-header-summary', HTMLElement).textContent =
      `What the badge saw of GitHub's header when it last floated (${localTime(floating.at)})`;
    el('diag-header', HTMLPreElement).textContent =
      floating.header || 'no <header> element on the page';
  }
}

async function showDiagnostics(): Promise<void> {
  const response = await send({ type: 'cache:get' });
  if (response.type === 'cache') describeCache(response.cache);
}

async function busy<T>(button: HTMLButtonElement, task: () => Promise<T>): Promise<T | undefined> {
  const all = [...Object.values(buttons), app.signIn, app.signOut, app.cancel];
  for (const b of all) b.disabled = true;
  try {
    return await task();
  } catch (error) {
    setStatus('error', error instanceof Error ? error.message : String(error));
    return undefined;
  } finally {
    for (const b of all) b.disabled = false;
    // The button may be hidden by now, e.g. Sign in once the code shows.
    if (!button.closest('[hidden]')) button.focus();
  }
}

async function testConnection(settings: Settings): Promise<void> {
  const response = await send({ type: 'connection:test', settings });
  if (response.type === 'diagnosis') {
    setStatus(response.ok ? 'ok' : 'warn', response.lines.join('\n'));
  } else if (response.type === 'error') {
    setStatus('error', response.message);
  }
}

let shownEntries: ActivityEntry[] = [];
/** What the table shows, to skip redraws that would clear the user's text selection. */
let shownSignature = '';

function activityRow(entry: ActivityEntry): HTMLTableRowElement {
  const row = rowOf(entry);
  const tr = document.createElement('tr');
  tr.dataset['event'] = String(row.event);
  tr.dataset['failed'] = String(row.failed);
  const cell = (text: string) => {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
  };
  const what = cell(row.what);
  if (row.event) {
    what.colSpan = 3;
    tr.append(cell(row.time), what);
    return tr;
  }
  if (row.detail) {
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = row.detail;
    what.append(detail);
  }
  if (entry.kind === 'call' && entry.body) {
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'view-payload';
    view.textContent = 'View payload';
    view.addEventListener('click', () => {
      showPayload(entry).catch((error: unknown) => {
        setStatus('error', `Cannot show the payload: ${String(error)}`);
      });
    });
    what.append(view);
  }
  tr.append(cell(row.time), what, cell(row.result), cell(row.duration));
  return tr;
}

/** Shows what a call sent, below the table: it stays open while new calls arrive. */
async function showPayload(entry: CallEntry): Promise<void> {
  if (!entry.body) return;
  const query =
    entry.body.kind === 'graphql' ? await readQuery(sessionArea, entry.body.queryId) : null;
  const row = rowOf(entry);
  payload.title.textContent = row.what;
  payload.meta.textContent = [row.time, row.detail, `${row.result} in ${row.duration}`]
    .filter(Boolean)
    .join(' · ');
  payload.text.textContent = formatBody(entry.body, query);
  payload.section.hidden = false;
  payload.section.scrollIntoView({ block: 'nearest' });
}

async function showActivity(): Promise<void> {
  const entries = await readActivity(sessionArea, Date.now());
  // Entries only arrive newest and age out oldest: both ends and the count tell any change.
  const signature = `${entries.length}:${entries[0]?.at ?? ''}:${entries.at(-1)?.at ?? ''}`;
  if (signature === shownSignature) return;
  shownSignature = signature;
  shownEntries = entries;
  activitySummary.textContent = summarize(entries);
  const rows = entries.slice(0, MAX_ROWS).map(activityRow);
  if (entries.length > MAX_ROWS) {
    const more = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = `${entries.length - MAX_ROWS} older entries not shown. Copy as text includes them.`;
    more.append(td);
    rows.push(more);
  }
  activityRows.replaceChildren(...rows);
}

let activityQueued = false;

/** Re-renders soon, once, however many batches land at the same time. */
function scheduleActivity(): void {
  if (activityQueued) return;
  activityQueued = true;
  setTimeout(() => {
    activityQueued = false;
    showPlacement().catch((error: unknown) => {
      console.warn('[review-ratio] cannot read the badge placement', error);
    });
    showActivity().catch((error: unknown) => {
      activitySummary.textContent = `Cannot read the activity log: ${error instanceof Error ? error.message : String(error)}`;
    });
  }, 250);
}

/** Why the form cannot be used, or `null`. Save and Refresh both refuse invalid settings. */
function formProblem(settings: Settings): string | null {
  return isValidOrg(settings.org) ? null : `"${settings.org}" is not a GitHub organisation name.`;
}

/**
 * Saves valid settings, refreshes the badge with them, and reports the result. Saving token mode
 * forgets the app sign-in. App mode takes over when the sign-in ends, not on Save: until then the
 * stored token stays in use.
 */
async function saveAndRefresh(prefix: string): Promise<void> {
  let settings = readForm();
  const problem = formProblem(settings);
  if (problem) {
    setStatus('error', `Not saved. ${problem}`);
    return;
  }
  if (settings.authMode === 'app' && !authStatus?.signedIn) {
    const stored = await store.getSettings();
    settings = { ...settings, authMode: stored.authMode, token: stored.token };
  }
  if (settings.authMode === 'pat' && authStatus?.signedIn) {
    const response = await send({ type: 'auth:sign-out' });
    if (response.type === 'auth') renderAuth(response.status, false);
  }
  await store.setSettings(settings);
  fillForm(await store.getSettings());
  await refreshBadge(prefix);
}

/** Refreshes the badge now and reports the result. */
async function refreshBadge(prefix: string): Promise<void> {
  setStatus('info', `${prefix}Refreshing the badge…`);
  // Pushed to the open GitHub tabs too.
  const response = await send({ type: 'badge:refresh' });
  if (response.type === 'badge:view') {
    setStatus(
      response.view.stale ? 'warn' : 'ok',
      `${prefix}${response.view.text}\n${response.view.tooltip}`,
    );
  } else if (response.type === 'error') {
    setStatus('error', `${prefix}${response.message}`);
  }
  await showDiagnostics();
}

/** Runs a sign-in step in the worker and shows its outcome. */
function authStep(button: HTMLButtonElement, request: Request): void {
  void busy(button, async () => {
    const response = await send(request);
    if (response.type === 'auth') renderAuth(response.status, false);
    else if (response.type === 'error') setStatus('error', response.message);
  });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void busy(buttons.save, () => saveAndRefresh('Saved. '));
});

buttons.test.addEventListener('click', () => {
  void busy(buttons.test, async () => {
    setStatus('info', 'Testing…');
    await testConnection(readForm());
  });
});

buttons.refresh.addEventListener('click', () => {
  void busy(buttons.refresh, () => saveAndRefresh(''));
});

buttons.forget.addEventListener('click', () => {
  void busy(buttons.forget, async () => {
    await store.clearActivity();
    await clearActivity(sessionArea);
    await clearPlacement(sessionArea);
    payload.section.hidden = true;
    setStatus(
      'ok',
      'Forgot the cached badge, class globs, PR keys, Viewed snapshots and the activity log. Settings kept.',
    );
    await showDiagnostics();
    await showPlacement();
    await showActivity();
  });
});

for (const input of Object.values(modeInputs)) {
  input.addEventListener('change', () => {
    showMode(selectedMode());
    status.textContent = '';
  });
}

app.signIn.addEventListener('click', () => {
  setStatus('info', 'Asking GitHub for a code…');
  authStep(app.signIn, { type: 'auth:start' });
});

app.cancel.addEventListener('click', () => {
  cancelled = true;
  setStatus('info', 'Sign-in cancelled.');
  authStep(app.cancel, { type: 'auth:cancel' });
});

app.signOut.addEventListener('click', () => {
  void busy(app.signOut, async () => {
    const response = await send({ type: 'auth:sign-out' });
    if (response.type === 'auth') renderAuth(response.status, false);
    await refreshBadge('Signed out. ');
  });
});

app.copyCode.addEventListener('click', () => {
  navigator.clipboard.writeText(app.userCode.value).then(
    () => {
      setStatus('info', 'Code copied. Paste it on GitHub.');
    },
    (error: unknown) => {
      setStatus('error', `Cannot copy: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
});

copyButton.addEventListener('click', () => {
  const text = toText(shownEntries);
  if (!text) {
    setStatus('info', 'The activity log is empty: nothing to copy.');
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => {
      const n = shownEntries.length;
      setStatus(
        'ok',
        `Copied ${n} activity log ${n === 1 ? 'entry' : 'entries'}. They name repositories and pull requests: read them before sharing.`,
      );
    },
    (error: unknown) => {
      setStatus('error', `Cannot copy: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
});

payload.copy.addEventListener('click', () => {
  navigator.clipboard.writeText(payload.text.textContent).then(
    () => {
      setStatus('ok', 'Copied the payload. It may name repositories and your login.');
    },
    (error: unknown) => {
      setStatus('error', `Cannot copy: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
});

payload.close.addEventListener('click', () => {
  payload.section.hidden = true;
});

// New batches from the worker show up live; the interval ages out entries older than 30 minutes.
chrome.storage.session.onChanged.addListener(scheduleActivity);
setInterval(scheduleActivity, 15_000);

// The worker publishes each step of the sign-in. While waiting, the page also checks that the
// worker still runs it: a worker that stopped forgets the sign-in.
chrome.storage.session.onChanged.addListener((changes) => {
  if (FLOW_KEY in changes) void loadAuth();
});
setInterval(() => {
  if (authStatus?.flow.state === 'waiting') void loadAuth();
}, 15_000);

buttons.toggleToken.addEventListener('click', () => {
  const show = tokenInput.type === 'password';
  tokenInput.type = show ? 'text' : 'password';
  buttons.toggleToken.textContent = show ? 'Hide' : 'Show';
  buttons.toggleToken.setAttribute('aria-pressed', String(show));
});

orgInput.addEventListener('input', () => {
  showOrg(orgInput.value.trim() || DEFAULT_SETTINGS.org);
});

void (async () => {
  fillForm(await store.getSettings());
  await loadAuth(true);
  await showDiagnostics();
  await showPlacement();
  await showActivity();
})();
