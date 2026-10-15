// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { BADGE_ID, findSlot, mount } from '../../src/content/badge.ts';
import type { BadgeView } from '../../src/lib/badge-state.ts';

const view: BadgeView = {
  text: '↑ 1 RP · ↓ 1 RP | Ratio 1.00',
  short: 'Ratio 1.00',
  tone: 'good',
  stale: false,
  tooltip: 'review-ratio (given / asked), last 7 days',
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('badge DOM', () => {
  it('prefers the GitHub global bar', () => {
    document.body.innerHTML =
      '<header><div class="AppHeader-globalBar-end"><button>x</button></div></header>';
    expect(findSlot(document)?.className).toBe('AppHeader-globalBar-end');
  });

  it('uses GitHub header containers only, never an unrelated header', () => {
    document.body.innerHTML = '<div class="AppHeader-actions" id="a"></div>';
    expect(findSlot(document)?.id).toBe('a');
    document.body.innerHTML = '<article><header id="h"></header></article>';
    expect(findSlot(document)).toBeNull();
    document.body.innerHTML = '<main></main>';
    expect(findSlot(document)).toBeNull();
    expect(mount(document, view)).toBeNull();
  });

  it('mounts once, first in the slot, and updates in place', () => {
    document.body.innerHTML = '<div class="AppHeader-globalBar-end"><button>x</button></div>';
    const el = mount(document, view)!;
    expect(el.id).toBe(BADGE_ID);
    expect(el.parentElement?.firstElementChild).toBe(el);
    expect(el.querySelector('.review-ratio-full')?.textContent).toBe(view.text);
    expect(el.querySelector('.review-ratio-short')?.textContent).toBe(view.short);
    expect(el.title).toBe(view.tooltip);
    expect(el.dataset['tone']).toBe('good');
    expect(el.dataset['stale']).toBe('false');
    // Not a live region: screen readers are not interrupted by refreshes.
    expect(el.getAttribute('role')).toBeNull();
    expect(el.getAttribute('aria-live')).toBeNull();

    const again = mount(document, {
      ...view,
      text: 'update the extension',
      tone: 'neutral',
      stale: true,
    })!;
    expect(again).toBe(el);
    expect(document.querySelectorAll(`#${BADGE_ID}`)).toHaveLength(1);
    expect(el.querySelector('.review-ratio-full')?.textContent).toBe('update the extension');
    expect(el.dataset['stale']).toBe('true');
  });

  it('renders text, never HTML', () => {
    document.body.innerHTML = '<div class="AppHeader-globalBar-end"></div>';
    const el = mount(document, { ...view, text: '<img src=x onerror=alert(1)>' })!;
    expect(el.querySelector('img')).toBeNull();
  });
});

describe('render', () => {
  it('leaves the DOM untouched when the view did not change', () => {
    document.body.innerHTML = '<div class="AppHeader-globalBar-end"></div>';
    const el = mount(document, view)!;
    const full = el.querySelector('.review-ratio-full')!;
    let mutations = 0;
    const observer = new MutationObserver((records) => (mutations += records.length));
    observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    mount(document, { ...view });
    mount(document, { ...view });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        observer.disconnect();
        expect(mutations).toBe(0);
        expect(el.querySelector('.review-ratio-full')).toBe(full);
        resolve();
      }, 0);
    });
  });
});
