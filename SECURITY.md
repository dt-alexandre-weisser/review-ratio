# Security and privacy

## What the extension can access

| Permission                                           | Why                                                   |
| ---------------------------------------------------- | ----------------------------------------------------- |
| `storage`                                            | Settings, the cached badge, PR keys, Viewed snapshots |
| `https://api.github.com/*`                           | Read your reviews and PRs with your token             |
| `https://github.com/*`                               | Show the badge in the header (content script)         |
| `http://localhost:8787/*`, `http://127.0.0.1:8787/*` | The prototype server                                  |

The GitHub token is a fine-grained PAT with read-only permissions (Pull requests, Contents,
Metadata). It is stored in `chrome.storage.local`, which other extensions and web pages cannot
read. It is only sent to `api.github.com`. The content script never sees it.

## What leaves the browser

Only the payload described in `packages/contract/src/v1.ts`:

- line counts per semantic class, rounded to a multiple of 10;
- review and ready-for-review times, rounded to the hour;
- the review action, and hours a PR waited without review, rounded;
- a random UUID per own PR, generated and kept by the extension.

The schema rejects any other key, on both sides. The end-to-end test checks that the payload
contains no organisation, repository, login, path, file extension or review id.

## What the server keeps

Nothing. It scores the payload in memory and answers. Request logs contain the method, path,
status, duration and a random request id; never the body or a token.

## Known limits

- **Soft opacity.** A developer can read their own payload in DevTools and watch the ratio move.
  The formula is not shipped to the extension, but it is readable in this repository.
- **Client addresses.** A remote server sees client IP addresses, and payloads could be matched
  over time. This is an open item of the remote phase (see DESIGN.md).
- **Anonymous endpoint.** `POST /score` is rate limited per client in memory. Behind a proxy, set
  `TRUSTED_PROXY_HOPS` so the limit keys on the real client and not on a forgeable header.
- **Self-reported numbers.** A developer can forge their own payload. It only changes the badge
  they alone see.

## Reporting

Report a vulnerability privately to the repository owner, not in a public issue.
