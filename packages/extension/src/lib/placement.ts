/**
 * Where the badge last went on github.com, for the options page. Kept in session storage next to
 * the activity log; a change of placement is also logged there.
 */
import type { ActivityLog, LogArea } from './activity-log.ts';
import { MAX_HEADER_TEXT, type Placement } from './messages.ts';

const KEY = 'badgePlacement';

export interface PlacementReport {
  placement: Placement;
  /** The header structure the content script saw, when the badge floats. */
  header: string;
  /** When it was reported, in ms since the epoch. */
  at: number;
}

function coerce(raw: unknown): PlacementReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['placement'] !== 'header' && r['placement'] !== 'floating') return null;
  if (typeof r['header'] !== 'string' || typeof r['at'] !== 'number') return null;
  return { placement: r['placement'], header: r['header'].slice(0, MAX_HEADER_TEXT), at: r['at'] };
}

export async function readPlacement(area: LogArea): Promise<PlacementReport | null> {
  const stored = await area.get([KEY]);
  return coerce(stored[KEY]);
}

export function describePlacement(placement: Placement): string {
  return placement === 'header'
    ? 'badge shown in the GitHub header'
    : "badge shown in the bottom-right corner: GitHub's header was not found";
}

/** Stores the latest report, and logs it when the placement or the header seen changed. */
export async function recordPlacement(
  area: LogArea,
  log: ActivityLog,
  report: PlacementReport,
): Promise<void> {
  const previous = await readPlacement(area);
  await area.set({ [KEY]: report });
  if (previous?.placement !== report.placement || previous.header !== report.header) {
    log.event(describePlacement(report.placement));
  }
}

export async function clearPlacement(area: LogArea): Promise<void> {
  await area.remove([KEY]);
}
