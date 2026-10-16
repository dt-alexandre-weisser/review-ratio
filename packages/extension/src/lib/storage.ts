/**
 * Typed access to `chrome.storage.local`. Everything the extension remembers lives here:
 * settings, the GitHub App sign-in, the cached badge, the random PR keys, the Viewed snapshots
 * and the compare cache.
 *
 * Everything read back is validated: a value written by another build, or corrupted, is dropped
 * instead of breaking every refresh.
 */
import type { AppTokens } from './auth/tokens.ts';
import type { CompareFile } from './github/types.ts';
import { FILE_CLASSES, type LinesByClass } from './scoring/classes.ts';
import type { Score } from './scoring/formula.ts';
import { coerceSettings, type Settings } from './settings.ts';

/** Bump when the shape of stored activity data changes; older data is then forgotten. */
export const STORAGE_VERSION = 2;

export type BadgeStatus =
  /** The last refresh succeeded. */
  | 'ok'
  /** The refresh failed for another reason than GitHub, e.g. the classification budget. */
  | 'stale'
  /** GitHub could not be read: unreachable, rate limited, or a permission is missing. */
  | 'github_error'
  /** No token configured yet. */
  | 'no_token'
  /** GitHub rejected the token. */
  | 'bad_token';

export interface BadgeCache {
  status: BadgeStatus;
  /** Last score computed, kept through failures. */
  score: Score | null;
  /** When `score` was computed. */
  scoredAt: number | null;
  /** When a refresh was last attempted, successful or not. */
  attemptedAt: number | null;
  /** When a refresh was last started. A stale value means a worker died mid-refresh. */
  refreshStartedAt: number | null;
  /** No refresh before this time, e.g. until GitHub's rate limit resets. */
  notBefore: number | null;
  /** Refreshes started since the last one that finished. Above 1, refreshes keep dying. */
  unfinishedRefreshes: number;
  /** Short description of the last failure, for the tooltip and the options page. */
  error: string | null;
}

export const EMPTY_CACHE: Readonly<BadgeCache> = Object.freeze({
  status: 'no_token',
  score: null,
  scoredAt: null,
  attemptedAt: null,
  refreshStartedAt: null,
  notBefore: null,
  unfinishedRefreshes: 0,
  error: null,
});

/** The files of my reviewed range I had marked Viewed, by class. */
export interface ViewedSnapshot {
  linesByClass: LinesByClass;
  takenAt: number;
}

/** The GitHub App sign-in. Like the PAT, it never leaves the browser but for GitHub. */
export interface AppAuth extends AppTokens {
  /** The GitHub login the tokens belong to, for the options page. */
  login: string | null;
}

/** The subset of `chrome.storage.local` the extension uses. Injected for tests. */
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

// 'classes' held the globs older versions fetched from a server: forgotten with the rest.
const ACTIVITY_KEYS = ['badge', 'prKeys', 'viewedSnapshots', 'compareCache', 'classes'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

export function isLinesByClass(value: unknown): value is LinesByClass {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, n]) => (FILE_CLASSES as readonly string[]).includes(key) && isCount(n),
  );
}

function isScore(value: unknown): value is Score {
  return (
    isRecord(value) &&
    isCount(value['up']) &&
    isCount(value['down']) &&
    (value['ratio'] === null || isCount(value['ratio']))
  );
}

const STATUSES: ReadonlySet<string> = new Set<BadgeStatus>([
  'ok',
  'stale',
  'github_error',
  'no_token',
  'bad_token',
]);

export function coerceBadge(raw: unknown): BadgeCache {
  if (!isRecord(raw)) return { ...EMPTY_CACHE };
  const pick = (key: keyof BadgeCache) => (isNullableNumber(raw[key]) ? raw[key] : null);
  return {
    status:
      typeof raw['status'] === 'string' && STATUSES.has(raw['status'])
        ? (raw['status'] as BadgeStatus)
        : EMPTY_CACHE.status,
    score: isScore(raw['score']) ? raw['score'] : null,
    scoredAt: pick('scoredAt'),
    attemptedAt: pick('attemptedAt'),
    refreshStartedAt: pick('refreshStartedAt'),
    notBefore: pick('notBefore'),
    unfinishedRefreshes: isCount(raw['unfinishedRefreshes'])
      ? Math.floor(raw['unfinishedRefreshes'])
      : 0,
    error: typeof raw['error'] === 'string' ? raw['error'] : null,
  };
}

/** Keeps the entries whose value passes `valid`. */
function filterRecord<T>(
  raw: unknown,
  valid: (key: string, value: unknown) => boolean,
): Record<string, T> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => valid(k, v))) as Record<
    string,
    T
  >;
}

function isSnapshot(value: unknown): value is ViewedSnapshot {
  return isRecord(value) && isLinesByClass(value['linesByClass']) && isCount(value['takenAt']);
}

function isAppAuth(value: unknown): value is AppAuth {
  return (
    isRecord(value) &&
    typeof value['accessToken'] === 'string' &&
    value['accessToken'] !== '' &&
    isNullableNumber(value['accessTokenExpiresAt']) &&
    (value['refreshToken'] === null || typeof value['refreshToken'] === 'string') &&
    isNullableNumber(value['refreshTokenExpiresAt']) &&
    (value['login'] === null || typeof value['login'] === 'string')
  );
}

function isCompareFiles(value: unknown): value is CompareFile[] {
  return (
    Array.isArray(value) &&
    value.every((f) => isRecord(f) && typeof f['filename'] === 'string' && isCount(f['changes']))
  );
}

export class Store {
  constructor(private readonly area: StorageArea) {}

  /** Forgets activity data written by an older storage layout. */
  async migrate(): Promise<void> {
    const { storageVersion } = await this.area.get(['storageVersion']);
    if (storageVersion === STORAGE_VERSION) return;
    await this.area.remove(ACTIVITY_KEYS);
    await this.area.set({ storageVersion: STORAGE_VERSION });
  }

  async getSettings(): Promise<Settings> {
    const { settings } = await this.area.get(['settings']);
    return coerceSettings(settings);
  }

  async setSettings(settings: Settings): Promise<void> {
    await this.area.set({ settings: coerceSettings(settings) });
  }

  /** The app sign-in, or `null` when signed out or stored in another shape. */
  async getAppAuth(): Promise<AppAuth | null> {
    const { appAuth } = await this.area.get(['appAuth']);
    return isAppAuth(appAuth) ? appAuth : null;
  }

  async setAppAuth(appAuth: AppAuth): Promise<void> {
    await this.area.set({ appAuth });
  }

  async clearAppAuth(): Promise<void> {
    await this.area.remove(['appAuth']);
  }

  async getBadge(): Promise<BadgeCache> {
    const { badge } = await this.area.get(['badge']);
    return coerceBadge(badge);
  }

  async updateBadge(patch: Partial<BadgeCache>): Promise<BadgeCache> {
    const next = { ...(await this.getBadge()), ...patch };
    await this.area.set({ badge: next });
    return next;
  }

  async getPrKeys(): Promise<Record<string, string>> {
    const { prKeys } = await this.area.get(['prKeys']);
    return filterRecord<string>(prKeys, (_k, v) => typeof v === 'string' && UUID.test(v));
  }

  async setPrKeys(prKeys: Record<string, string>): Promise<void> {
    await this.area.set({ prKeys });
  }

  async getViewedSnapshots(): Promise<Record<string, ViewedSnapshot>> {
    const { viewedSnapshots } = await this.area.get(['viewedSnapshots']);
    return filterRecord<ViewedSnapshot>(viewedSnapshots, (_k, v) => isSnapshot(v));
  }

  async setViewedSnapshots(snapshots: Record<string, ViewedSnapshot>): Promise<void> {
    await this.area.set({ viewedSnapshots: snapshots });
  }

  async getCompareCache(): Promise<Record<string, CompareFile[]>> {
    const { compareCache } = await this.area.get(['compareCache']);
    return filterRecord<CompareFile[]>(compareCache, (_k, v) => isCompareFiles(v));
  }

  async setCompareCache(cache: Record<string, CompareFile[]>): Promise<void> {
    await this.area.set({ compareCache: cache });
  }

  /** Forgets everything but the settings and the sign-in. */
  async clearActivity(): Promise<void> {
    await this.area.remove(ACTIVITY_KEYS);
  }
}

/** The real `chrome.storage.local`, wrapped in promises. */
export function chromeStorageArea(): StorageArea {
  return {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys),
  };
}
