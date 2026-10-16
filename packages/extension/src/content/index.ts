/**
 * Content script: asks the background worker for the badge and keeps it mounted through
 * GitHub's Turbo navigation. Clicking the badge does nothing.
 *
 * When the extension is updated or reloaded, this script is orphaned: it can no longer talk to
 * the extension. It then stops itself and leaves the badge to the newly injected script.
 */
import type { BadgeView } from '../lib/badge-state.ts';
import { isBadgeUpdate, type Placement, type Request, type Response } from '../lib/messages.ts';
import { BADGE_ID, describeHeader, forgetRejections, isSignedIn, mount } from './badge.ts';

const REMOUNT_INTERVAL_MS = 5_000;
/** How long GitHub gets to render its header, after a load or a navigation, before the badge floats. */
const FLOATING_AFTER_MS = 3_000;
/** Start of the current grace period: the script start, then each navigation. */
let graceFrom = Date.now();
// GitHub navigates without page loads (Turbo, then its own soft navigation); the periodic remount
// covers any event not listed here.
const NAVIGATION_EVENTS = [
  'turbo:load',
  'turbo:render',
  'soft-nav:end',
  'soft-nav:render',
  'pjax:end',
  'pageshow',
];

let lastView: BadgeView | null = null;
/** The placement last reported to the worker, so each change is reported once. */
let reported: Placement | null = null;
let requesting = false;
/**
 * Set once the page has loaded and gone idle: GitHub hydrates its React header after load, and a
 * node added before that is thrown away with the server-rendered subtree.
 */
let settled = false;

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
  if (!settled) return;
  // Signed-out, sign-in and sudo pages: the ratio is the signed-in developer's own, not shown.
  if (!isSignedIn(document)) {
    document.getElementById(BADGE_ID)?.remove();
    return;
  }
  const mounted = mount(document, lastView, {
    allowFloating: Date.now() - graceFrom >= FLOATING_AFTER_MS,
  });
  if (mounted && mounted.placement !== reported) {
    reported = mounted.placement;
    void ask({
      type: 'badge:placed',
      placement: mounted.placement,
      header: mounted.placement === 'floating' ? describeHeader(document) : '',
    });
  }
}

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
function onNavigate(): void {
  forgetRejections();
  graceFrom = Date.now();
  window.clearTimeout(graceCheck);
  graceCheck = window.setTimeout(ensureMounted, FLOATING_AFTER_MS);
  ensureMounted();
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

function onSettled(): void {
  settled = true;
  ensureMounted();
}

if (document.readyState === 'complete') {
  window.requestIdleCallback(onSettled, { timeout: 2_000 });
} else {
  window.addEventListener('load', () => window.requestIdleCallback(onSettled, { timeout: 2_000 }), {
    once: true,
  });
}

function teardown(): void {
  window.clearInterval(timer);
  window.clearTimeout(graceCheck);
  window.clearTimeout(resizeTimer);
  window.removeEventListener('resize', onResize);
  for (const event of NAVIGATION_EVENTS) document.removeEventListener(event, onNavigate);
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

chrome.runtime.onMessage.addListener(onMessage);
for (const event of NAVIGATION_EVENTS) document.addEventListener(event, onNavigate);
window.addEventListener('resize', onResize);
document.addEventListener('visibilitychange', onVisibilityChange);

void requestBadge();
