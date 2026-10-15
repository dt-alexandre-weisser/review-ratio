/** User settings, edited in the options page and stored in `chrome.storage.local`. */
export interface Settings {
  /** Fine-grained PAT, read-only. Empty until the developer pastes one. */
  token: string;
  /** The GitHub organisation whose repositories count. */
  org: string;
  /** Repositories to ignore, as `owner/name` or `name` (within `org`). Case-insensitive. */
  excludedRepos: string[];
  /** Base URL of the review-ratio server, without a trailing slash. */
  serverUrl: string;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  token: '',
  org: 'DiliTrust',
  excludedRepos: [],
  serverUrl: 'http://127.0.0.1:8787',
});

/** Parses the exclude list textarea: one repository per line, blank lines and `#` comments ignored. */
export function parseExcludeList(text: string): string[] {
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    seen.add(line.toLowerCase());
  }
  return [...seen];
}

export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed || DEFAULT_SETTINGS.serverUrl;
}

/** Whether a repository full name is excluded by the settings. */
export function isExcludedRepo(
  settings: Pick<Settings, 'org' | 'excludedRepos'>,
  fullName: string,
): boolean {
  const lower = fullName.toLowerCase();
  const org = settings.org.toLowerCase();
  for (const entry of settings.excludedRepos) {
    const e = entry.toLowerCase();
    if (e === lower) return true;
    if (!e.includes('/') && lower === `${org}/${e}`) return true;
  }
  return false;
}

/** Merges stored values with the defaults, dropping anything of the wrong shape. */
export function coerceSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    token: typeof r['token'] === 'string' ? r['token'].trim() : DEFAULT_SETTINGS.token,
    org: typeof r['org'] === 'string' && r['org'].trim() ? r['org'].trim() : DEFAULT_SETTINGS.org,
    excludedRepos: Array.isArray(r['excludedRepos'])
      ? r['excludedRepos']
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.toLowerCase())
      : [...DEFAULT_SETTINGS.excludedRepos],
    serverUrl:
      typeof r['serverUrl'] === 'string'
        ? normalizeServerUrl(r['serverUrl'])
        : DEFAULT_SETTINGS.serverUrl,
  };
}
