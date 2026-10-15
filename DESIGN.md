# review-ratio design

A badge in the github.com header that shows a developer how much they review compared to how much they ask others to review. It works like a torrent ratio, for code review.

**Core value: nudge, not manage.** Each ratio is private. Nobody can see another developer's ratio. There is no team view, no leaderboard and no stored history of user activity.

## Badge

```
↑ 64,129 RP · ↓ 43,002 RP | Ratio 1.49
```

- **RP** means review points. Both sides use the same unit.
- **↑** is RP given (reviews I did). **↓** is RP asked (my PRs in review). The tooltip says "given / asked".
- The ratio is `↑ / ↓`.
- The numbers are the server's weighted totals, not raw line counts.

| State | Display |
| --- | --- |
| Ratio ≥ 1.0 | green |
| 0.5 ≤ ratio < 1.0 | neutral grey |
| Ratio < 0.5 | amber. Never red: red reads as a sanction. |
| ↓ = 0 | `Ratio ∞`, green |
| ↑ = 0 and ↓ = 0 | `—`, grey. The badge stays visible. |
| Server unreachable | last ratio, greyed, tooltip "stale since HH:MM" |
| Server answers `426` | "update the extension", grey |

- Refresh on page load, at most once every 10 minutes. The result is cached in `chrome.storage.local`.
- Clicking the badge does nothing. The badge alone is the nudge.

## Scope

- Every repo of the `DiliTrust` org the developer can access, found with the search API (`reviewed-by:@me`, `author:@me`, `updated:` within 7 days).
- An optional per-user repo exclude list in the extension options.

### Bot PRs

- Reviewing a bot PR earns ↑ like any PR.
- A PR authored by `github-actions[bot]` (the `claude-bot-pr` flow) counts as ↓ for its **assignee**.
- A Dependabot PR counts as ↓ for nobody.
- Reviews posted by a bot earn nobody anything.

## File classes

Lines are bucketed by semantic class. The class never reveals the language.

`production`, `test`, `config`, `ci`, `tooling`, `docs`, `generated`, `chore`

- `generated` covers lockfiles, generated schemas (`schema.ts`) and snapshots. These lines should still be read, but they carry less meaning.
- Each class has a weight. The weights apply to **both sides**, so ↑ and ↓ stay in the same unit.
- The server publishes the class globs. It never publishes the weights.
- The extension matches file paths against the globs locally. Only the class name and a line count leave the browser.

## Formula

The formula and its parameters live on the server only. The extension never receives them.

### ↑ RP, per review I submit

```
covered = Σ files  classWeight × lines changed since the commit of my previous review on this PR
          (the full diff on my first review of that PR)

↑ review = ( covered × actionWeight
           + Σ commented lines × classWeight × commentMultiplier
           + Σ lines of files marked Viewed × classWeight × viewedBonus )
         × decay(review age)
         × rescue
```

| Parameter | Value |
| --- | --- |
| `actionWeight` approve | 1.0 |
| `actionWeight` request changes | 1.0. It is at least as much work as an approval. |
| `actionWeight` comment-only review | 0.4 |
| `commentMultiplier` | 10, applied to each line of the comment's range (`start_line..line`) |
| comment range cap | 20 lines per comment |
| `viewedBonus` | 0.2 |
| thread reply without a review | earns the commented-lines term only |
| `rescue` | ×1.5 when the PR had waited more than 48h with no review, else ×1 |

### ↓ RP, per PR I own

```
↓ PR = sizeTiers( Σ files classWeight × lines ) × decay(time since ready for review)
```

Size malus, applied to marginal lines (no cliff at a tier boundary):

| Weighted lines | Each line counts |
| --- | --- |
| 0 to 400 | ×1.0 |
| 401 to 1,000 | ×1.5 |
| above 1,000 | ×2.0 |

Example: a 1,200-line PR costs `400 + 600 × 1.5 + 200 × 2 = 1,700`.

The size malus applies to ↓ only. Mirroring it on ↑ would make large PRs attractive to reviewers.

### Time

- The window is a rolling 7 days, on both sides.
- `decay` is 1.0 for the first 24h, then linear down to 0.3 at day 7, then 0.
- **↓ clock:** starts when the PR is marked ready for review. Draft time does not count.
- A PR drops out of ↓ at day 7, even if it is still open.
- A review received does not reset the ↓ decay. A PR nobody reviews loses weight at the same pace, so the author is not punished for other people's inaction.
- A PR merged or closed early still counts for its full 7 days.
- **↑ clock:** the age of the review.

### Anchor invariant

A plain approve on a PR under 400 weighted lines balances one PR under 400 weighted lines of my own, at the same age, at exactly ratio 1.0.

Comments, Viewed and rescues push the ratio above 1.0. Large PRs of my own pull it below. The server tests this invariant for every contract major.

## Architecture

```
github.com page ──► extension (MV3) ──► GitHub API (dev's own token, read-only)
                         │
                         │  anonymous numeric payload
                         ▼
                    server (Hono) ── opaque formula ──► { up, down, ratio }
```

### Extension (Chrome MV3)

- Injects the badge into the github.com header.
- Reads GitHub with the developer's own token: my reviews and their `commit_id`, review comments and their line ranges, the PR files between two commits (compare API), my own PRs, and `viewerViewedState` (GraphQL).
- Classifies files locally with the server's globs.
- Computes the per-review delta (`covered`) locally.
- Builds the anonymous payload and posts it to the server. It resends the full 7-day window each time, so the server keeps nothing.
- Chrome only for v1. The same build runs in Edge, Brave and Arc.

**Viewed capture.** On each refresh, for each review I made in the window whose PR head still equals the review's `commit_id`, the extension reads `viewerViewedState` and stores the snapshot against that review in `chrome.storage.local`.

- No DOM hook on the submit button. A GitHub UI change would break it silently.
- This also covers reviews submitted outside the browser (`gh`, VS Code, mobile).
- GitHub resets a file's Viewed flag when the file changes. If the author pushes before my next refresh, the snapshot is lost. That only costs the 0.2 bonus, never the base credit.

### Payload

Numbers only. No login, no repo, no PR number, no path, no file extension, no code, no comment text.

```
↑ record  { t, action, linesByClass, commentedLinesByClass, viewedLinesByClass, waitedHoursWithoutReview }
↓ record  { prKey, readyAt, closedAt?, linesByClass }
```

- `t`, `readyAt`, `closedAt` are rounded to the hour.
- Line counts are rounded to the nearest 10.
- `waitedHoursWithoutReview` is rounded.
- `prKey` is random. The extension generates and stores it. It is never derived from the repo or PR number.
- Every payload carries `contractVersion`.

### Server

- Stateless Hono app on Node. One endpoint: `POST /score` → `{ up, down, ratio }`.
- Also serves the file-class globs (names and globs only).
- Prototype: runs locally, started by hand with `pnpm dev:server` on a fixed localhost port. The extension declares that host permission.
- Later: deployed remotely. The same Hono code runs on Cloud Run or Cloudflare Workers.

### Opacity

- The formula is computed on the server so developers cannot optimise against it.
- MV3 forbids remotely hosted code, so the formula could not be shipped as code to the extension anyway.
- Opacity is soft. A developer can read their own payload in DevTools and watch the ratio move.
- The formula is readable by anyone with access to this repo. Opacity means it is not shipped to the extension and not shown on the badge.

## Code

One pnpm monorepo, TypeScript throughout.

| Package | Content |
| --- | --- |
| `contract` | ArkType payload schemas, one frozen schema per major (`payloadV1`, `payloadV2`…), fixture payloads per major |
| `server` | Hono app, the formula, one decoder per supported contract major |
| `extension` | MV3 extension: GitHub fetching, classification, payload building, badge |

- The extension and the server import `contract` directly, so drift is a compile error.
- Installed extensions keep running old builds, so the server keeps a decoder for each supported major.
- Retiring a major is a deliberate server change. A retired major gets `426 Upgrade Required`.

**CI gates**
- Decode and score the fixtures of every supported major against the current server.
- Check the anchor invariant on every major.
- Fail when a released major's schema is edited (frozen-schema check).
- Typecheck all packages.

## Auth

| Phase | Mechanism |
| --- | --- |
| Prototype | Fine-grained PAT, read-only (Pull requests, Contents, Metadata), resource owner `DiliTrust`, pasted in the options page, stored in `chrome.storage.local` |
| Rollout | GitHub App with the device flow. One click, auto-refreshed user-to-server token. Needs an org admin to create and install the app once. |

The scopes are the same in both phases. Only the auth module changes.

## Repository

- `dt-alexandre-weisser/review-ratio`, private, during the prototype.
- Transferred to the `DiliTrust` org at rollout. GitHub keeps the history and redirects the old URL.

## Open items (remote phase)

- **Privacy.** A remote server sees client IPs. Payloads could be matched over time.
- **Abuse.** Rate limiting for an anonymous endpoint.
- **Rollout.** Org admin steps for the GitHub App and the repo transfer.
- **Browsers.** Firefox (small manifest changes) and Safari (Xcode wrapper).
