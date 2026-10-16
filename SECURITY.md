# Security and privacy

## What the extension can access

| Permission                 | Why                                                                          |
| -------------------------- | ---------------------------------------------------------------------------- |
| `storage`                  | Settings, the cached badge, PR keys, Viewed snapshots, compare cache, log    |
| `scripting`                | Put the badge back in GitHub tabs that were open during an install or update |
| `https://api.github.com/*` | Read your reviews and PRs with your token                                    |
| `https://github.com/*`     | Show the badge in the header (content script)                                |

The badge, and its stand-in while GitHub's header loads (custom properties on `<html>`), are part
of the github.com page: GitHub's own scripts could read the ratio shown there. Nothing else the
extension holds is reachable from the page.

## The token

- A fine-grained PAT with read-only permissions (Pull requests, Contents, Metadata).
- Stored in `chrome.storage.local`, restricted to trusted contexts: the background worker and the
  options page. Content scripts, and so a compromised github.com page, cannot read it. Chrome
  supports this restriction on `storage.local` from version 140, the extension's minimum.
- Sent only to `api.github.com`, never logged.
- The background worker serves content scripts the badge and nothing else. Forcing a refresh and
  reading diagnostics are reserved for the extension's own pages. Web pages and other extensions
  cannot message it (no `externally_connectable`).

## The activity log

The options page lists every call the extension made in the last 30 minutes, to show what it
does without DevTools.

- Kept in `chrome.storage.session`: in memory only, gone when the browser closes, and out of reach
  of content scripts.
- Holds the time, method, URL, status and duration of each call, what it sent, and refresh start
  and end lines. What was sent is the GraphQL query and its variables (repository, PR number,
  your login, page cursors), up to 64 kB. URLs and variables
  name repositories, PRs and your login. The page says so, and repeats it after a copy.
- Never holds a header, so never the token. Responses are not kept.
- Cleared by **Forget local activity data**. Nothing in it leaves the browser.
- Next to it, the worker keeps where the badge last went on github.com and, when it floats, what
  the content script saw of the header: tag names, ids, classes and layout, never page text or
  links. A content script may send only that report and the request for the badge. The worker
  accepts a report of at most 2,000 characters made of letters, digits and `_ - . # : [ ]`, so
  no markup, quotes or links, and logs at most one placement line every 2 seconds.

## What leaves the browser

Nothing but the GitHub API calls made with your token, to `api.github.com`. The extension reads
your reviews and PRs, classifies, rounds and scores them in the browser, and shows the result in
the github.com header. There is no other server: no payload, no score request, no telemetry. The
end-to-end test checks that a refresh calls `api.github.com` and `github.com` only.

The formula, its weights and the class globs are bundled in the extension and public: the options
page links to **How Review Points are counted**, which renders them from the code.

Every install has the same extension id (the manifest pins a public key), so the `Origin` header of
a call to GitHub says nothing about the machine or the user.

The bundled class globs are matched by the extension's own glob matcher, without regular
expressions, so no path can make a glob backtrack exponentially. A refresh also stops after 5
seconds of classification, so a huge PR cannot make the browser hang.

## What is kept, and where

Everything stays in the browser profile: the token, the settings, the cached badge, a random UUID
per own PR (it orders own PRs ready in the same hour, as before), Viewed snapshots and cached
comparisons in `chrome.storage.local`; the activity log in `chrome.storage.session`. **Forget local
activity data** clears all of it but the token and the settings.

## Known limits

- **Public formula.** Anyone can read the weights and aim for them. The ratio is private and seen
  by its owner alone, so gaming it only fools oneself; the weights reward the review work the
  product wants anyway (DESIGN.md › Formula).
- **Local numbers.** A developer can change their own extension or its storage. It only changes
  the badge they alone see.

## Reporting

Report a vulnerability privately to the repository owner, not in a public issue.
