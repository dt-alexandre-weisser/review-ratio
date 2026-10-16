/**
 * The badge element in the github.com header. DOM only; no fetching here.
 *
 * The badge goes just left of the header's search bar, in the header's own row, so it moves with
 * GitHub's layout. GitHub changes its header markup without notice and its CSS can hide or clip
 * what we add, so the badge checks that it actually shows after it is placed. When no place in the
 * header can show it, it floats in the bottom-right corner instead of disappearing, and the
 * content script reports what it saw so the placement can be fixed.
 */
import type { BadgeView } from '../lib/badge-state.ts';
import { MAX_HEADER_TEXT, type Placement } from '../lib/messages.ts';

export const BADGE_ID = 'review-ratio-badge';

/**
 * GitHub's global header, most specific first: the React header of 2026, the AppHeader of
 * 2023–2025, then generic landmarks. Tried in this order, not in document order, so an earlier
 * unrelated `header` never wins over a known one.
 */
const HEADER_SELECTORS = [
  'header.GlobalNav',
  'header[aria-label="Global navigation menu"]',
  'header.AppHeader',
  'header[role="banner"]',
  '[role="banner"]',
  'header',
];

/**
 * The header's search, most specific first. The 2026 header's search is a button group (search
 * box and command palette): the badge goes before the whole group, never inside it.
 */
const SEARCH_SELECTORS = [
  '[class*="Search-module__searchButtonGroup"]',
  '.AppHeader-search',
  'qbsearch-input',
  '[data-target="qbsearch-input.inputButton"]',
  '.header-search-button',
  '[role="search"]',
];

/** Groups that style their items as one control: never a row for the badge. */
const GROUPS = '[data-component="ButtonGroup"], [role="group"]';

/** Header containers to fall back to, first position. */
const SLOT_SELECTORS = ['.AppHeader-globalBar-end', '.AppHeader-actions'];

/** The view last rendered into each badge element, to skip identical re-renders. */
const rendered = new WeakMap<Element, string>();

/**
 * Containers that showed but clipped the badge. Forgotten on navigation and resize, when GitHub's
 * layout may have changed.
 */
let rejected = new WeakSet<Element>();

export function forgetRejections(): void {
  rejected = new WeakSet<Element>();
}

/** A place in the page: inside `container`, before `before`, or first when `before` is null. */
export interface Spot {
  container: Element;
  before: Element | null;
}

export function findHeader(doc: Document): Element | null {
  for (const selector of HEADER_SELECTORS) {
    const el = doc.querySelector(selector);
    if (el) return el;
  }
  return null;
}

/**
 * Not hidden: `checkVisibility` where the DOM has it (Chrome; not jsdom). A `display: contents`
 * element has no box, so it counts as visible when its parent is.
 */
function isVisible(el: Element): boolean {
  if (typeof el.checkVisibility !== 'function' || el.checkVisibility()) return true;
  const parent = el.parentElement;
  return getComputedStyle(el).display === 'contents' && parent !== null && isVisible(parent);
}

const SEARCH_WORD = /\bsearch\b/i;

/** The group around a search control, when it is inside the header, else the control. */
function wholeControl(el: Element, header: Element): Element {
  const group = el.closest(GROUPS);
  return group && group !== header && header.contains(group) ? group : el;
}

/**
 * The search of the header, by GitHub's markup, else a visible control whose label says
 * "search", else one whose text does.
 */
export function findSearch(header: Element): Element | null {
  for (const selector of SEARCH_SELECTORS) {
    const el = header.querySelector(selector);
    if (el) return wholeControl(el, header);
  }
  const controls = [
    ...header.querySelectorAll('button, input, [role="button"], [role="combobox"]'),
  ].filter(isVisible);
  const labelled = controls.find((el) =>
    SEARCH_WORD.test(
      `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''}`,
    ),
  );
  const found = labelled ?? controls.find((el) => SEARCH_WORD.test(el.textContent));
  return found ? wholeControl(found, header) : null;
}

function isRow(el: Element): boolean {
  if (el.matches(GROUPS)) return false;
  const { display } = getComputedStyle(el);
  return display === 'flex' || display === 'inline-flex';
}

/** Another item of the row than `item`: not the badge, not empty. */
function isOtherItem(child: Element, item: Element): boolean {
  return (
    child !== item &&
    child.id !== BADGE_ID &&
    child.childElementCount + child.textContent.trim().length > 0
  );
}

/**
 * Where the badge would sit left of the search bar: before the search's item in the nearest row
 * (flex container) that holds other items too.
 */
export function searchSpot(doc: Document): Spot | null {
  const header = findHeader(doc);
  const search = header && findSearch(header);
  if (!header || !search) return null;
  let item: Element = search;
  for (let row = search.parentElement; row && row !== header; row = row.parentElement) {
    if (isRow(row) && [...row.children].some((c) => isOtherItem(c, item))) {
      return { container: row, before: item };
    }
    item = row;
  }
  return search.parentElement ? { container: search.parentElement, before: search } : null;
}

/** Every place to try, in order of preference, without the containers already rejected. */
export function candidateSpots(doc: Document): Spot[] {
  const spots: Spot[] = [];
  const search = searchSpot(doc);
  if (search) spots.push(search);
  for (const selector of SLOT_SELECTORS) {
    for (const container of doc.querySelectorAll(selector)) spots.push({ container, before: null });
  }
  return spots.filter((spot) => !rejected.has(spot.container));
}

function isAt(el: Element, spot: Spot): boolean {
  if (el.parentElement !== spot.container) return false;
  return spot.before
    ? el.nextElementSibling === spot.before
    : spot.container.firstElementChild === el;
}

/**
 * Whether the badge, placed in `container`, can be seen: not hidden by `display`, `visibility` or
 * `opacity` up its ancestors, not empty, and not entirely clipped out of its container.
 */
export function badgeShows(el: HTMLElement, container: Element): boolean {
  if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
  const badge = el.getBoundingClientRect();
  if (badge.width === 0 || badge.height === 0) return false;
  const box = container.getBoundingClientRect();
  // A `display: contents` container has no box of its own: nothing to be clipped by.
  if (box.width === 0 && box.height === 0) return true;
  return (
    badge.right > box.left &&
    badge.left < box.right &&
    badge.bottom > box.top &&
    badge.top < box.bottom
  );
}

/** GitHub's own signals for a signed-in page, as `github-url-detection` reads them. */
export function isSignedIn(doc: Document): boolean {
  const login = doc.querySelector('meta[name="user-login"]')?.getAttribute('content');
  // `body` is null while the page is still parsing its head.
  const body = doc.body as HTMLElement | null;
  return Boolean(login) || body?.classList.contains('logged-in') === true;
}

/**
 * How long to wait for GitHub's React to take over a server-rendered header before placing the
 * badge anyway, in case GitHub renames its performance marks.
 */
export const HYDRATION_WAIT_MS = 3_000;

/** For each server-rendered React root seen: marks from before this time are an older root's. */
const hydrationSeen = new WeakMap<Element, { since: number; firstChecked: number }>();
let firstRoot = true;

/**
 * Whether the header can take the badge now. GitHub renders its header on the server, then React
 * hydrates it; a node added before that makes React throw the header away and render it again.
 * GitHub marks each React root's commit (`react-root:commit:<name>`), and performance marks are
 * shared with the extension's world.
 */
export function headerReady(doc: Document, now: number = performance.now()): boolean {
  const header = findHeader(doc);
  const root = header?.closest('react-partial, react-app');
  if (root?.getAttribute('data-ssr') !== 'true') return true;
  const name = root.getAttribute('partial-name') ?? root.getAttribute('app-name') ?? '';
  let seen = hydrationSeen.get(root);
  if (!seen) {
    // The page's first root may have committed before this script ran; a later one (after a
    // navigation) needs a commit of its own.
    seen = { since: firstRoot ? 0 : now, firstChecked: now };
    firstRoot = false;
    hydrationSeen.set(root, seen);
  }
  if (now - seen.firstChecked >= HYDRATION_WAIT_MS) return true;
  const since = seen.since;
  return performance
    .getEntriesByName(`react-root:commit:${name}`, 'mark')
    .some((mark) => mark.startTime >= since);
}

function span(doc: Document, className: string, text: string): HTMLSpanElement {
  const el = doc.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

export function render(el: HTMLElement, view: BadgeView): void {
  const key = JSON.stringify(view);
  if (rendered.get(el) === key) return;
  rendered.set(el, key);

  const doc = el.ownerDocument;
  const full = span(doc, 'review-ratio-full', '');
  if (view.parts) {
    full.append(
      span(doc, 'review-ratio-up', view.parts.up),
      span(doc, 'review-ratio-sep', ' · '),
      span(doc, 'review-ratio-down', view.parts.down),
      span(doc, 'review-ratio-sep', ' | '),
      span(doc, 'review-ratio-value', view.parts.ratio),
    );
  } else {
    full.textContent = view.text;
  }
  el.replaceChildren(full, span(doc, 'review-ratio-short', view.short));
  el.title = view.tooltip;
  el.setAttribute('aria-label', `review ratio: ${view.text}. ${view.tooltip}`);
  el.dataset['tone'] = view.tone;
  el.dataset['stale'] = view.stale ? 'true' : 'false';
}

export interface MountOptions {
  /**
   * Float the badge when no place in the header can show it. The content script waits a few
   * seconds after each navigation first: GitHub may render its header late.
   */
  allowFloating?: boolean;
  /** Whether the badge shows in a container. Injected by tests: jsdom has no layout. */
  shows?: (el: HTMLElement, container: Element) => boolean;
}

export interface Mounted {
  el: HTMLElement;
  placement: Placement;
}

/** Written only when it changes: the remount every few seconds must not touch GitHub's DOM. */
function setPlacement(el: HTMLElement, placement: Placement): Mounted {
  if (el.dataset['placement'] !== placement) el.dataset['placement'] = placement;
  return { el, placement };
}

/**
 * Creates the badge or updates it in place: at the first place in the header where it shows,
 * floating otherwise once allowed. Returns `null` when the badge is not on the page.
 */
export function mount(doc: Document, view: BadgeView, options: MountOptions = {}): Mounted | null {
  const shows = options.shows ?? badgeShows;
  let el = doc.getElementById(BADGE_ID);
  if (!el) {
    el = doc.createElement('span');
    el.id = BADGE_ID;
    el.className = 'review-ratio-badge';
    // A plain labelled element, not a live region: screen readers are not interrupted by it.
  }
  // Text first: an empty badge has no size, and would never be seen to show.
  render(el, view);
  const wasFloating = el.dataset['placement'] === 'floating';

  for (const spot of candidateSpots(doc)) {
    // A container rejected earlier in this loop (search row, then the same row as a slot).
    if (rejected.has(spot.container)) continue;
    // A hidden container (GitHub hides the whole header on some pages) is skipped, not rejected:
    // it may show again.
    if (!isVisible(spot.container)) continue;
    // Already there and showing: leave the DOM alone.
    if (isAt(el, spot) && !wasFloating && shows(el, spot.container)) {
      return setPlacement(el, 'header');
    }
    if (!isAt(el, spot)) {
      if (spot.before) spot.container.insertBefore(el, spot.before);
      else spot.container.prepend(el);
    }
    // The header style before the check: a floating badge is fixed in the corner, outside any
    // container, and would always look clipped.
    setPlacement(el, 'header');
    if (shows(el, spot.container)) return setPlacement(el, 'header');
    rejected.add(spot.container);
  }
  if (options.allowFloating || wasFloating) {
    if (el.parentElement !== doc.body) doc.body.append(el);
    return setPlacement(el, 'floating');
  }
  // Not allowed to float yet: take it out of any container that could not show it.
  el.remove();
  return null;
}

const MAX_HEADER_NODES = 80;
const MAX_HEADER_DEPTH = 6;

/** Ids and classes without the characters that separate them in the description. */
function clean(text: string): string {
  return text.replace(/[^\w-]/g, '_');
}

function describe(el: Element): string {
  const id = el.id ? `#${clean(el.id)}` : '';
  const classes = [...el.classList]
    .slice(0, 4)
    .map((c) => `.${clean(c)}`)
    .join('');
  return `${clean(el.tagName.toLowerCase())}${id}${classes}`;
}

/**
 * What the content script saw of the header, for the options page when the badge floats: the
 * path from the search control up to the header with each level's display, then the header's
 * tree. Tag names, ids and classes only: no text, no links, no SVG internals. Empty when the page
 * has no header.
 */
export function describeHeader(doc: Document): string {
  const header = findHeader(doc);
  if (!header) return '';
  const lines: string[] = [];
  const search = findSearch(header);
  if (search) {
    lines.push('search path:');
    for (let el: Element | null = search; el && header.contains(el); el = el.parentElement) {
      lines.push(`  ${describe(el)} [${getComputedStyle(el).display}]`);
    }
  } else {
    lines.push('search path: no search control found');
  }
  lines.push('header:');
  let nodes = 0;
  const walk = (el: Element, depth: number) => {
    if (nodes >= MAX_HEADER_NODES || el.id === BADGE_ID) return;
    nodes += 1;
    lines.push(`${'  '.repeat(depth)}${describe(el)}`);
    if (depth >= MAX_HEADER_DEPTH || el.tagName.toLowerCase() === 'svg') return;
    for (const child of el.children) walk(child, depth + 1);
  };
  walk(header, 1);
  let text = '';
  for (const line of lines) {
    if (text.length + line.length + 1 > MAX_HEADER_TEXT) break;
    text = text ? `${text}\n${line}` : line;
  }
  return text;
}
