import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';
import { EMPTY_CACHE, Store } from '../src/lib/storage.ts';
import { memoryStorage } from './helpers/memory-storage.ts';

describe('Store', () => {
  it('returns defaults on an empty storage', async () => {
    const store = new Store(memoryStorage());
    expect(await store.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await store.getBadge()).toEqual(EMPTY_CACHE);
    expect(await store.getClasses()).toBeNull();
    expect(await store.getPrKeys()).toEqual({});
    expect(await store.getViewedSnapshots()).toEqual({});
  });

  it('round-trips every key', async () => {
    const store = new Store(memoryStorage());
    await store.setSettings({ ...DEFAULT_SETTINGS, token: 'abc' });
    expect((await store.getSettings()).token).toBe('abc');
    const badge = await store.updateBadge({ status: 'ok', score: { up: 1, down: 2, ratio: 0.5 } });
    expect(badge.score).toEqual({ up: 1, down: 2, ratio: 0.5 });
    expect((await store.getBadge()).status).toBe('ok');
    await store.setClasses({ classes: [{ name: 'docs', globs: ['**/*.md'] }], fetchedAt: 1 });
    expect((await store.getClasses())?.fetchedAt).toBe(1);
    await store.setPrKeys({ 'a/b#1': 'k' });
    expect(await store.getPrKeys()).toEqual({ 'a/b#1': 'k' });
    await store.setViewedSnapshots({ r1: { linesByClass: { production: 10 }, takenAt: 1 } });
    expect(Object.keys(await store.getViewedSnapshots())).toEqual(['r1']);
  });

  it('ignores corrupted values', async () => {
    const store = new Store(
      memoryStorage({ badge: [1], classes: { classes: 'x' }, prKeys: 'x', viewedSnapshots: null }),
    );
    expect(await store.getBadge()).toEqual(EMPTY_CACHE);
    expect(await store.getClasses()).toBeNull();
    expect(await store.getPrKeys()).toEqual({});
    expect(await store.getViewedSnapshots()).toEqual({});
  });

  it('forgets activity but keeps settings', async () => {
    const area = memoryStorage();
    const store = new Store(area);
    await store.setSettings({ ...DEFAULT_SETTINGS, token: 'abc' });
    await store.setPrKeys({ x: 'y' });
    await store.updateBadge({ status: 'ok' });
    await store.clearActivity();
    expect(Object.keys(area.data)).toEqual(['settings']);
  });
});
