// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  BADGE_ID,
  candidateSpots,
  describeHeader,
  findHeader,
  findSearch,
  forgetRejections,
  isSignedIn,
  mount,
  searchSpot,
} from '../../src/content/badge.ts';
import type { BadgeView } from '../../src/lib/badge-state.ts';
import { MAX_HEADER_TEXT } from '../../src/lib/messages.ts';

const view: BadgeView = {
  text: '↑ 1 RP · ↓ 1 RP | Ratio 1.00',
  short: 'Ratio 1.00',
  parts: { up: '↑ 1 RP', down: '↓ 1 RP', ratio: 'Ratio 1.00' },
  tone: 'good',
  stale: false,
  tooltip: 'review-ratio (given / asked), last 7 days',
};

/** jsdom has no layout: every place shows the badge unless a test says otherwise. */
const always = { shows: () => true };

/** GitHub's header as of 2024–2026: the search bar first in the right-hand row. */
const APP_HEADER = `
  <header class="AppHeader" role="banner">
    <div class="AppHeader-globalBar" style="display:flex">
      <div class="AppHeader-globalBar-start" style="display:flex"><a href="/">logo</a></div>
      <div class="AppHeader-globalBar-end" id="end" style="display:flex">
        <div class="AppHeader-search" id="search">
          <qbsearch-input><button class="header-search-button">Type / to search</button></qbsearch-input>
        </div>
        <div class="AppHeader-actions" id="actions"><button>+</button></div>
      </div>
    </div>
  </header>`;

/**
 * GitHub's React header of 2026, from an archived page and GitHub's bundles: the search box is a
 * button group (search, command palette) in the centre row.
 */
const GLOBAL_NAV = `
  <header class="GlobalNav" aria-label="Global navigation menu" data-component="Stack">
    <div class="prc-Stack-Stack" data-component="Stack" style="display:flex">
      <div data-testid="top-nav-left" style="display:flex"><button aria-label="Open menu">=</button></div>
      <div data-testid="top-nav-center" id="center" style="display:flex">
        <nav aria-label="Breadcrumbs"><a href="/DiliTrust">DiliTrust</a></nav>
        <div class="Search-module__searchButtonGroup__aetw5" data-component="ButtonGroup" id="group" style="display:flex">
          <div class="prc-ButtonGroup-Item"><button class="Search-module__searchButton__aiE0a" aria-label="Open quick search dialog, type / to search">Type / to search</button></div>
          <div class="prc-ButtonGroup-Item"></div>
        </div>
        <button class="Search-module__smallSearchButton" aria-label="Open quick search dialog">S</button>
      </div>
      <div data-testid="top-nav-right" style="display:flex"><button aria-label="Chat with Copilot">c</button></div>
    </div>
  </header>`;

beforeEach(() => {
  forgetRejections();
  document.body.innerHTML = '';
  document.body.className = '';
  document.head.innerHTML = '';
});

describe('finding the search bar', () => {
  it("puts the badge just left of the search bar, in the header's row", () => {
    document.body.innerHTML = APP_HEADER;
    const spot = searchSpot(document)!;
    expect(spot.container.id).toBe('end');
    expect(spot.before?.id).toBe('search');

    const { el, placement } = mount(document, view, always)!;
    expect(placement).toBe('header');
    expect(el.parentElement?.id).toBe('end');
    expect(el.nextElementSibling?.id).toBe('search');
  });

  it("puts the badge before GitHub's 2026 search group, never inside it", () => {
    document.body.innerHTML = `<main><header id="content-header">A post</header></main>${GLOBAL_NAV}`;
    expect(findHeader(document)?.className).toBe('GlobalNav');
    expect(findSearch(findHeader(document)!)?.id).toBe('group');
    const { el } = mount(document, view, always)!;
    expect(el.parentElement?.id).toBe('center');
    expect(el.nextElementSibling?.id).toBe('group');
  });

  it('never takes a button group, or a row of empty items, for the row', () => {
    document.body.innerHTML = `
      <header>
        <div class="Row" style="display:flex">
          <a href="/">logo</a>
          <div role="group" class="Group" style="display:flex">
            <span class="Item" style="display:flex"><button aria-label="Search">s</button><span></span></span>
            <span></span>
          </div>
        </div>
      </header>`;
    const spot = searchSpot(document)!;
    expect((spot.container as HTMLElement).className).toBe('Row');
    expect((spot.before as HTMLElement).className).toBe('Group');
  });

  it('never climbs out of the header for the search group', () => {
    document.body.innerHTML = `
      <div role="group"><header id="h" style="display:flex">
        <a href="/">logo</a><input placeholder="Search" id="q">
      </header></div>`;
    expect(findSearch(findHeader(document)!)?.id).toBe('q');
    expect(searchSpot(document)?.container.id).toBe('h');
  });

  it('prefers a control labelled search to one whose text mentions it', () => {
    document.body.innerHTML = `
      <header style="display:flex">
        <button>Research notes</button><button>Advanced search tips</button><input placeholder="Search">
      </header>`;
    expect(findSearch(findHeader(document)!)?.tagName).toBe('INPUT');
    document.body.innerHTML = '<header><button>Advanced search tips</button></header>';
    expect(findSearch(findHeader(document)!)?.textContent).toBe('Advanced search tips');
  });

  it('finds a redesigned search by its words, and climbs to the nearest row', () => {
    document.body.innerHTML = `
      <div role="banner">
        <nav class="Top" style="display:flex">
          <a href="/">logo</a>
          <span class="Wrap"><span class="Inner"><button aria-label="Search or jump to…">⌕</button></span></span>
          <button aria-label="Open Copilot">c</button>
        </nav>
      </div>`;
    const search = findSearch(document.querySelector('[role="banner"]')!)!;
    expect(search.getAttribute('aria-label')).toBe('Search or jump to…');
    const spot = searchSpot(document)!;
    expect(spot.container.className).toBe('Top');
    expect((spot.before as HTMLElement).className).toBe('Wrap');
  });

  it('falls back to the search control itself when no row holds it', () => {
    document.body.innerHTML =
      '<header><div id="box"><input placeholder="Search GitHub"></div></header>';
    const spot = searchSpot(document)!;
    expect(spot.container.id).toBe('box');
    expect(spot.before?.tagName).toBe('INPUT');
    document.body.innerHTML = '<header><input placeholder="Search GitHub"></header>';
    expect(searchSpot(document)?.container.tagName).toBe('HEADER');
  });

  it('has no search spot without a header or a search control', () => {
    document.body.innerHTML = '<main><input placeholder="Search"></main>';
    expect(searchSpot(document)).toBeNull();
    document.body.innerHTML = '<header><button>Security</button></header>';
    expect(searchSpot(document)).toBeNull();
  });
});

describe('placing the badge', () => {
  it('tries the search spot, then the known header containers, in order', () => {
    document.body.innerHTML = APP_HEADER;
    expect(candidateSpots(document).map((s) => [s.container.id, s.before?.id ?? null])).toEqual([
      ['end', 'search'],
      ['end', null],
      ['actions', null],
    ]);
  });

  it('moves on when a place cannot show the badge, and remembers it', () => {
    document.body.innerHTML = APP_HEADER;
    const shows = (_el: HTMLElement, container: Element) => container.id === 'actions';
    const { el, placement } = mount(document, view, { shows })!;
    expect(placement).toBe('header');
    expect(el.parentElement?.id).toBe('actions');
    expect(el.parentElement?.firstElementChild).toBe(el);
    // The rejected row is not tried again.
    expect(candidateSpots(document).map((s) => s.container.id)).toEqual(['actions']);
  });

  it('skips a hidden header without rejecting it, and uses it once it shows', () => {
    document.body.innerHTML = GLOBAL_NAV;
    const center = document.getElementById('center')!;
    center.checkVisibility = () => false;
    expect(mount(document, view, always)).toBeNull();
    center.checkVisibility = () => true;
    expect(mount(document, view, always)?.el.parentElement).toBe(center);
  });

  it('tries a rejected place again after a navigation or a resize', () => {
    document.body.innerHTML = GLOBAL_NAV;
    expect(mount(document, view, { shows: () => false })).toBeNull();
    expect(candidateSpots(document)).toEqual([]);
    forgetRejections();
    expect(mount(document, view, always)?.el.parentElement?.id).toBe('center');
  });

  it('floats when nothing in the header shows it, once allowed', () => {
    document.body.innerHTML = '<header class="SomeNewHeader"><nav></nav></header><main></main>';
    expect(mount(document, view, always)).toBeNull();
    expect(document.getElementById(BADGE_ID)).toBeNull();
    const { el, placement } = mount(document, view, { ...always, allowFloating: true })!;
    expect(placement).toBe('floating');
    expect(el.parentElement).toBe(document.body);
    expect(el.dataset['placement']).toBe('floating');
    // Later mounts without the permission keep the floating badge.
    expect(mount(document, view, always)).toEqual({ el, placement: 'floating' });
  });

  it('takes the badge out of places that cannot show it while it may not float', () => {
    document.body.innerHTML = APP_HEADER;
    expect(mount(document, view, { shows: () => false })).toBeNull();
    expect(document.getElementById(BADGE_ID)).toBeNull();
  });

  it('moves a floating badge into the header once the header shows up', () => {
    document.body.innerHTML = '<main></main>';
    const { el } = mount(document, view, { ...always, allowFloating: true })!;
    document.body.insertAdjacentHTML('afterbegin', APP_HEADER);
    expect(mount(document, view, { ...always, allowFloating: true })).toEqual({
      el,
      placement: 'header',
    });
    expect(el.nextElementSibling?.id).toBe('search');
    expect(document.querySelectorAll(`#${BADGE_ID}`)).toHaveLength(1);
  });

  it('mounts once and updates in place', () => {
    document.body.innerHTML = APP_HEADER;
    const { el } = mount(document, view, always)!;
    expect(el.id).toBe(BADGE_ID);
    expect(el.title).toBe(view.tooltip);
    expect(el.dataset['tone']).toBe('good');
    expect(el.dataset['stale']).toBe('false');
    // Not a live region: screen readers are not interrupted by refreshes.
    expect(el.getAttribute('role')).toBeNull();
    expect(el.getAttribute('aria-live')).toBeNull();

    const stale = { ...view, parts: null, text: 'update the extension', stale: true };
    const again = mount(document, { ...stale, tone: 'neutral' }, always)!.el;
    expect(again).toBe(el);
    expect(document.querySelectorAll(`#${BADGE_ID}`)).toHaveLength(1);
    expect(el.querySelector('.review-ratio-full')?.textContent).toBe('update the extension');
    expect(el.querySelector('.review-ratio-up')).toBeNull();
    expect(el.dataset['stale']).toBe('true');
  });

  it('colours ↑ and ↓ apart, and keeps the short form', () => {
    document.body.innerHTML = APP_HEADER;
    const { el } = mount(document, view, always)!;
    expect(el.querySelector('.review-ratio-up')?.textContent).toBe('↑ 1 RP');
    expect(el.querySelector('.review-ratio-down')?.textContent).toBe('↓ 1 RP');
    expect(el.querySelector('.review-ratio-value')?.textContent).toBe('Ratio 1.00');
    expect(el.querySelector('.review-ratio-full')?.textContent).toBe(view.text);
    expect(el.querySelector('.review-ratio-short')?.textContent).toBe(view.short);
  });

  it('renders text, never HTML', () => {
    document.body.innerHTML = APP_HEADER;
    const evil = '<img src=x onerror=alert(1)>';
    const { el } = mount(
      document,
      { ...view, text: evil, parts: { up: evil, down: evil, ratio: evil } },
      always,
    )!;
    expect(el.querySelector('img')).toBeNull();
  });

  it('leaves the DOM untouched when nothing changed', async () => {
    document.body.innerHTML = APP_HEADER;
    const { el } = mount(document, view, always)!;
    let mutations = 0;
    const observer = new MutationObserver((records) => (mutations += records.length));
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    mount(document, { ...view }, always);
    mount(document, { ...view }, always);
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    expect(mutations).toBe(0);
    expect(el.isConnected).toBe(true);
  });
});

describe('isSignedIn', () => {
  it("reads GitHub's own signals", () => {
    expect(isSignedIn(document)).toBe(false);
    document.head.innerHTML = '<meta name="user-login" content="">';
    expect(isSignedIn(document)).toBe(false);
    document.head.innerHTML = '<meta name="user-login" content="dev">';
    expect(isSignedIn(document)).toBe(true);
    document.head.innerHTML = '';
    document.body.className = 'logged-in env-production';
    expect(isSignedIn(document)).toBe(true);
  });
});

describe('describeHeader', () => {
  it('gives the search path and the structure, with tags, ids and classes only', () => {
    document.body.innerHTML = APP_HEADER.replace(
      '<a href="/">logo</a>',
      '<a href="/DiliTrust/secret" id="ctx" class="a b c d e">DiliTrust secret<svg><path></path></svg></a>',
    );
    const text = describeHeader(document);
    expect(text.split('\n').slice(0, 7)).toEqual([
      'search path:',
      '  div#search.AppHeader-search [block]',
      '  div#end.AppHeader-globalBar-end [flex]',
      '  div.AppHeader-globalBar [flex]',
      '  header.AppHeader [block]',
      'header:',
      '  header.AppHeader',
    ]);
    expect(text).toContain('        a#ctx.a.b.c.d\n          svg\n');
    expect(text).not.toMatch(/^\s+path$/m);
    expect(text).not.toContain('DiliTrust');
  });

  it('says when there is no search control, and is empty without a header', () => {
    document.body.innerHTML = '<div role="banner"><span id="review-ratio-badge"></span></div>';
    expect(describeHeader(document)).toBe('search path: no search control found\nheader:\n  div');
    document.body.innerHTML = '<main></main>';
    expect(describeHeader(document)).toBe('');
  });

  it('replaces separators in names, and stays within its size', () => {
    document.body.innerHTML = '<header><div id="a.b c" class="w-1.5 md:flex"></div></header>';
    expect(describeHeader(document)).toContain('div#a_b_c.w-1_5.md_flex');
    const wide = Array.from({ length: 100 }, (_, i) => `<div class="${'x'.repeat(80)}${i}"></div>`);
    document.body.innerHTML = `<header>${wide.join('')}</header>`;
    expect(describeHeader(document).length).toBeLessThanOrEqual(MAX_HEADER_TEXT);
    document.body.innerHTML = `<header>${'<div>'.repeat(10)}${'</div>'.repeat(10)}</header>`;
    expect(describeHeader(document).split('\n')).toHaveLength(2 + 6);
    const many = '<div></div>'.repeat(200);
    document.body.innerHTML = `<header>${many}</header>`;
    expect(describeHeader(document).split('\n')).toHaveLength(2 + 80);
  });
});
