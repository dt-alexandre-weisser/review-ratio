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

  it('falls back to any header, and to nothing', () => {
    document.body.innerHTML = '<header id="h"></header>';
    expect(findSlot(document)?.id).toBe('h');
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
    expect(el.getAttribute('role')).toBe('status');

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
    document.body.innerHTML = '<header></header>';
    const el = mount(document, { ...view, text: '<img src=x onerror=alert(1)>' })!;
    expect(el.querySelector('img')).toBeNull();
  });
});
