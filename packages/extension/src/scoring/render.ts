/**
 * Fills the scoring page from the constants the formula runs on. The page's HTML holds the prose
 * only: every number, weight and glob comes from here, so the page cannot drift from the code.
 */
import { CLASS_GLOBS, type FileClass } from '../lib/scoring/classes.ts';
import {
  ACTION_WEIGHTS,
  CLASS_WEIGHTS,
  DAY_HOURS,
  PARAMETERS,
  RATIO_DECIMALS,
  WINDOW_HOURS,
} from '../lib/scoring/formula.ts';
import type { ReviewAction } from '../lib/scoring/model.ts';
import { MAX_DOWN_RECORDS, MAX_UP_RECORDS } from '../lib/scoring/records.ts';
import { LINES_GRANULARITY } from '../lib/scoring/rounding.ts';

/** The default class: a path that matches no glob. */
export const DEFAULT_CLASS: FileClass = 'production';

export const ACTION_LABELS: Readonly<Record<ReviewAction, string>> = {
  approve: 'Approve',
  request_changes: 'Request changes',
  comment: 'Comment-only review',
  thread_reply: 'Thread reply without a review',
};

export function formatNumber(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

const [firstTier] = PARAMETERS.sizeTiers;

/** The value of every `data-value` slot of scoring.html. */
export const VALUES: Readonly<Record<string, string>> = {
  windowDays: formatNumber(WINDOW_HOURS / DAY_HOURS),
  windowHours: formatNumber(WINDOW_HOURS),
  decayFullHours: formatNumber(PARAMETERS.decayFullHours),
  decayFloor: formatNumber(PARAMETERS.decayFloor),
  futureToleranceHours: formatNumber(PARAMETERS.futureToleranceHours),
  commentMultiplier: formatNumber(PARAMETERS.commentMultiplier),
  commentRangeCap: formatNumber(PARAMETERS.commentRangeCap),
  viewedBonus: formatNumber(PARAMETERS.viewedBonus),
  rescueMultiplier: formatNumber(PARAMETERS.rescueMultiplier),
  rescueAfterHours: formatNumber(PARAMETERS.rescueAfterHours),
  firstTierLines: formatNumber(firstTier.upTo),
  linesGranularity: formatNumber(LINES_GRANULARITY),
  ratioDecimals: formatNumber(RATIO_DECIMALS),
  maxUpRecords: formatNumber(MAX_UP_RECORDS),
  maxDownRecords: formatNumber(MAX_DOWN_RECORDS),
  defaultClass: DEFAULT_CLASS,
};

/** The rows of the size tiers table: the range of weighted lines, and what each line counts. */
export function sizeTierRows(): [string, string][] {
  let floor = 0;
  return PARAMETERS.sizeTiers.map((tier) => {
    const range =
      tier.upTo === Number.POSITIVE_INFINITY
        ? `above ${formatNumber(floor)}`
        : `${formatNumber(floor)} to ${formatNumber(tier.upTo)}`;
    floor = tier.upTo;
    return [range, `×${formatNumber(tier.factor)}`];
  });
}

function slot(root: ParentNode, id: string): HTMLElement {
  const node = root.querySelector<HTMLElement>(`#${id}`);
  if (node === null) throw new Error(`#${id} is missing`);
  return node;
}

function fillRows(body: HTMLElement, rows: readonly (readonly string[])[]): void {
  const doc = body.ownerDocument;
  body.replaceChildren(
    ...rows.map((cells) => {
      const tr = doc.createElement('tr');
      for (const text of cells) {
        const td = doc.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    }),
  );
}

function fillGlobs(list: HTMLElement): void {
  const doc = list.ownerDocument;
  const items = CLASS_GLOBS.map(({ name, globs }) => {
    const li = doc.createElement('li');
    li.dataset['class'] = name;
    const head = doc.createElement('strong');
    head.textContent = name;
    const ul = doc.createElement('ul');
    ul.className = 'globs';
    for (const glob of globs) {
      const item = doc.createElement('li');
      const code = doc.createElement('code');
      code.textContent = glob;
      item.append(code);
      ul.append(item);
    }
    li.append(head, ul);
    return li;
  });
  const last = doc.createElement('li');
  last.dataset['class'] = DEFAULT_CLASS;
  const head = doc.createElement('strong');
  head.textContent = DEFAULT_CLASS;
  last.append(head, doc.createTextNode(': every path that matched none of the above.'));
  list.replaceChildren(...items, last);
}

/** Fills every slot and table of the scoring page. Throws on a slot it has no value for. */
export function renderScoring(root: ParentNode): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-value]')) {
    const key = node.dataset['value'] ?? '';
    const value = VALUES[key];
    if (value === undefined) throw new Error(`no value for data-value="${key}"`);
    node.textContent = value;
  }
  fillRows(
    slot(root, 'class-weights'),
    Object.entries(CLASS_WEIGHTS).map(([cls, weight]) => [cls, formatNumber(weight)]),
  );
  fillRows(
    slot(root, 'action-weights'),
    (Object.entries(ACTION_WEIGHTS) as [ReviewAction, number][]).map(([action, weight]) => [
      ACTION_LABELS[action],
      formatNumber(weight),
    ]),
  );
  fillRows(slot(root, 'size-tiers'), sizeTierRows());
  fillGlobs(slot(root, 'class-globs'));
}
