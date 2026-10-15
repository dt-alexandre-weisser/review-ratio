/**
 * Typed access to `chrome.storage.local`. Everything the extension remembers lives here:
 * settings, the cached badge, the class globs, the random PR keys and the Viewed snapshots.
 */
import type { FileClass, LinesByClassV1, ScoreResponseV1 } from '@review-ratio/contract';

import { coerceSettings, type Settings } from './settings.ts';

export type BadgeStatus =
  /** The last refresh succeeded. */
  | 'ok'
  /** The server could not be reached or answered an error. The score, if any, is old. */
  | 'stale'
  /** The server retired our contract major. */
  | 'upgrade_required'
  /** No token configured yet. */
  | 'no_token'
  /** GitHub rejected the token. */
  | 'bad_token';

export interface BadgeCache {
  status: BadgeStatus;
  /** Last score received from the server, kept through failures. */
  score: ScoreResponseV1 | null;
  /** When `score` was received. */
  scoredAt: number | null;
  /** When a refresh was last attempted, successful or not. */
  attemptedAt: number | null;
  /** When a refresh was last started. A stale value means a worker died mid-refresh. */
  refreshStartedAt: number | null;
  /** Short description of the last failure, for the tooltip and the options page. */
  error: string | null;
}

export const EMPTY_CACHE: Readonly<BadgeCache> = Object.freeze({
  status: 'no_token',
  score: null,
  scoredAt: null,
  attemptedAt: null,
  refreshStartedAt: null,
  error: null,
});

export interface PublishedClass {
  name: FileClass;
  globs: string[];
}

export interface ClassesCache {
  classes: PublishedClass[];
  fetchedAt: number;
}

/** Snapshot of the files I had marked Viewed when a review's commit was still the PR head. */
export interface ViewedSnapshot {
  linesByClass: LinesByClassV1;
  takenAt: number;
}

export interface StorageShape {
  settings: Settings;
  badge: BadgeCache;
  classes: ClassesCache | null;
  /** Random key per PR I own, keyed by `owner/repo#number`. Never leaves the browser. */
  prKeys: Record<string, string>;
  /** Viewed snapshots keyed by review node id. */
  viewedSnapshots: Record<string, ViewedSnapshot>;
}

/** The subset of `chrome.storage.local` the extension uses. Injected for tests. */
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export class Store {
  constructor(private readonly area: StorageArea) {}

  async getSettings(): Promise<Settings> {
    const { settings } = await this.area.get(['settings']);
    return coerceSettings(settings);
  }

  async setSettings(settings: Settings): Promise<void> {
    await this.area.set({ settings: coerceSettings(settings) });
  }

  async getBadge(): Promise<BadgeCache> {
    const { badge } = await this.area.get(['badge']);
    return { ...EMPTY_CACHE, ...(isRecord(badge) ? (badge as Partial<BadgeCache>) : {}) };
  }

  async setBadge(badge: BadgeCache): Promise<void> {
    await this.area.set({ badge });
  }

  async updateBadge(patch: Partial<BadgeCache>): Promise<BadgeCache> {
    const next = { ...(await this.getBadge()), ...patch };
    await this.setBadge(next);
    return next;
  }

  async getClasses(): Promise<ClassesCache | null> {
    const { classes } = await this.area.get(['classes']);
    return isRecord(classes) && Array.isArray(classes['classes'])
      ? (classes as unknown as ClassesCache)
      : null;
  }

  async setClasses(classes: ClassesCache): Promise<void> {
    await this.area.set({ classes });
  }

  async getPrKeys(): Promise<Record<string, string>> {
    const { prKeys } = await this.area.get(['prKeys']);
    return isRecord(prKeys) ? (prKeys as Record<string, string>) : {};
  }

  async setPrKeys(prKeys: Record<string, string>): Promise<void> {
    await this.area.set({ prKeys });
  }

  async getViewedSnapshots(): Promise<Record<string, ViewedSnapshot>> {
    const { viewedSnapshots } = await this.area.get(['viewedSnapshots']);
    return isRecord(viewedSnapshots) ? (viewedSnapshots as Record<string, ViewedSnapshot>) : {};
  }

  async setViewedSnapshots(snapshots: Record<string, ViewedSnapshot>): Promise<void> {
    await this.area.set({ viewedSnapshots: snapshots });
  }

  /** Forgets everything but the settings. */
  async clearActivity(): Promise<void> {
    await this.area.remove(['badge', 'classes', 'prKeys', 'viewedSnapshots']);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The real `chrome.storage.local`, wrapped in promises. */
export function chromeStorageArea(): StorageArea {
  return {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys),
  };
}
