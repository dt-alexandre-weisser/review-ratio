// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  cssString,
  hidePlaceholder,
  rememberGap,
  showPlaceholder,
} from '../../src/content/placeholder.ts';
import type { BadgeView } from '../../src/lib/badge-state.ts';

const view: BadgeView = {
  text: '↑ 11,759 RP · ↓ 8,779 RP | Ratio 1.34',
  short: 'Ratio 1.34',
  parts: { up: '↑ 11,759 RP', down: '↓ 8,779 RP', ratio: 'Ratio 1.34' },
  tone: 'good',
  stale: false,
  tooltip: 'review-ratio (given / asked), last 7 days',
};

const root = () => document.documentElement;
const prop = (name: string) => root().style.getPropertyValue(name);

beforeEach(() => {
  hidePlaceholder(document);
  root().removeAttribute('style');
});

describe('the stand-in', () => {
  it('writes the text, the colour stops and the tone on <html>', () => {
    showPlaceholder(document, view);
    expect(root().hasAttribute('data-review-ratio-placeholder')).toBe(true);
    expect(prop('--review-ratio-text')).toBe('"↑ 11,759 RP · ↓ 8,779 RP | Ratio 1.34"');
    expect(prop('--review-ratio-short')).toBe('"Ratio 1.34"');
    // Stops in the middle of the spaces around the separators.
    expect([prop('--review-ratio-a'), prop('--review-ratio-b')]).toEqual(['11.5ch', '13.5ch']);
    expect([prop('--review-ratio-c'), prop('--review-ratio-d')]).toEqual(['24.5ch', '26.5ch']);
    expect(root().dataset['reviewRatioColors']).toBe('');
    expect(root().dataset['reviewRatioTone']).toBe('good');
    expect(root().dataset['reviewRatioStale']).toBe('false');

    hidePlaceholder(document);
    expect(root().hasAttribute('data-review-ratio-placeholder')).toBe(false);
    hidePlaceholder(document);
  });

  it('shows plain text without parts, and rewrites only when the view changes', () => {
    showPlaceholder(document, view);
    showPlaceholder(document, {
      ...view,
      parts: null,
      text: 'review-ratio: set up',
      tone: 'neutral',
    });
    expect(prop('--review-ratio-text')).toBe('"review-ratio: set up"');
    expect(root().dataset['reviewRatioColors']).toBeUndefined();
    root().style.setProperty('--review-ratio-text', '"tampered"');
    showPlaceholder(document, {
      ...view,
      parts: null,
      text: 'review-ratio: set up',
      tone: 'neutral',
    });
    expect(prop('--review-ratio-text')).toBe('"tampered"');
  });

  it('escapes CSS strings', () => {
    expect(cssString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\a d"');
  });

  it('remembers the gap before the search group only', () => {
    document.body.innerHTML =
      '<div><span id="b"></span><div class="Search-module__searchButtonGroup__x" id="g"></div><i id="o"></i></div>';
    const badge = document.getElementById('b')!;
    const group = document.getElementById('g')!;
    badge.getBoundingClientRect = () => ({ right: 100 }) as DOMRect;
    group.getBoundingClientRect = () => ({ left: 116 }) as DOMRect;
    rememberGap(document, badge);
    expect(prop('--review-ratio-gap')).toBe('16px');
    group.getBoundingClientRect = () => ({ left: 400 }) as DOMRect;
    rememberGap(document, badge);
    expect(prop('--review-ratio-gap')).toBe('16px');
    document.getElementById('o')!.before(badge);
    rememberGap(document, badge);
    expect(prop('--review-ratio-gap')).toBe('16px');
  });
});
