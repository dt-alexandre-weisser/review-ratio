/**
 * How the extension gets its GitHub token: a GitHub App sign-in (device flow), or a fine-grained
 * personal access token pasted in the options page.
 */
export type AuthMode = 'app' | 'pat';

/** User settings, edited in the options page and stored in `chrome.storage.local`. */
export interface Settings {
  /** `pat` for settings saved before the app sign-in existed. */
  authMode: AuthMode;
  /** Fine-grained PAT, read-only. Empty until the developer pastes one, and in app mode. */
  token: string;
  /** The GitHub organisation whose repositories count. */
  org: string;
  /** Repositories to ignore, as `owner/name` or `name` (within `org`). Case-insensitive. */
  excludedRepos: string[];
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  authMode: 'pat',
  token: '',
  org: 'DiliTrust',
  excludedRepos: [],
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
    authMode: r['authMode'] === 'app' ? 'app' : 'pat',
    token: typeof r['token'] === 'string' ? r['token'].trim() : DEFAULT_SETTINGS.token,
    org: typeof r['org'] === 'string' && r['org'].trim() ? r['org'].trim() : DEFAULT_SETTINGS.org,
    excludedRepos: Array.isArray(r['excludedRepos'])
      ? r['excludedRepos']
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.toLowerCase())
      : [...DEFAULT_SETTINGS.excludedRepos],
  };
}

/** GitHub organisation names: letters, digits and single hyphens, 1 to 39 characters. */
export function isValidOrg(org: string): boolean {
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(org);
}
