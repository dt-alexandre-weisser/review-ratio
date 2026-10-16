/**
 * Content script: asks the background worker for the badge and keeps it mounted through
 * GitHub's Turbo navigation. Clicking the badge does nothing.
 *
 * When the extension is updated or reloaded, this script is orphaned: it can no longer talk to
 * the extension. It then stops itself and leaves the badge to the newly injected script.
 */
import type { BadgeView } from '../lib/badge-state.ts';
import { isBadgeUpdate, type Placement, type Request, type Response } from '../lib/messages.ts';
import { describeHeader, isSignedIn, mount } from './badge.ts';

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
  const mounted = mount(document, lastView, {
    // Signed-out, sudo or sign-in pages have no header by design: no floating badge there.
    allowFloating: Date.now() - graceFrom >= FLOATING_AFTER_MS && isSignedIn(document),
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
  graceFrom = Date.now();
  window.clearTimeout(graceCheck);
  graceCheck = window.setTimeout(ensureMounted, FLOATING_AFTER_MS);
  ensureMounted();
}

function teardown(): void {
  window.clearInterval(timer);
  window.clearTimeout(graceCheck);
  for (const event of NAVIGATION_EVENTS) document.removeEventListener(event, onNavigate);
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

chrome.runtime.onMessage.addListener(onMessage);
for (const event of NAVIGATION_EVENTS) document.addEventListener(event, onNavigate);
document.addEventListener('visibilitychange', onVisibilityChange);

void requestBadge();
