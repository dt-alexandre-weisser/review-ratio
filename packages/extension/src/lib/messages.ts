import type { BadgeView } from './badge-state.ts';
import type { BadgeCache } from './storage.ts';

/** Where the content script put the badge: in GitHub's header, or floating when none was found. */
export type Placement = 'header' | 'floating';

/** Longest header description a content script may report. */
export const MAX_HEADER_TEXT = 2_000;
/**
 * What a header description is made of: tag names, ids and classes (with other characters
 * replaced), display values, indentation and the two section titles. No quotes or angle brackets.
 */
const HEADER_TEXT = /^[\w .#:[\]\n-]*$/;

/** Messages between the content script, the options page and the background worker. */
export type Request =
  /** The content script asks for the badge. Triggers a refresh when the cache is older than 5 minutes. */
  | { type: 'badge:get' }
  /** The content script says where the badge went, and the header it saw when it floats. */
  | { type: 'badge:placed'; placement: Placement; header: string }
  /** The options page asks for a refresh now. */
  | { type: 'badge:refresh' }
  /** The options page asks for the raw cache, to show diagnostics. */
  | { type: 'cache:get' };

export type Response =
  | { type: 'badge:view'; view: BadgeView }
  | { type: 'cache'; cache: BadgeCache }
  | { type: 'ok' }
  | { type: 'error'; message: string };

/** Pushed by the background worker to github.com tabs after a refresh. */
export interface BadgeUpdate {
  type: 'badge:update';
  view: BadgeView;
}

export function isRequest(value: unknown): value is Request {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { type?: unknown; placement?: unknown; header?: unknown };
  if (v.type === 'badge:placed') {
    return (
      (v.placement === 'header' || v.placement === 'floating') &&
      typeof v.header === 'string' &&
      v.header.length <= MAX_HEADER_TEXT &&
      HEADER_TEXT.test(v.header)
    );
  }
  return v.type === 'badge:get' || v.type === 'badge:refresh' || v.type === 'cache:get';
}

export function isBadgeUpdate(value: unknown): value is BadgeUpdate {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'badge:update' &&
    typeof (value as { view?: unknown }).view === 'object'
  );
}
