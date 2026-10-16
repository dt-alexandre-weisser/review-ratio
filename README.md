# review-ratio

A private badge in the github.com header that shows how much you review compared to how much you
ask others to review. It works like a torrent ratio, for code review.

```
↑ 64,129 RP · ↓ 43,002 RP | Ratio 1.49
```

**Nudge, not manage.** Each ratio is private. Nobody can see another developer's ratio. There is no
team view, no leaderboard, and the server stores nothing. The full product design is in
[DESIGN.md](DESIGN.md).

## How it works

```
github.com page ──► extension (MV3) ──► GitHub API (your own token, read-only)
                         │
                         │  anonymous numeric payload
                         ▼
                    server (Hono) ── opaque formula ──► { up, down, ratio }
```

1. The extension reads your last 7 days of review activity in the organisation with your own
   read-only token.
2. It classifies each file path locally (`production`, `test`, `docs`…) with globs published by
   the server, then forgets the path.
3. It sends numbers only: line counts per class, rounded times, review actions. No login,
   repository, PR number, file name, code or comment text ever leaves the browser.
4. The server scores the payload with a formula it never publishes, and answers
   `{ up, down, ratio }`. It keeps nothing.

## Quick start (prototype)

Prerequisites: Node 22.13 or later, pnpm 10 (`corepack enable`), and a Chromium browser version 140
or later (Chrome, Edge, Brave or Arc).

```sh
pnpm install
pnpm build          # builds the extension into packages/extension/dist
pnpm dev:server     # serves http://127.0.0.1:8787, leave it running
```

Load the extension:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `packages/extension/dist`.
3. The options page opens. Paste a token (below), click **Save**, then **Test connection**. The
   test also checks that the token can see the organisation's private repositories.
4. Open any github.com page. The badge appears in the header within a few seconds.

Every install has the same extension id, `bhmdipijifghpkibegnfchgcafodlgnb`, pinned by the public
key in the manifest.

Create the token at <https://github.com/settings/personal-access-tokens/new>:

| Field             | Value                                               |
| ----------------- | --------------------------------------------------- |
| Resource owner    | `DiliTrust`                                         |
| Repository access | All repositories                                    |
| Permissions       | Pull requests: Read, Contents: Read, Metadata: Read |

The token stays in `chrome.storage.local` and is only sent to `api.github.com`.

## Badge states

| State                        | Badge                                          |
| ---------------------------- | ---------------------------------------------- |
| Ratio ≥ 1.0                  | green                                          |
| 0.5 ≤ ratio < 1.0            | grey                                           |
| Ratio < 0.5                  | amber, never red                               |
| Nothing asked                | `Ratio ∞`, green                               |
| No activity at all           | `Ratio —`, grey, still visible                 |
| Server or GitHub unreachable | last ratio greyed, tooltip `stale since HH:MM` |
| Server retired this version  | `update the extension`, grey                   |
| No token, or token rejected  | `review-ratio: set up` or `token rejected`     |

The badge refreshes on page load, at most once every 10 minutes. Clicking it does nothing. The
options page has **Refresh badge now** and shows the last score and error.

### Where the badge is

In the top bar of github.com, on the right, first in the group of search box and icons. At a
window width of 1,280 px or less it shortens to `Ratio 1.49`, and below 768 px it hides, as
GitHub's header has no room left.

GitHub changes its header markup without notice. When the badge cannot find its place in the
header, it floats in the bottom-right corner of the page instead of disappearing. The options
page then says so under **On github.com**, and shows the structure of the header it saw (tags and
classes only) to send to the maintainers, so the badge can go back in the header.

### Activity log

The options page (toolbar icon, or **Details › Extension options** in `chrome://extensions`) lists
every call the extension made in the last 30 minutes, newest first: time, method and URL, status,
duration, and refresh start and end lines. It updates live and **Copy as text** copies it. The log
stays in memory and is gone when the browser closes. See [SECURITY.md](SECURITY.md).

## Repository layout

| Path                 | Content                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| `packages/contract`  | ArkType payload schemas, one frozen schema per major, fixture payloads                 |
| `packages/server`    | Hono app, the formula, one decoder per supported major, Dockerfile, Workers entry      |
| `packages/extension` | MV3 extension: GitHub fetching, classification, payload building, badge                |
| `e2e`                | Playwright tests: the built extension in Chromium against the server and a fake GitHub |
| `docs`               | Decisions, operations                                                                  |

## Commands

| Command                                     | What it does                                                          |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm check`                                | Format check, lint, typecheck, unit tests, build. Run before pushing. |
| `pnpm test`                                 | Unit and contract tests (Vitest)                                      |
| `pnpm test:coverage`                        | Same, with coverage thresholds                                        |
| `pnpm test:e2e`                             | Builds, then runs the Playwright suite                                |
| `pnpm dev:server`                           | Server with reload on change                                          |
| `pnpm --filter @review-ratio/extension dev` | Extension rebuild on change; reload it in `chrome://extensions`       |

## Further reading

- [DESIGN.md](DESIGN.md): the product and the formula.
- [docs/decisions.md](docs/decisions.md): implementation decisions, including where the code
  deliberately differs from the design and why.
- [docs/operations.md](docs/operations.md): deploying the server, configuration, contract majors.
- [CONTRIBUTING.md](CONTRIBUTING.md): development workflow and CI gates.
- [SECURITY.md](SECURITY.md): threat model and privacy guarantees.
