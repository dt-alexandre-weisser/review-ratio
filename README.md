# review-ratio

A private badge in the github.com header that shows how much you review compared to how much you
ask others to review. It works like a torrent ratio, for code review.

```
↑ 64,129 RP · ↓ 43,002 RP | Ratio 1.49
```

**Nudge, not manage.** Each ratio is private. Nobody can see another developer's ratio. There is no
team view, no leaderboard, and no server: the extension computes the badge in your browser. The
full product design is in [DESIGN.md](DESIGN.md).

## How it works

```
github.com page ──► extension (MV3) ──► GitHub API (your own token, read-only)
                         │
                         ▼
              classify, round, score, all in the browser ──► { up, down, ratio }
```

1. The extension reads your last 7 days of review activity in the organisation with your own
   read-only token.
2. It classifies each file path (`production`, `test`, `docs`…) with globs bundled in the
   extension, then forgets the path.
3. It turns what it read into numbers only: line counts per class, rounded times, review actions.
4. It scores those numbers with the public formula, and shows `{ up, down, ratio }`. Nothing leaves
   the browser except the GitHub API calls made with your token.

The options page links to **How Review Points are counted**, a page of the extension that shows the
whole formula: every weight, threshold and glob, rendered from the constants the badge runs on.

## Quick start (prototype)

Prerequisites: Node 22.13 or later, pnpm 10 (`corepack enable`), and a Chromium browser version 140
or later (Chrome, Edge, Brave or Arc).

```sh
pnpm install
pnpm build          # builds the extension into packages/extension/dist
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

| State                         | Badge                                          |
| ----------------------------- | ---------------------------------------------- |
| Ratio ≥ 1.0                   | green ratio                                    |
| 0.5 ≤ ratio < 1.0             | grey                                           |
| Ratio < 0.5                   | amber, never red                               |
| Nothing asked                 | `Ratio ∞`, green                               |
| No activity at all            | `Ratio —`, grey, still visible                 |
| GitHub unreachable or refused | last ratio greyed, tooltip `stale since HH:MM` |
| No token, or token rejected   | `review-ratio: set up` or `token rejected`     |

The badge refreshes on page load, at most once every 5 minutes; in between, every page shows the
cached score. Clicking it does nothing. The
options page has **Refresh badge now** and shows the last score and error.

### Where the badge is

In the github.com header, just left of the search box, in the header's own row: it moves with
GitHub's layout. At a window width of 1,280 px or less it shortens to `Ratio 1.49`. ↑ takes the
colour GitHub gives added lines and ↓ the colour of removed lines, from your theme, so colour-blind
themes apply. The ratio is green, grey or amber. Signed-out pages show no badge.

GitHub changes its header without notice. The badge checks that it actually shows where it is
placed. When the header has no place for it, it floats in the bottom-right corner instead of
disappearing, and the options page says so under **On github.com**, with what it saw of the header
(tags, classes and layout only) to send to the maintainers.

### Activity log

The options page (toolbar icon, or **Details › Extension options** in `chrome://extensions`) lists
every call the extension made in the last 30 minutes, newest first: time, method and URL, status,
duration, and refresh start and end lines. **View payload** on a call shows what it sent: the
GraphQL query and variables. Every call goes to GitHub. The log updates live and **Copy as text**
copies it. The log
stays in memory and is gone when the browser closes. See [SECURITY.md](SECURITY.md).

## Repository layout

| Path                                 | Content                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `packages/extension`                 | MV3 extension: GitHub fetching, classification, scoring, badge          |
| `packages/extension/src/lib/scoring` | The formula, the bundled class globs, rounding, records                 |
| `packages/extension/src/scoring`     | The **How Review Points are counted** page                              |
| `packages/extension/test/scoring`    | Formula tests, fixtures and their scored snapshot, anchor invariant     |
| `e2e`                                | Playwright tests: the built extension in Chromium against a fake GitHub |
| `docs`                               | Decisions                                                               |

## Commands

| Command                                     | What it does                                                          |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm check`                                | Format check, lint, typecheck, unit tests, build. Run before pushing. |
| `pnpm test`                                 | Unit and formula tests (Vitest)                                       |
| `pnpm test:coverage`                        | Same, with coverage thresholds                                        |
| `pnpm test:e2e`                             | Builds, then runs the Playwright suite                                |
| `pnpm --filter @review-ratio/extension dev` | Extension rebuild on change; reload it in `chrome://extensions`       |

## Further reading

- [DESIGN.md](DESIGN.md): the product and the formula.
- [docs/decisions.md](docs/decisions.md): implementation decisions, including where the code
  deliberately differs from the design and why.
- [CONTRIBUTING.md](CONTRIBUTING.md): development workflow and CI gates.
- [SECURITY.md](SECURITY.md): threat model and privacy guarantees.
