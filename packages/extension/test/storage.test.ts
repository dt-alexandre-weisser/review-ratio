import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';
import {
  EMPTY_CACHE,
  STORAGE_VERSION,
  Store,
  coerceBadge,
  isLinesByClass,
} from '../src/lib/storage.ts';
import { memoryStorage } from './helpers/memory-storage.ts';

const KEY = '0f6f9a1e-5a7d-4c1b-9d2e-2b1d8c3f4a5b';

describe('Store', () => {
  it('returns defaults on an empty storage', async () => {
    const store = new Store(memoryStorage());
    expect(await store.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await store.getBadge()).toEqual(EMPTY_CACHE);
    expect(await store.getPrKeys()).toEqual({});
    expect(await store.getViewedSnapshots()).toEqual({});
    expect(await store.getCompareCache()).toEqual({});
  });

  it('round-trips every key', async () => {
    const store = new Store(memoryStorage());
    await store.setSettings({ ...DEFAULT_SETTINGS, token: 'abc' });
    expect((await store.getSettings()).token).toBe('abc');
    const badge = await store.updateBadge({ status: 'ok', score: { up: 1, down: 2, ratio: 0.5 } });
    expect(badge.score).toEqual({ up: 1, down: 2, ratio: 0.5 });
    expect((await store.getBadge()).status).toBe('ok');
    await store.setPrKeys({ 'a/b#1': KEY });
    expect(await store.getPrKeys()).toEqual({ 'a/b#1': KEY });
    await store.setViewedSnapshots({ r1: { linesByClass: { production: 10 }, takenAt: 1 } });
    expect(Object.keys(await store.getViewedSnapshots())).toEqual(['r1']);
    await store.setCompareCache({ 'a/b:x...y': [{ filename: 'f.ts', changes: 3 }] });
    expect(await store.getCompareCache()).toEqual({
      'a/b:x...y': [{ filename: 'f.ts', changes: 3 }],
    });
  });

  it('drops corrupted or foreign values instead of breaking refreshes', async () => {
    const store = new Store(
      memoryStorage({
        badge: [1],
        prKeys: { ok: KEY, bad: 'DiliTrust/app#1', worse: 3 },
        viewedSnapshots: {
          ok: { linesByClass: { test: 20 }, takenAt: 1 },
          badClass: { linesByClass: { ts: 20 }, takenAt: 1 },
          badCount: { linesByClass: { test: -1 }, takenAt: 1 },
          noTime: { linesByClass: {} },
        },
        compareCache: { ok: [{ filename: 'a', changes: 1 }], bad: [{ filename: 1 }], worse: 'x' },
      }),
    );
    expect(await store.getBadge()).toEqual(EMPTY_CACHE);
    expect(await store.getPrKeys()).toEqual({ ok: KEY });
    expect(Object.keys(await store.getViewedSnapshots())).toEqual(['ok']);
    expect(Object.keys(await store.getCompareCache())).toEqual(['ok']);
  });

  it('forgets activity written by another storage layout, keeping the settings', async () => {
    const area = memoryStorage({
      settings: { token: 'abc' },
      prKeys: { x: KEY },
      classes: { old: true },
    });
    const store = new Store(area);
    await store.migrate();
    expect(Object.keys(area.data).sort()).toEqual(['settings', 'storageVersion']);
    expect(area.data['storageVersion']).toBe(STORAGE_VERSION);
    await store.setPrKeys({ x: KEY });
    await store.migrate();
    expect(await store.getPrKeys()).toEqual({ x: KEY });
  });

  it('forgets activity but keeps settings', async () => {
    const area = memoryStorage();
    const store = new Store(area);
    await store.setSettings({ ...DEFAULT_SETTINGS, token: 'abc' });
    await store.setPrKeys({ x: KEY });
    await store.updateBadge({ status: 'ok' });
    await store.clearActivity();
    expect(Object.keys(area.data)).toEqual(['settings']);
  });
});

describe('coerceBadge', () => {
  it('keeps valid fields and replaces invalid ones', () => {
    expect(
      coerceBadge({
        status: 'nope',
        score: { up: 'x' },
        scoredAt: 'yesterday',
        notBefore: 5,
        error: 3,
      }),
    ).toEqual({ ...EMPTY_CACHE, notBefore: 5 });
    expect(
      coerceBadge({ status: 'github_error', score: { up: 1, down: 0, ratio: null } }),
    ).toMatchObject({
      status: 'github_error',
      score: { up: 1, down: 0, ratio: null },
    });
  });
});

describe('isLinesByClass', () => {
  it('accepts known classes with counts only', () => {
    expect(isLinesByClass({ production: 1, test: 0 })).toBe(true);
    expect(isLinesByClass({ constructor: 1 })).toBe(false);
    expect(isLinesByClass({ production: Number.NaN })).toBe(false);
    expect(isLinesByClass([])).toBe(false);
  });
});
