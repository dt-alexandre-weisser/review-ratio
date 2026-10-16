/**
 * The badge element in the github.com header. DOM only; no fetching here.
 *
 * GitHub changes its header markup without notice. When none of the known containers is on the
 * page, the badge floats in the bottom-right corner instead of disappearing, and the content
 * script reports the header it saw so the selectors can be fixed.
 */
import type { BadgeView } from '../lib/badge-state.ts';
import { MAX_HEADER_TEXT, type Placement } from '../lib/messages.ts';

export const BADGE_ID = 'review-ratio-badge';

/**
 * Where the badge goes, in order of preference. GitHub's own header containers only: a bare
 * `header` would match unrelated page content.
 */
const SLOT_SELECTORS = ['.AppHeader-globalBar-end', '.AppHeader-actions'];

/** The view last rendered into each badge element, to skip identical re-renders. */
const rendered = new WeakMap<Element, string>();

/** A container GitHub hides (for example at a narrow width) cannot show the badge. */
function isShown(el: Element): boolean {
  // `checkVisibility` is in Chrome since 105; test DOMs may lack it.
  return typeof el.checkVisibility !== 'function' || el.checkVisibility();
}

export function findSlot(doc: Document): Element | null {
  for (const selector of SLOT_SELECTORS) {
    const el = doc.querySelector(selector);
    if (el && isShown(el)) return el;
  }
  return null;
}

export function render(el: HTMLElement, view: BadgeView): void {
  const key = JSON.stringify(view);
  if (rendered.get(el) === key) return;
  rendered.set(el, key);

  let full = el.querySelector<HTMLElement>('.review-ratio-full');
  let short = el.querySelector<HTMLElement>('.review-ratio-short');
  if (!full || !short) {
    el.replaceChildren();
    full = el.ownerDocument.createElement('span');
    full.className = 'review-ratio-full';
    short = el.ownerDocument.createElement('span');
    short.className = 'review-ratio-short';
    el.append(full, short);
  }
  full.textContent = view.text;
  short.textContent = view.short;
  el.title = view.tooltip;
  el.setAttribute('aria-label', `review ratio: ${view.text}. ${view.tooltip}`);
  el.dataset['tone'] = view.tone;
  el.dataset['stale'] = view.stale ? 'true' : 'false';
}

export interface MountOptions {
  /**
   * Float the badge when the header is not found. The content script waits a few seconds first:
   * GitHub may render its header after the script runs.
   */
  allowFloating?: boolean;
}

export interface Mounted {
  el: HTMLElement;
  placement: Placement;
}

/**
 * Creates the badge or updates it in place, in the header when it can, floating otherwise.
 * Returns `null` when the badge is not on the page.
 */
export function mount(doc: Document, view: BadgeView, options: MountOptions = {}): Mounted | null {
  const slot = findSlot(doc);
  let el = doc.getElementById(BADGE_ID);
  if (!el) {
    if (!slot && !options.allowFloating) return null;
    el = doc.createElement('span');
    el.id = BADGE_ID;
    el.className = 'review-ratio-badge';
    // A plain labelled element, not a live region: screen readers are not interrupted by it.
  }
  // Written only when it changes: the remount every few seconds must not touch GitHub's DOM.
  const place = (badge: HTMLElement, placement: Placement) => {
    if (badge.dataset['placement'] !== placement) badge.dataset['placement'] = placement;
  };
  if (slot) {
    // First in the slot; also moves a floating badge in once the header shows up.
    if (el.parentElement !== slot) slot.prepend(el);
    place(el, 'header');
  } else if (options.allowFloating) {
    if (el.parentElement !== doc.body) doc.body.append(el);
    place(el, 'floating');
  } else if (!el.isConnected) {
    return null;
  }
  render(el, view);
  return { el, placement: el.dataset['placement'] === 'floating' ? 'floating' : 'header' };
}

const MAX_HEADER_NODES = 40;
const MAX_HEADER_DEPTH = 5;

/**
 * The structure of the page's top header: tag names, ids and classes, no text and no links. Sent
 * to the options page when the badge floats, so the selectors can be fixed from it.
 */
export function describeHeader(doc: Document): string {
  const header = doc.querySelector('header, [role="banner"]');
  if (!header) return 'no <header> or role="banner" element on the page';
  const lines: string[] = [];
  const walk = (el: Element, depth: number) => {
    if (lines.length >= MAX_HEADER_NODES || depth > MAX_HEADER_DEPTH) return;
    if (el.id === BADGE_ID) return;
    const id = el.id ? `#${el.id}` : '';
    const classes = [...el.classList]
      .slice(0, 4)
      .map((c) => `.${c}`)
      .join('');
    lines.push(`${'  '.repeat(depth)}${el.tagName.toLowerCase()}${id}${classes}`);
    for (const child of el.children) walk(child, depth + 1);
  };
  walk(header, 0);
  return lines.join('\n').slice(0, MAX_HEADER_TEXT);
}
