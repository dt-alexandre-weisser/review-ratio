import type { AuthStatus } from './auth/sign-in.ts';
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
  | { type: 'cache:get' }
  /** The options page asks how the extension signs in to GitHub, and how a sign-in is going. */
  | { type: 'auth:status' }
  /** The options page starts "Sign in with GitHub". */
  | { type: 'auth:start' }
  | { type: 'auth:cancel' }
  /** Forgets the GitHub App sign-in: Sign out, or a pasted token replacing it. */
  | { type: 'auth:sign-out' }
  /**
   * Test connection, with the settings of the form (not saved yet). In app mode the worker uses
   * its own token: only the worker renews it.
   */
  | { type: 'connection:test'; settings: unknown };

export type Response =
  | { type: 'badge:view'; view: BadgeView }
  | { type: 'cache'; cache: BadgeCache }
  | { type: 'auth'; status: AuthStatus }
  | { type: 'diagnosis'; ok: boolean; lines: string[] }
  | { type: 'ok' }
  | { type: 'error'; message: string };

/** Pushed by the background worker to github.com tabs after a refresh. */
export interface BadgeUpdate {
  type: 'badge:update';
  view: BadgeView;
}

const SIMPLE: ReadonlySet<string> = new Set([
  'badge:get',
  'badge:refresh',
  'cache:get',
  'auth:status',
  'auth:start',
  'auth:cancel',
  'auth:sign-out',
]);

export function isRequest(value: unknown): value is Request {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { type?: unknown; placement?: unknown; header?: unknown; settings?: unknown };
  if (v.type === 'badge:placed') {
    return (
      (v.placement === 'header' || v.placement === 'floating') &&
      typeof v.header === 'string' &&
      v.header.length <= MAX_HEADER_TEXT &&
      HEADER_TEXT.test(v.header)
    );
  }
  if (v.type === 'connection:test') return typeof v.settings === 'object' && v.settings !== null;
  return typeof v.type === 'string' && SIMPLE.has(v.type);
}

export function isBadgeUpdate(value: unknown): value is BadgeUpdate {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'badge:update' &&
    typeof (value as { view?: unknown }).view === 'object'
  );
}
