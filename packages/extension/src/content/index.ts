/**
 * Content script: asks the background worker for the badge and keeps it mounted through
 * GitHub's Turbo navigation. Clicking the badge does nothing.
 *
 * When the extension is updated or reloaded, this script is orphaned: it can no longer talk to
 * the extension. It then stops itself and leaves the badge to the newly injected script.
 */
import type { BadgeView } from '../lib/badge-state.ts';
import { isBadgeUpdate, type Request, type Response } from '../lib/messages.ts';
import { mount } from './badge.ts';

const REMOUNT_INTERVAL_MS = 5_000;
const NAVIGATION_EVENTS = ['turbo:load', 'turbo:render', 'pjax:end', 'pageshow'];

let lastView: BadgeView | null = null;

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
  if (lastView) mount(document, lastView);
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
  const response = await ask({ type: 'badge:get' });
  if (response?.type === 'badge:view') {
    lastView = response.view;
    ensureMounted();
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

function teardown(): void {
  window.clearInterval(timer);
  for (const event of NAVIGATION_EVENTS) document.removeEventListener(event, ensureMounted);
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

chrome.runtime.onMessage.addListener(onMessage);
for (const event of NAVIGATION_EVENTS) document.addEventListener(event, ensureMounted);
document.addEventListener('visibilitychange', onVisibilityChange);

void requestBadge();
