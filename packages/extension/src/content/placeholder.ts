/**
 * The badge's stand-in while GitHub's React takes over its server-rendered header: CSS only (see
 * content.css), driven by attributes and custom properties on <html>, outside React's tree.
 */
import type { BadgeView } from '../lib/badge-state.ts';

/** The attribute that shows the stand-in. */
const PLACEHOLDER = 'data-review-ratio-placeholder';
/** The view last written, to write <html> only when it changes. */
let written = '';

/** A CSS string literal. */
export function cssString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ')}"`;
}

export function showPlaceholder(doc: Document, view: BadgeView): void {
  const root = doc.documentElement;
  const key = JSON.stringify(view);
  if (written !== key) {
    written = key;
    root.style.setProperty('--review-ratio-text', cssString(view.text));
    root.style.setProperty('--review-ratio-short', cssString(view.short));
    if (view.parts) {
      // Colour stops in the middle of the spaces around " · " and " | ".
      const up = view.parts.up.length;
      const down = up + 3 + view.parts.down.length;
      root.style.setProperty('--review-ratio-a', `${up + 0.5}ch`);
      root.style.setProperty('--review-ratio-b', `${up + 2.5}ch`);
      root.style.setProperty('--review-ratio-c', `${down + 0.5}ch`);
      root.style.setProperty('--review-ratio-d', `${down + 2.5}ch`);
      root.dataset['reviewRatioColors'] = '';
    } else {
      delete root.dataset['reviewRatioColors'];
    }
    root.dataset['reviewRatioTone'] = view.tone;
    root.dataset['reviewRatioStale'] = String(view.stale);
  }
  if (!root.hasAttribute(PLACEHOLDER)) root.setAttribute(PLACEHOLDER, '');
}

export function hidePlaceholder(doc: Document): void {
  if (doc.documentElement.hasAttribute(PLACEHOLDER))
    doc.documentElement.removeAttribute(PLACEHOLDER);
}
