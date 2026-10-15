# Security and privacy

## What the extension can access

| Permission                                           | Why                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `storage`                                            | Settings, the cached badge, PR keys, Viewed snapshots, compare cache         |
| `scripting`                                          | Put the badge back in GitHub tabs that were open during an install or update |
| `https://api.github.com/*`                           | Read your reviews and PRs with your token                                    |
| `https://github.com/*`                               | Show the badge in the header (content script)                                |
| `http://localhost:8787/*`, `http://127.0.0.1:8787/*` | The prototype server                                                         |

## The token

- A fine-grained PAT with read-only permissions (Pull requests, Contents, Metadata).
- Stored in `chrome.storage.local`, restricted to trusted contexts: the background worker and the
  options page. Content scripts, and so a compromised github.com page, cannot read it.
- Sent only to `api.github.com`, never logged.
- The background worker serves content scripts the badge and nothing else. Forcing a refresh and
  reading diagnostics are reserved for the extension's own pages. Web pages and other extensions
  cannot message it (no `externally_connectable`).

## What leaves the browser

Only the payload described in `packages/contract/src/v1.ts`:

- line counts per semantic class, rounded to a multiple of 10;
- review and ready-for-review times, rounded to the hour, in UTC;
- the review action, and hours a PR waited without review, rounded up;
- a random UUID per own PR, generated and kept by the extension.

The schema rejects any other key at every level, on both sides, including keys named like
JavaScript built-ins (`constructor`, `__proto__`…). The end-to-end test checks that the payload
carries no organisation, repository, login, path, file extension or review id.

Every install has the same extension id (the manifest pins a public key), so the `Origin` header of
a request says nothing about the machine or the user.

## What the server keeps

Nothing. It scores the payload in memory and answers. Request logs contain the method, path,
status, duration and a request id the server generates; never the body, a token or a header.
The Workers deployment ships with platform observability off.

## Known limits

- **Soft opacity.** A developer can read their own payload in DevTools and watch the ratio move.
  The formula is not shipped to the extension, but it is readable in this repository.
- **Re-identification by the server operator.** Payloads carry no identifiers, but they are not
  anonymous to someone who also reads the organisation's GitHub. A ↓ record (ready hour and line
  counts) matches a PR, and so its author. A first-review ↑ record of the same PR carries similar
  counts, which links reviewer and author. `prKey` is stable for 7 days, so refreshes of one
  developer can be chained. And the server sees client IP addresses. Mitigations for the remote
  phase: keep no logs of bodies or addresses, and consider a contract major that drops `prKey` and
  `closedAt` (unused by the formula), sends a `rescued` boolean instead of hours, and uses coarser
  line buckets. See docs/decisions.md › Open questions.
- **Anonymous endpoint.** `POST /score` is rate limited per client in memory, and requires a JSON
  content type, so web pages cannot spend a developer's quota with cross-site posts. Behind a
  proxy, `TRUSTED_PROXY_HOPS` must be set, or the server refuses to start.
- **Self-reported numbers.** A developer can forge their own payload. It only changes the badge
  they alone see.

## Reporting

Report a vulnerability privately to the repository owner, not in a public issue.
