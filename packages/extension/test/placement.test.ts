import { describe, expect, it } from 'vitest';

import { ActivityLog, readActivity } from '../src/lib/activity-log.ts';
import {
  LOG_EVERY_MS,
  clearPlacement,
  describePlacement,
  readPlacement,
  recordPlacement,
} from '../src/lib/placement.ts';
import { NOW } from './helpers/github.ts';
import { memoryStorage } from './helpers/memory-storage.ts';

function setup() {
  const area = memoryStorage();
  const log = new ActivityLog(area, { now: () => NOW });
  const events = async () => {
    await log.flush();
    return (await readActivity(area, NOW + LOG_WINDOW))
      .map((e) => (e.kind === 'event' ? e.message : ''))
      .reverse();
  };
  return { area, log, events };
}
const LOG_WINDOW = 60_000;

const FLOATING = describePlacement('floating');
const HEADER = describePlacement('header');

describe('badge placement', () => {
  it('is unknown until a page reports it', async () => {
    const { area } = setup();
    expect(await readPlacement(area)).toBeNull();
  });

  it('keeps the latest report, and the last floating one apart', async () => {
    const { area, log } = setup();
    const floating = { placement: 'floating' as const, header: 'header:\n  header', at: NOW };
    await recordPlacement(area, log, floating);
    const inHeader = { placement: 'header' as const, header: '', at: NOW + 1 };
    await recordPlacement(area, log, inHeader);
    expect(await readPlacement(area)).toMatchObject({ latest: inHeader, lastFloating: floating });
  });

  it('logs a change of placement once, at most once per interval', async () => {
    const { area, log, events } = setup();
    const at = (ms: number) => NOW + ms;
    await recordPlacement(area, log, { placement: 'floating', header: 'a', at: at(0) });
    await recordPlacement(area, log, { placement: 'floating', header: 'a', at: at(1) });
    // A change within the interval is stored but not logged.
    await recordPlacement(area, log, { placement: 'header', header: '', at: at(2) });
    expect((await readPlacement(area))?.latest.placement).toBe('header');
    await recordPlacement(area, log, { placement: 'floating', header: 'a', at: at(LOG_EVERY_MS) });
    await recordPlacement(area, log, {
      placement: 'floating',
      header: 'b',
      at: at(2 * LOG_EVERY_MS),
    });
    await recordPlacement(area, log, { placement: 'header', header: '', at: at(3 * LOG_EVERY_MS) });
    await recordPlacement(area, log, { placement: 'header', header: '', at: at(4 * LOG_EVERY_MS) });
    expect(await events()).toEqual([FLOATING, FLOATING, FLOATING, HEADER]);
  });

  it('ignores a malformed stored value, and clears', async () => {
    const { area } = setup();
    for (const bad of [
      'header',
      { latest: 'header' },
      { latest: { placement: 'sidebar', header: '', at: NOW } },
      { latest: { placement: 'header', header: 1, at: NOW } },
      { latest: { placement: 'header', header: '', at: 'now' } },
    ]) {
      area.data['badgePlacement'] = bad;
      expect(await readPlacement(area)).toBeNull();
    }
    area.data['badgePlacement'] = {
      latest: { placement: 'floating', header: 'x'.repeat(5000), at: NOW },
      lastFloating: 'bad',
      loggedAt: 'bad',
    };
    expect(await readPlacement(area)).toMatchObject({ lastFloating: null, loggedAt: null });
    expect((await readPlacement(area))?.latest.header).toHaveLength(2000);
    await clearPlacement(area);
    expect(area.data['badgePlacement']).toBeUndefined();
  });
});
