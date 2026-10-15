/**
 * The badge element in the github.com header. DOM only; no fetching here.
 */
import type { BadgeView } from '../lib/badge-state.ts';

export const BADGE_ID = 'review-ratio-badge';

/** Where the badge goes, in order of preference. The first container found wins. */
const SLOT_SELECTORS = [
  '.AppHeader-globalBar-end',
  'header .AppHeader-actions',
  'header[role="banner"]',
  'header',
];

export function findSlot(doc: Document): Element | null {
  for (const selector of SLOT_SELECTORS) {
    const el = doc.querySelector(selector);
    if (el) return el;
  }
  return null;
}

export function render(el: HTMLElement, view: BadgeView): void {
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

/** Creates the badge or updates it in place. Returns `null` when the header is not there. */
export function mount(doc: Document, view: BadgeView): HTMLElement | null {
  let el = doc.getElementById(BADGE_ID);
  if (!el) {
    const slot = findSlot(doc);
    if (!slot) return null;
    el = doc.createElement('span');
    el.id = BADGE_ID;
    el.className = 'review-ratio-badge';
    el.setAttribute('role', 'status');
    slot.prepend(el);
  }
  render(el, view);
  return el;
}
