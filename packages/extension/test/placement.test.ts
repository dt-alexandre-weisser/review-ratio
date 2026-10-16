import { describe, expect, it } from 'vitest';

import { ActivityLog, readActivity } from '../src/lib/activity-log.ts';
import {
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
    return (await readActivity(area, NOW)).map((e) => (e.kind === 'event' ? e.message : ''));
  };
  return { area, log, events };
}

describe('badge placement', () => {
  it('is unknown until a page reports it', async () => {
    const { area } = setup();
    expect(await readPlacement(area)).toBeNull();
  });

  it('stores the latest report and logs each change once', async () => {
    const { area, log, events } = setup();
    const floating = { placement: 'floating' as const, header: 'header.New', at: NOW };
    await recordPlacement(area, log, floating);
    await recordPlacement(area, log, { ...floating, at: NOW + 1 });
    expect(await readPlacement(area)).toEqual({ ...floating, at: NOW + 1 });
    expect(await events()).toEqual([describePlacement('floating')]);

    await recordPlacement(area, log, { ...floating, header: 'header.Newer', at: NOW + 2 });
    await recordPlacement(area, log, { placement: 'header', header: '', at: NOW + 3 });
    expect(await events()).toEqual([
      'badge shown in the GitHub header',
      "badge shown in the bottom-right corner: GitHub's header was not found",
      "badge shown in the bottom-right corner: GitHub's header was not found",
    ]);
  });

  it('ignores a malformed stored value, and clears', async () => {
    const { area } = setup();
    for (const bad of [
      'header',
      { placement: 'sidebar', header: '', at: NOW },
      { placement: 'header', header: 1, at: NOW },
      { placement: 'header', header: '', at: 'now' },
    ]) {
      area.data['badgePlacement'] = bad;
      expect(await readPlacement(area)).toBeNull();
    }
    area.data['badgePlacement'] = { placement: 'floating', header: 'x'.repeat(5000), at: NOW };
    expect((await readPlacement(area))?.header).toHaveLength(2000);
    await clearPlacement(area);
    expect(area.data['badgePlacement']).toBeUndefined();
  });
});
