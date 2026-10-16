// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { BADGE_ID, describeHeader, findSlot, mount } from '../../src/content/badge.ts';
import { MAX_HEADER_TEXT } from '../../src/lib/messages.ts';
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
    const { el, placement } = mount(document, view)!;
    expect(placement).toBe('header');
    expect(el.dataset['placement']).toBe('header');
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
    })!.el;
    expect(again).toBe(el);
    expect(document.querySelectorAll(`#${BADGE_ID}`)).toHaveLength(1);
    expect(el.querySelector('.review-ratio-full')?.textContent).toBe('update the extension');
    expect(el.dataset['stale']).toBe('true');
  });

  it('floats in the corner when the header is not found, once allowed', () => {
    document.body.innerHTML = '<header class="SomeNewHeader"><nav></nav></header><main></main>';
    expect(mount(document, view)).toBeNull();
    expect(document.getElementById(BADGE_ID)).toBeNull();
    const { el, placement } = mount(document, view, { allowFloating: true })!;
    expect(placement).toBe('floating');
    expect(el.parentElement).toBe(document.body);
    expect(el.dataset['placement']).toBe('floating');
    // Later mounts without the permission keep the floating badge.
    expect(mount(document, view)).toEqual({ el, placement: 'floating' });
  });

  it('moves a floating badge into the header once the header shows up', () => {
    document.body.innerHTML = '<main></main>';
    const { el } = mount(document, view, { allowFloating: true })!;
    const slot = document.createElement('div');
    slot.className = 'AppHeader-globalBar-end';
    slot.append(document.createElement('button'));
    document.body.prepend(slot);
    expect(mount(document, view, { allowFloating: true })).toEqual({ el, placement: 'header' });
    expect(slot.firstElementChild).toBe(el);
    expect(document.querySelectorAll(`#${BADGE_ID}`)).toHaveLength(1);
  });

  it('skips a header container GitHub hides', () => {
    document.body.innerHTML =
      '<div class="AppHeader-globalBar-end" id="hidden"></div><div class="AppHeader-actions" id="shown"></div>';
    const hidden = document.getElementById('hidden')!;
    hidden.checkVisibility = () => false;
    expect(findSlot(document)?.id).toBe('shown');
    document.getElementById('shown')!.checkVisibility = () => false;
    expect(findSlot(document)).toBeNull();
  });

  it('describes the header with tags, ids and classes only', () => {
    document.body.innerHTML = `<header class="AppHeader Header--new" role="banner">
      <div id="top" class="a b c d e"><a href="/DiliTrust/secret">DiliTrust secret</a><span>me</span></div>
    </header>`;
    const text = describeHeader(document);
    expect(text).toBe(
      ['header.AppHeader.Header--new', '  div#top.a.b.c.d', '    a', '    span'].join('\n'),
    );
    expect(text).not.toContain('DiliTrust');

    document.body.innerHTML = '<div role="banner"><span id="review-ratio-badge"></span></div>';
    expect(describeHeader(document)).toBe('div');
    document.body.innerHTML = '<main></main>';
    expect(describeHeader(document)).toBe('no <header> or role="banner" element on the page');

    const wide = Array.from({ length: 100 }, (_, i) => `<div class="${'x'.repeat(80)}${i}"></div>`);
    document.body.innerHTML = `<header>${wide.join('')}</header>`;
    expect(describeHeader(document).length).toBeLessThanOrEqual(MAX_HEADER_TEXT);
    const deep = '<div>'.repeat(10) + '</div>'.repeat(10);
    document.body.innerHTML = `<header>${deep}</header>`;
    expect(describeHeader(document).split('\n')).toHaveLength(6);
  });

  it('renders text, never HTML', () => {
    document.body.innerHTML = '<div class="AppHeader-globalBar-end"></div>';
    const { el } = mount(document, { ...view, text: '<img src=x onerror=alert(1)>' })!;
    expect(el.querySelector('img')).toBeNull();
  });
});

describe('render', () => {
  it('leaves the DOM untouched when the view did not change', () => {
    document.body.innerHTML = '<div class="AppHeader-globalBar-end"></div>';
    const { el } = mount(document, view)!;
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
