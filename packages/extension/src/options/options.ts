/**
 * Options page: the token, the scope, the server, a few diagnostics and the activity log.
 */
import {
  ActivityLog,
  chromeSessionArea,
  clearActivity,
  formatBody,
  loggingFetch,
  readActivity,
  readQuery,
  rowOf,
  summarize,
  toText,
  type ActivityEntry,
  type CallEntry,
} from '../lib/activity-log.ts';
import { diagnose } from '../lib/diagnose.ts';
import { clearPlacement, readPlacement } from '../lib/placement.ts';
import type { Request, Response } from '../lib/messages.ts';
import {
  DEFAULT_SETTINGS,
  isValidOrg,
  normalizeServerUrl,
  parseExcludeList,
  serverUrlProblem,
  type Settings,
} from '../lib/settings.ts';
import { Store, chromeStorageArea, type BadgeCache } from '../lib/storage.ts';
import { localTime } from '../lib/time.ts';

const store = new Store(chromeStorageArea());
const sessionArea = chromeSessionArea();
const activity = new ActivityLog(sessionArea, {
  onError: (error) => {
    console.warn('[review-ratio] cannot write the activity log', error);
  },
});
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
const serverUrlInput = el('server-url', HTMLInputElement);
const status = el('status', HTMLParagraphElement);
const buttons = {
  save: el('save', HTMLButtonElement),
  test: el('test', HTMLButtonElement),
  refresh: el('refresh', HTMLButtonElement),
  forget: el('forget', HTMLButtonElement),
  toggleToken: el('toggle-token', HTMLButtonElement),
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

function readForm(): Settings {
  return {
    token: tokenInput.value.trim(),
    org: orgInput.value.trim() || DEFAULT_SETTINGS.org,
    excludedRepos: parseExcludeList(excludedInput.value),
    serverUrl: normalizeServerUrl(serverUrlInput.value),
  };
}

function fillForm(settings: Settings): void {
  tokenInput.value = settings.token;
  orgInput.value = settings.org;
  excludedInput.value = settings.excludedRepos.join('\n');
  serverUrlInput.value = settings.serverUrl;
  el('org-hint', HTMLElement).textContent = settings.org;
}

async function send(request: Request): Promise<Response> {
  return chrome.runtime.sendMessage<Request, Response>(request);
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
  const all = Object.values(buttons);
  for (const b of all) b.disabled = true;
  try {
    return await task();
  } catch (error) {
    setStatus('error', error instanceof Error ? error.message : String(error));
    return undefined;
  } finally {
    for (const b of all) b.disabled = false;
    button.focus();
  }
}

async function testConnection(settings: Settings): Promise<void> {
  activity.event('Test connection, on the options page');
  try {
    const { ok, lines } = await diagnose(
      settings,
      loggingFetch((input, init) => fetch(input, init), activity),
    );
    setStatus(ok ? 'ok' : 'warn', lines.join('\n'));
  } finally {
    await activity.flush();
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
  if (!isValidOrg(settings.org)) return `"${settings.org}" is not a GitHub organisation name.`;
  const urlProblem = serverUrlProblem(settings.serverUrl);
  return urlProblem ? `${urlProblem[0]?.toUpperCase() ?? ''}${urlProblem.slice(1)}.` : null;
}

/** Saves valid settings, refreshes the badge with them, and reports the result. */
async function saveAndRefresh(prefix: string): Promise<void> {
  const settings = readForm();
  const problem = formProblem(settings);
  if (problem) {
    setStatus('error', `Not saved. ${problem}`);
    return;
  }
  await store.setSettings(settings);
  fillForm(await store.getSettings());
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

buttons.toggleToken.addEventListener('click', () => {
  const show = tokenInput.type === 'password';
  tokenInput.type = show ? 'text' : 'password';
  buttons.toggleToken.textContent = show ? 'Hide' : 'Show';
  buttons.toggleToken.setAttribute('aria-pressed', String(show));
});

orgInput.addEventListener('input', () => {
  el('org-hint', HTMLElement).textContent = orgInput.value.trim() || DEFAULT_SETTINGS.org;
});

void (async () => {
  fillForm(await store.getSettings());
  await showDiagnostics();
  await showPlacement();
  await showActivity();
})();
