/**
 * Options page: the token, the scope, the server, and a few diagnostics.
 */
import type { Request, Response } from '../lib/messages.ts';
import {
  DEFAULT_SETTINGS,
  normalizeServerUrl,
  parseExcludeList,
  type Settings,
} from '../lib/settings.ts';
import { Store, chromeStorageArea, type BadgeCache } from '../lib/storage.ts';

const store = new Store(chromeStorageArea());

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
  const lines: string[] = [];
  if (!settings.token) {
    lines.push('GitHub: no token.');
  } else {
    const res = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${settings.token}`, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const user = (await res.json()) as { login: string };
      const remaining = res.headers.get('x-ratelimit-remaining') ?? '?';
      lines.push(`GitHub: token works for ${user.login} (${remaining} API calls left this hour).`);
    } else {
      lines.push(`GitHub: token rejected (${res.status}).`);
    }
  }
  try {
    const res = await fetch(`${settings.serverUrl}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      version?: string;
      contract?: { supported?: number[] };
    };
    lines.push(
      body.ok
        ? `Server: ${settings.serverUrl} is up (v${body.version ?? '?'}, contract ${body.contract?.supported?.join(', ') ?? '?'}).`
        : `Server: unexpected answer ${res.status}.`,
    );
  } catch (error) {
    lines.push(
      `Server: unreachable at ${settings.serverUrl} (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  setStatus(
    lines.some((l) => /rejected|unreachable|unexpected|no token/.test(l)) ? 'warn' : 'ok',
    lines.join('\n'),
  );
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void busy(buttons.save, async () => {
    const settings = readForm();
    await store.setSettings(settings);
    // New settings deserve a fresh score: lift the 10-minute throttle for the next page load.
    await store.updateBadge({ attemptedAt: null });
    fillForm(await store.getSettings());
    setStatus('ok', 'Saved. The badge refreshes on the next GitHub page load.');
    await showDiagnostics();
  });
});

buttons.test.addEventListener('click', () => {
  void busy(buttons.test, async () => {
    setStatus('info', 'Testing…');
    await testConnection(readForm());
  });
});

buttons.refresh.addEventListener('click', () => {
  void busy(buttons.refresh, async () => {
    await store.setSettings(readForm());
    setStatus('info', 'Refreshing…');
    const response = await send({ type: 'badge:refresh' });
    if (response.type === 'badge:view') {
      setStatus(
        response.view.stale ? 'warn' : 'ok',
        `${response.view.text}\n${response.view.tooltip}`,
      );
    } else if (response.type === 'error') {
      setStatus('error', response.message);
    }
    await showDiagnostics();
  });
});

buttons.forget.addEventListener('click', () => {
  void busy(buttons.forget, async () => {
    await store.clearActivity();
    setStatus(
      'ok',
      'Forgot the cached badge, class globs, PR keys and Viewed snapshots. Settings kept.',
    );
    await showDiagnostics();
  });
});

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
})();
