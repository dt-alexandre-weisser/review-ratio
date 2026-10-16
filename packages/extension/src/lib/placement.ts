/**
 * Where the badge last went on github.com, for the options page. Kept in session storage next to
 * the activity log. The last report of a floating badge is kept apart: another tab where the
 * badge found the header must not hide the header structure needed to fix the placement.
 */
import type { ActivityLog, LogArea } from './activity-log.ts';
import { MAX_HEADER_TEXT, type Placement } from './messages.ts';

const KEY = 'badgePlacement';
/** At most one placement line in the activity log per interval, whatever the tabs report. */
export const LOG_EVERY_MS = 10_000;

export interface PlacementReport {
  placement: Placement;
  /** What the content script saw of the header, when the badge floats. */
  header: string;
  /** When it was reported, in ms since the epoch. */
  at: number;
}

export interface PlacementState {
  latest: PlacementReport;
  lastFloating: PlacementReport | null;
  /** When a placement line was last logged. */
  loggedAt: number | null;
}

function coerceReport(raw: unknown): PlacementReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['placement'] !== 'header' && r['placement'] !== 'floating') return null;
  if (typeof r['header'] !== 'string' || typeof r['at'] !== 'number') return null;
  return { placement: r['placement'], header: r['header'].slice(0, MAX_HEADER_TEXT), at: r['at'] };
}

export async function readPlacement(area: LogArea): Promise<PlacementState | null> {
  const { [KEY]: raw } = await area.get([KEY]);
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const latest = coerceReport(r['latest']);
  if (!latest) return null;
  return {
    latest,
    lastFloating: coerceReport(r['lastFloating']),
    loggedAt: typeof r['loggedAt'] === 'number' ? r['loggedAt'] : null,
  };
}

export function describePlacement(placement: Placement): string {
  return placement === 'header'
    ? 'badge shown in the GitHub header'
    : "badge shown in the bottom-right corner: no place found in GitHub's header";
}

/**
 * Stores a report and logs a change of placement, or of the header seen while floating. Callers
 * serialise calls: this reads, then writes.
 */
export async function recordPlacement(
  area: LogArea,
  log: ActivityLog,
  report: PlacementReport,
): Promise<void> {
  const previous = await readPlacement(area);
  const changed =
    previous?.latest.placement !== report.placement ||
    (report.placement === 'floating' && previous.latest.header !== report.header);
  const lastLogged = previous?.loggedAt ?? null;
  const recent =
    lastLogged !== null && report.at >= lastLogged && report.at - lastLogged < LOG_EVERY_MS;
  const logged = changed && !recent;
  if (logged) log.event(describePlacement(report.placement));
  const state: PlacementState = {
    latest: report,
    lastFloating: report.placement === 'floating' ? report : (previous?.lastFloating ?? null),
    loggedAt: logged ? report.at : lastLogged,
  };
  await area.set({ [KEY]: state });
}

export async function clearPlacement(area: LogArea): Promise<void> {
  await area.remove([KEY]);
}
