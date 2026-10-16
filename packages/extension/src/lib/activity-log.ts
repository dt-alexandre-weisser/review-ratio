/**
 * The activity log: every network call the extension made in the last 30 minutes, with refresh
 * start and end lines, for the options page. It answers "what does the extension call, and when?"
 * without DevTools.
 *
 * It lives in `chrome.storage.session`: in memory, out of reach of content scripts, and gone when
 * the browser closes. It holds URLs, so repository names and PR numbers, but never a header and
 * so never the token. Nothing in it leaves the browser.
 *
 * Several contexts write it (the worker, and the options page for Test connection). Each flush
 * writes its own key, so writers never overwrite each other and no read-modify-write is needed.
 */
import { localTime } from './time.ts';

export const LOG_WINDOW_MS = 30 * 60 * 1000;
/** Entries wait this long in memory, so a refresh of many calls writes a few keys, not hundreds. */
export const FLUSH_DELAY_MS = 2_000;
/** A batch this large is written at once. */
export const MAX_BATCH_ENTRIES = 100;
/**
 * Oldest batches beyond this many entries are dropped. A heavy 30 minutes is about 2,000 calls.
 * With texts clipped at 500 characters, 5,000 entries stay under 8 MB of the 10 MB quota.
 */
export const MAX_ENTRIES = 5_000;
const MAX_TEXT = 500;
const KEY_PREFIX = 'activity:';
/** `activity:<flushed at, ms>:<entries>:<id>`: pruning needs no read of the batches. */
const KEY = /^activity:(\d+):(\d+):[\w-]+$/;

export interface CallEntry {
  kind: 'call';
  /** When the call started, in ms since the epoch. */
  at: number;
  method: string;
  url: string;
  /** What the call was for when the URL does not say: the GraphQL operation and PR. */
  detail: string | null;
  /** The HTTP status, or `null` when no response came back. */
  status: number | null;
  /** Why no response came back: network error, timeout. */
  error: string | null;
  /** Time until the response headers arrived. */
  ms: number;
}

export interface EventEntry {
  kind: 'event';
  at: number;
  message: string;
}

export type ActivityEntry = CallEntry | EventEntry;

/** The subset of `chrome.storage.session` the log uses. Injected for tests. */
export interface LogArea {
  getKeys(): Promise<string[]>;
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface ActivityLogOptions {
  now?: () => number;
  randomId?: () => string;
  flushDelayMs?: number;
  /** A failed write must never fail a refresh. */
  onError?: (error: unknown) => void;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

interface BatchKey {
  key: string;
  /** When the batch was written. */
  at: number;
  entries: number;
}

/** The parts of a batch key, or `null` for a key that is not a batch of this version. */
function parseKey(key: string): BatchKey | null {
  const match = KEY.exec(key);
  return match ? { key, at: Number(match[1]), entries: Number(match[2]) } : null;
}

/** Buffers entries and writes them to session storage in batches. */
export class ActivityLog {
  private pending: ActivityEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly flushDelayMs: number;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly area: LogArea,
    options: ActivityLogOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.flushDelayMs = options.flushDelayMs ?? FLUSH_DELAY_MS;
    this.onError = options.onError ?? (() => undefined);
  }

  event(message: string): void {
    this.record({ kind: 'event', at: this.now(), message: clip(message) });
  }

  call(entry: Omit<CallEntry, 'kind'>): void {
    this.record({
      kind: 'call',
      ...entry,
      url: clip(entry.url),
      detail: entry.detail === null ? null : clip(entry.detail),
      error: entry.error === null ? null : clip(entry.error),
    });
  }

  private record(entry: ActivityEntry): void {
    this.pending.push(entry);
    if (this.pending.length >= MAX_BATCH_ENTRIES) {
      void this.flush();
    } else {
      this.timer ??= setTimeout(() => void this.flush(), this.flushDelayMs);
    }
  }

  /** Writes what is buffered and drops batches older than the window. Never throws. */
  async flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.pending;
    this.pending = [];
    const now = this.now();
    if (batch.length > 0) {
      try {
        await this.area.set({
          [`${KEY_PREFIX}${now}:${batch.length}:${this.randomId()}`]: batch,
        });
      } catch (error) {
        this.onError(error);
      }
    }
    // Even after a failed write: pruning is what frees room for the next one.
    try {
      await prune(this.area, now);
    } catch (error) {
      this.onError(error);
    }
  }
}

/**
 * Removes the batches written outside the window, the oldest ones beyond `MAX_ENTRIES`, and keys
 * of an older layout. A batch written after the window's start holds entries that may still be
 * in it.
 */
async function prune(area: LogArea, now: number): Promise<void> {
  const keys = (await area.getKeys()).filter((key) => key.startsWith(KEY_PREFIX));
  const stale = keys.filter((key) => parseKey(key) === null);
  const batches = keys
    .map(parseKey)
    .filter((b): b is BatchKey => b !== null)
    .sort((a, b) => b.at - a.at);
  let kept = 0;
  for (const batch of batches) {
    // A clock set back leaves batches "from the future": they would never age out.
    const outside = batch.at < now - LOG_WINDOW_MS || batch.at > now + LOG_WINDOW_MS;
    if (outside || (kept > 0 && kept + batch.entries > MAX_ENTRIES)) {
      stale.push(batch.key);
    } else {
      kept += batch.entries;
    }
  }
  if (stale.length > 0) await area.remove(stale);
}

function isEntry(value: unknown): value is ActivityEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e['at'] !== 'number' || !Number.isFinite(e['at'])) return false;
  if (e['kind'] === 'event') return typeof e['message'] === 'string';
  return (
    e['kind'] === 'call' &&
    typeof e['method'] === 'string' &&
    typeof e['url'] === 'string' &&
    (e['detail'] === null || typeof e['detail'] === 'string') &&
    (e['status'] === null || typeof e['status'] === 'number') &&
    (e['error'] === null || typeof e['error'] === 'string') &&
    typeof e['ms'] === 'number'
  );
}

/** The entries of the last 30 minutes, newest first. Malformed entries are skipped. */
export async function readActivity(area: LogArea, now: number): Promise<ActivityEntry[]> {
  const keys = (await area.getKeys()).filter((key) => {
    const batch = parseKey(key);
    return batch !== null && batch.at >= now - LOG_WINDOW_MS;
  });
  if (keys.length === 0) return [];
  const stored = await area.get(keys);
  const entries = Object.values(stored)
    .flatMap((batch) => (Array.isArray(batch) ? (batch as unknown[]) : []))
    .filter(isEntry)
    .filter((e) => e.at >= now - LOG_WINDOW_MS);
  // Stable: entries of the same millisecond keep their order, then the whole list is reversed.
  return entries.sort((a, b) => a.at - b.at).reverse();
}

export async function clearActivity(area: LogArea): Promise<void> {
  const keys = (await area.getKeys()).filter((key) => key.startsWith(KEY_PREFIX));
  if (keys.length > 0) await area.remove(keys);
}

/** Drops credentials and fragments from a URL. The token travels in a header, never here. */
export function cleanUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.href;
  } catch {
    return raw;
  }
}

function sizeOf(body: string): string {
  const bytes = new TextEncoder().encode(body).length;
  return bytes < 1024 ? `${bytes} B sent` : `${(bytes / 1024).toFixed(1)} kB sent`;
}

/**
 * What a request body says about the call: the GraphQL operation and the PR it reads, or how
 * much was sent. Only GraphQL bodies are parsed; the score payload is not.
 */
export function describeBody(body: BodyInit | null | undefined): string | null {
  if (typeof body !== 'string') return null;
  if (!body.startsWith('{"query"')) return sizeOf(body);
  try {
    const parsed = JSON.parse(body) as { query?: unknown; variables?: unknown };
    if (typeof parsed.query !== 'string') return sizeOf(body);
    const operation = /\b(?:query|mutation)\s+(\w+)/.exec(parsed.query)?.[1] ?? 'GraphQL';
    const vars =
      typeof parsed.variables === 'object' && parsed.variables !== null
        ? (parsed.variables as Record<string, unknown>)
        : {};
    const { owner, name, number, after } = vars;
    const pr =
      typeof owner === 'string' && typeof name === 'string' && typeof number === 'number'
        ? ` ${owner}/${name}#${number}`
        : '';
    return `${operation}${pr}${typeof after === 'string' ? ', next page' : ''}`;
  } catch {
    return sizeOf(body);
  }
}

/** Wraps `fetch` so that every call lands in the log, answered or not. */
export function loggingFetch(
  inner: typeof fetch,
  log: ActivityLog,
  now: () => number = Date.now,
): typeof fetch {
  return async (input, init) => {
    const started = now();
    const request = typeof input === 'string' || input instanceof URL ? null : input;
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const url = cleanUrl(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const detail = describeBody(init?.body);
    let response: Response;
    try {
      response = await inner(input, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.call({
        at: started,
        method,
        url,
        detail,
        status: null,
        error: message,
        ms: now() - started,
      });
      throw error;
    }
    // Outside the try: logging must never turn an answered call into a failed one.
    log.call({
      at: started,
      method,
      url,
      detail,
      status: response.status,
      error: null,
      ms: now() - started,
    });
    return response;
  };
}

/** The real `chrome.storage.session`. */
export function chromeSessionArea(): LogArea {
  return {
    getKeys: () => chrome.storage.session.getKeys(),
    get: (keys) => chrome.storage.session.get(keys),
    set: (items) => chrome.storage.session.set(items),
    remove: (keys) => chrome.storage.session.remove(keys),
  };
}

/** One row of the options page's table. */
export interface ActivityRow {
  time: string;
  /** `GET api.github.com/search/issues?q=…`, or the event's message. */
  what: string;
  detail: string | null;
  result: string;
  duration: string;
  failed: boolean;
  event: boolean;
}

/** Host, path and query, decoded so that a search reads as typed. */
export function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    let query = url.search;
    try {
      query = decodeURIComponent(query.replace(/\+/g, ' '));
    } catch {
      // A malformed escape: show it as sent.
    }
    return `${url.host}${url.pathname}${query}`;
  } catch {
    return raw;
  }
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** No answer, or an HTTP error status. A GraphQL error inside a 200 is not seen here. */
function isFailed(entry: CallEntry): boolean {
  return entry.status === null || entry.status >= 400;
}

export function rowOf(entry: ActivityEntry): ActivityRow {
  const time = localTime(entry.at);
  if (entry.kind === 'event') {
    return {
      time,
      what: entry.message,
      detail: null,
      result: '',
      duration: '',
      failed: false,
      event: true,
    };
  }
  return {
    time,
    what: `${entry.method} ${displayUrl(entry.url)}`,
    detail: entry.error ? [entry.detail, entry.error].filter(Boolean).join(' · ') : entry.detail,
    result: entry.status === null ? 'failed' : String(entry.status),
    duration: formatDuration(entry.ms),
    failed: isFailed(entry),
    event: false,
  };
}

/** `14 calls in the last 30 minutes: 12 to api.github.com, 2 to 127.0.0.1:8787.` */
export function summarize(entries: readonly ActivityEntry[]): string {
  const byHost = new Map<string, number>();
  let failures = 0;
  for (const entry of entries) {
    if (entry.kind !== 'call') continue;
    let host: string;
    try {
      host = new URL(entry.url).host;
    } catch {
      host = 'unknown host';
    }
    byHost.set(host, (byHost.get(host) ?? 0) + 1);
    if (isFailed(entry)) failures += 1;
  }
  const calls = [...byHost.values()].reduce((a, b) => a + b, 0);
  if (calls === 0) return 'No calls in the last 30 minutes.';
  const hosts = [...byHost.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([host, n]) => `${n} to ${host}`)
    .join(', ');
  const failed = failures > 0 ? ` ${failures} failed.` : '';
  return `${calls} call${calls === 1 ? '' : 's'} in the last 30 minutes: ${hosts}.${failed}`;
}

/** The log as plain text, oldest first, for pasting into a bug report. */
export function toText(entries: readonly ActivityEntry[]): string {
  return [...entries]
    .reverse()
    .map((entry) => {
      const row = rowOf(entry);
      if (row.event) return `${row.time}  — ${row.what}`;
      const detail = row.detail ? `  (${row.detail})` : '';
      return `${row.time}  ${row.what}  → ${row.result} in ${row.duration}${detail}`;
    })
    .join('\n');
}
