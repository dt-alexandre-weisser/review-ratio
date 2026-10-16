/**
 * Content script: shows the badge in GitHub's header and keeps it there without flicker. Clicking
 * the badge does nothing.
 *
 * It starts with the page and asks the worker for the cached badge at once, so the badge is ready
 * before GitHub's header is. It goes in on the first frame after GitHub's React takes over the
 * header. When GitHub re-renders or replaces the header (navigation), a mutation observer puts it
 * back before the browser paints, so no frame shows the header without it.
 *
 * When the extension is updated or reloaded, this script is orphaned: it can no longer talk to
 * the extension. It then stops itself and leaves the badge to the newly injected script.
 */
import type { BadgeView } from '../lib/badge-state.ts';
import { isBadgeUpdate, type Placement, type Request, type Response } from '../lib/messages.ts';
import {
  BADGE_ID,
  describeHeader,
  forgetRejections,
  headerReady,
  isSignedIn,
  mount,
} from './badge.ts';
import { hidePlaceholder, showPlaceholder } from './placeholder.ts';

const REMOUNT_INTERVAL_MS = 5_000;
/** How long GitHub gets to render its header, after a load or a navigation, before the badge floats. */
const FLOATING_AFTER_MS = 3_000;
/** Restores by the mutation observer per second, at most: a page fighting the badge cannot loop. */
const MAX_RESTORES_PER_SECOND = 20;
/** Start of the current grace period: the script start, then each navigation. */
let graceFrom = Date.now();
// GitHub navigates without page loads (Turbo, then its own soft navigation); the observer and the
// periodic check cover any event not listed here.
const NAVIGATION_EVENTS = [
  'turbo:load',
  'turbo:render',
  'soft-nav:end',
  'soft-nav:render',
  'pjax:end',
  'pageshow',
];
/** Fired before GitHub swaps in a new page: a header seen after them is a new one. */
const NAVIGATION_START_EVENTS = ['turbo:visit', 'turbo:before-render', 'soft-nav:start'];

let lastView: BadgeView | null = null;
/** The placement last reported to the worker, so each change is reported once. */
let reported: Placement | null = null;
let requesting = false;
let frame = 0;
let restores = { second: 0, count: 0 };
/** When GitHub last started a navigation without a page load (`performance.now()`), if ever. */
let navigatedAt: number | null = null;

function alive(): boolean {
  try {
    return typeof chrome.runtime.id === 'string';
  } catch {
    return false;
  }
}

function ensureMounted(): void {
  if (!alive()) {
    teardown();
    return;
  }
  if (!lastView) {
    // The first answer never came (worker starting, error): ask again on every check.
    void requestBadge();
    return;
  }
  // Still parsing the head: nothing to place the badge in yet.
  if (!(document.body as HTMLElement | null)) return;
  // Signed-out, sign-in and sudo pages: the ratio is the signed-in developer's own, not shown.
  if (!isSignedIn(document)) {
    document.getElementById(BADGE_ID)?.remove();
    hidePlaceholder(document);
    return;
  }
  // Until GitHub's React takes over its server-rendered header, a CSS stand-in holds the place,
  // and the check runs again every frame.
  if (!headerReady(document, navigatedAt)) {
    showPlaceholder(document, lastView);
    scheduleMount();
    return;
  }
  const mounted = mount(document, lastView, {
    allowFloating: Date.now() - graceFrom >= FLOATING_AFTER_MS,
  });
  // In the same task as the insertion: no frame shows both, or neither.
  hidePlaceholder(document);
  if (mounted && mounted.placement !== reported) {
    reported = mounted.placement;
    void ask({
      type: 'badge:placed',
      placement: mounted.placement,
      header: mounted.placement === 'floating' ? describeHeader(document) : '',
    });
  }
}

/** Once, before the next frame paints. */
function scheduleMount(): void {
  if (frame !== 0) return;
  frame = window.requestAnimationFrame(() => {
    frame = 0;
    ensureMounted();
  });
}

/**
 * GitHub re-rendered or replaced the header and the badge went with it: put it back now, in the
 * same microtask, before anything paints.
 */
const observer = new MutationObserver(() => {
  if (!lastView || document.getElementById(BADGE_ID)) return;
  const second = Math.floor(Date.now() / 1000);
  if (restores.second !== second) restores = { second, count: 0 };
  // Beyond the limit, once a frame at most.
  if (restores.count >= MAX_RESTORES_PER_SECOND) {
    scheduleMount();
    return;
  }
  ensureMounted();
  // Only an actual restore counts: batches while parsing or waiting for React do not.
  if (document.getElementById(BADGE_ID)) restores.count += 1;
});

async function ask(request: Request): Promise<Response | null> {
  if (!alive()) return null;
  try {
    return await chrome.runtime.sendMessage<Request, Response | null>(request);
  } catch {
    return null;
  }
}

async function requestBadge(): Promise<void> {
  if (requesting) return;
  requesting = true;
  try {
    const response = await ask({ type: 'badge:get' });
    if (response?.type === 'badge:view') {
      lastView = response.view;
      ensureMounted();
    }
  } finally {
    requesting = false;
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') void requestBadge();
}

function onMessage(message: unknown): boolean {
  if (isBadgeUpdate(message)) {
    lastView = message.view;
    ensureMounted();
  }
  return false;
}

const timer = window.setInterval(ensureMounted, REMOUNT_INTERVAL_MS);
let graceCheck = window.setTimeout(ensureMounted, FLOATING_AFTER_MS);

/** A navigation may bring a header that renders late: give it a fresh grace period. */
function onNavigationStart(): void {
  navigatedAt = performance.now();
}

function onNavigate(): void {
  forgetRejections();
  graceFrom = Date.now();
  window.clearTimeout(graceCheck);
  graceCheck = window.setTimeout(ensureMounted, FLOATING_AFTER_MS);
  scheduleMount();
}

let resizeTimer = 0;

/** GitHub's layout changes with the width: places that clipped the badge may fit now. */
function onResize(): void {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    forgetRejections();
    ensureMounted();
  }, 500);
}

function teardown(): void {
  observer.disconnect();
  hidePlaceholder(document);
  window.cancelAnimationFrame(frame);
  window.clearInterval(timer);
  window.clearTimeout(graceCheck);
  window.clearTimeout(resizeTimer);
  window.removeEventListener('resize', onResize);
  for (const event of NAVIGATION_EVENTS) document.removeEventListener(event, onNavigate);
  for (const event of NAVIGATION_START_EVENTS) {
    document.removeEventListener(event, onNavigationStart);
  }
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

chrome.runtime.onMessage.addListener(onMessage);
// The document element exists from the start and survives Turbo's body swaps.
observer.observe(document.documentElement, { childList: true, subtree: true });
for (const event of NAVIGATION_EVENTS) document.addEventListener(event, onNavigate);
for (const event of NAVIGATION_START_EVENTS) document.addEventListener(event, onNavigationStart);
window.addEventListener('resize', onResize);
document.addEventListener('visibilitychange', onVisibilityChange);

void requestBadge();
