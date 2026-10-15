import type { BadgeView } from './badge-state.ts';
import type { BadgeCache } from './storage.ts';

/** Messages between the content script, the options page and the background worker. */
export type Request =
  /** The content script asks for the badge. Triggers a refresh when the cache is older than 10 minutes. */
  | { type: 'badge:get' }
  /** The options page asks for a refresh now. */
  | { type: 'badge:refresh' }
  /** The options page asks for the raw cache, to show diagnostics. */
  | { type: 'cache:get' };

export type Response =
  | { type: 'badge:view'; view: BadgeView }
  | { type: 'cache'; cache: BadgeCache }
  | { type: 'error'; message: string };

/** Pushed by the background worker to github.com tabs after a refresh. */
export interface BadgeUpdate {
  type: 'badge:update';
  view: BadgeView;
}

export function isRequest(value: unknown): value is Request {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === 'badge:get' || t === 'badge:refresh' || t === 'cache:get';
}

export function isBadgeUpdate(value: unknown): value is BadgeUpdate {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'badge:update' &&
    typeof (value as { view?: unknown }).view === 'object'
  );
}
