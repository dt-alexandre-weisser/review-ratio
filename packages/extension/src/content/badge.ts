/**
 * The badge element in the github.com header. DOM only; no fetching here.
 */
import type { BadgeView } from '../lib/badge-state.ts';

export const BADGE_ID = 'review-ratio-badge';

/**
 * Where the badge goes, in order of preference. GitHub's own header containers only: a bare
 * `header` would match unrelated page content.
 */
const SLOT_SELECTORS = ['.AppHeader-globalBar-end', '.AppHeader-actions'];

/** The view last rendered into each badge element, to skip identical re-renders. */
const rendered = new WeakMap<Element, string>();

export function findSlot(doc: Document): Element | null {
  for (const selector of SLOT_SELECTORS) {
    const el = doc.querySelector(selector);
    if (el) return el;
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

/** Creates the badge or updates it in place. Returns `null` when the header is not there. */
export function mount(doc: Document, view: BadgeView): HTMLElement | null {
  let el = doc.getElementById(BADGE_ID);
  if (!el) {
    const slot = findSlot(doc);
    if (!slot) return null;
    el = doc.createElement('span');
    el.id = BADGE_ID;
    el.className = 'review-ratio-badge';
    // A plain labelled element, not a live region: screen readers are not interrupted by it.
    slot.prepend(el);
  }
  render(el, view);
  return el;
}
