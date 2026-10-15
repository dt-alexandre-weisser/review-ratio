import type { Request } from '../lib/messages.ts';

/** The parts of `chrome.runtime.MessageSender` the check reads. */
export interface Sender {
  id?: string | undefined;
  url?: string | undefined;
}

/**
 * Who may send what. Content scripts on github.com may only ask for the badge, which refreshes at
 * most every 10 minutes. Forcing a refresh or reading the diagnostics is for the extension's own
 * pages (the options page).
 */
export function isTrustedFor(
  request: Request,
  sender: Sender,
  extensionId: string,
  extensionOrigin: string,
): boolean {
  if (sender.id !== extensionId) return false;
  const fromExtensionPage =
    typeof sender.url === 'string' && sender.url.startsWith(extensionOrigin);
  if (fromExtensionPage) return true;
  const fromGitHub = typeof sender.url === 'string' && sender.url.startsWith('https://github.com/');
  return fromGitHub && request.type === 'badge:get';
}
