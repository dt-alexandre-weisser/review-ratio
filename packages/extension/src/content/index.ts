/**
 * Content script: asks the background worker for the badge and keeps it mounted through
 * GitHub's Turbo navigation. Clicking the badge does nothing.
 */
import type { BadgeView } from '../lib/badge-state.ts';
import { isBadgeUpdate, type Request, type Response } from '../lib/messages.ts';
import { mount } from './badge.ts';

const REMOUNT_INTERVAL_MS = 5_000;

let lastView: BadgeView | null = null;

function ensureMounted(): void {
  if (lastView) mount(document, lastView);
}

async function ask(request: Request): Promise<Response | null> {
  try {
    return await chrome.runtime.sendMessage<Request, Response | null>(request);
  } catch {
    // The extension was reloaded or disabled; this page keeps the last badge until reload.
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

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (isBadgeUpdate(message)) {
    lastView = message.view;
    ensureMounted();
  }
  return false;
});

for (const event of ['turbo:load', 'turbo:render', 'pjax:end', 'pageshow']) {
  document.addEventListener(event, ensureMounted);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void requestBadge();
});
window.setInterval(ensureMounted, REMOUNT_INTERVAL_MS);

void requestBadge();
