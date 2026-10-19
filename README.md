# review-ratio

A private badge in the github.com header that shows how much you review compared to how much you
ask others to review. It works like a torrent ratio, for code review.

```
↑ 64,129 RP · ↓ 43,002 RP | Ratio 1.49
```

**Nudge, not manage.** Each ratio is private. Nobody can see another developer's ratio. There is no
team view, no leaderboard, and no server: the extension computes the badge in your browser. The
full product design is in [DESIGN.md](DESIGN.md).

## How to install

About 5 minutes. You need:

- Chrome, Edge, Brave or Arc, version 140 or later
- [Node.js](https://nodejs.org) 22.13 or later
- git

### 1. Build the extension

```sh
git clone https://github.com/dt-alexandre-weisser/review-ratio.git
cd review-ratio
corepack enable     # provides pnpm
pnpm install
pnpm build
```

The extension is now in `packages/extension/dist`.

### 2. Load it in the browser

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**, top right.
3. Click **Load unpacked** and pick the `packages/extension/dist` folder.

The review-ratio options page opens by itself.

### 3. Connect to GitHub

On the options page, keep **Sign in with GitHub** selected:

1. Click **Sign in with GitHub**. A code appears.
2. Click **Open GitHub**, type the code, then click **Authorize review-ratio**.
3. Back on the options page: **Signed in as _you_**.
4. Check that **GitHub organisation** is `DiliTrust`, click **Save**, then **Test connection**.

If Test connection says the app is not installed on the organisation, an owner of `DiliTrust`
has to install it once: <https://github.com/apps/review-ratio/installations/new>. Until then,
use a token instead (below).

### 4. See your ratio

Open any github.com page. The badge appears in the header, left of the search box, within a few
seconds.

### Update

```sh
git pull
pnpm install
pnpm build
```

Then click the reload arrow on the review-ratio card in `chrome://extensions`.

### Uninstall

Click **Remove** on the review-ratio card in `chrome://extensions`. To revoke the sign-in at GitHub
too: **Settings → Applications → Authorized GitHub Apps → review-ratio → Revoke**.

<details>
<summary>Use a token instead of signing in</summary>

On the options page, pick **Paste a token**. Create a fine-grained personal access token at
<https://github.com/settings/personal-access-tokens/new>:

| Field             | Value                                               |
| ----------------- | --------------------------------------------------- |
| Resource owner    | `DiliTrust`                                         |
| Repository access | All repositories                                    |
| Permissions       | Pull requests: Read, Contents: Read, Metadata: Read |

Paste it, click **Save**, then **Test connection**. An owner of `DiliTrust` may have to approve the
token first.

</details>

### What the extension can access

Both ways read the same data with the same read-only permissions (Pull requests, Contents,
Metadata). It cannot write anything to GitHub. The token stays in `chrome.storage.local`, out of
reach of web pages, and is only sent to GitHub. With the app, the token expires after 8 hours and
renews itself; you sign in again only after about 6 months without use. **Sign out** forgets the
tokens in this browser. Details in [SECURITY.md](SECURITY.md) and
[docs/github-app-setup.md](docs/github-app-setup.md).

Every install has the same extension id, `bhmdipijifghpkibegnfchgcafodlgnb`, pinned by the public
key in the manifest.

## How it works

```
github.com page ──► extension (MV3) ──► GitHub API (your own read-only access)
                         │
                         ▼
              classify, round, score, all in the browser ──► { up, down, ratio }
```

1. The extension reads your last 7 days of review activity in the organisation with your own
   read-only access: the review-ratio GitHub App you signed in with, or a token you pasted.
2. It classifies each file path (`production`, `test`, `docs`…) with globs bundled in the
   extension, then forgets the path.
3. It turns what it read into numbers only: line counts per class, rounded times, review actions.
4. It scores those numbers with the public formula, and shows `{ up, down, ratio }`. Nothing leaves
   the browser except the calls to `api.github.com` and `github.com`.

The options page links to **How Review Points are counted**, a page of the extension that shows the
whole formula: every weight, threshold and glob, rendered from the constants the badge runs on.

## Badge states

| State                         | Badge                                          |
| ----------------------------- | ---------------------------------------------- |
| Ratio ≥ 1.0                   | green ratio                                    |
| 0.5 ≤ ratio < 1.0             | grey                                           |
| Ratio < 0.5                   | amber, never red                               |
| Nothing asked                 | `Ratio ∞`, green                               |
| No activity at all            | `Ratio —`, grey, still visible                 |
| GitHub unreachable or refused | last ratio greyed, tooltip `stale since HH:MM` |
| Not connected, or rejected    | `review-ratio: set up` or `token rejected`     |

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
- [docs/github-app-setup.md](docs/github-app-setup.md): the review-ratio GitHub App, its settings
  and its installation.
