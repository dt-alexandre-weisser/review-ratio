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
- The numbers are weighted totals computed by the extension, not raw line counts.

| State | Display |
| --- | --- |
| Ratio ≥ 1.0 | green |
| 0.5 ≤ ratio < 1.0 | neutral grey |
| Ratio < 0.5 | amber. Never red: red reads as a sanction. |
| ↓ = 0 | `Ratio ∞`, green |
| ↑ = 0 and ↓ = 0 | `—`, grey. The badge stays visible. |
| GitHub unreachable | last ratio, greyed, tooltip "stale since HH:MM" |

- Refresh on page load, at most once every 10 minutes. The result is cached in `chrome.storage.local`.
- Clicking the badge does nothing. The badge alone is the nudge.

## Scope

- Every repo of the organisation the developer picks in the options, among those they can access, found with the search API (`reviewed-by:@me`, `author:@me`, `updated:` within 7 days).
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
- The class globs are bundled in the extension and public, like the weights.
- The extension matches file paths against the globs, then forgets the path. Only the class name and a line count are kept.

## Formula

The formula and its parameters are bundled in the extension and public. The extension computes the badge in the browser, and its page **How Review Points are counted**, linked from the options page, renders every weight, threshold and glob from the constants the formula runs on.

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

Comments, Viewed and rescues push the ratio above 1.0. Large PRs of my own pull it below. A unit test checks this invariant through the whole local pipeline, rounding included.

## Architecture

```
github.com page ──► extension (MV3) ──► GitHub API (dev's own token, read-only)
                         │
                         ▼
              classify, round, score, all in the browser ──► { up, down, ratio }
```

### Extension (Chrome MV3)

- Injects the badge into the github.com header.
- Reads GitHub with the developer's own token: my reviews and their `commit_id`, review comments and their line ranges, the PR files between two commits (compare API), my own PRs, and `viewerViewedState` (GraphQL).
- Classifies files with the bundled globs.
- Computes the per-review delta (`covered`).
- Builds the records and scores them. It rescores the full 7-day window each time.
- Nothing leaves the browser except the GitHub API calls. There is no server.
- Chrome only for v1. The same build runs in Edge, Brave and Arc.

**Viewed capture.** On each refresh, for each review I made in the window whose PR head still equals the review's `commit_id`, the extension reads `viewerViewedState` and stores the snapshot against that review in `chrome.storage.local`.

- No DOM hook on the submit button. A GitHub UI change would break it silently.
- This also covers reviews submitted outside the browser (`gh`, VS Code, mobile).
- GitHub resets a file's Viewed flag when the file changes. If the author pushes before my next refresh, the snapshot is lost. That only costs the 0.2 bonus, never the base credit.

### Records

What the formula scores: numbers only, built from what was read and kept in memory for the refresh.

```
↑ record  { t, action, linesByClass, commentedLinesByClass, viewedLinesByClass, waitedHoursWithoutReview }
↓ record  { readyAt, linesByClass }
```

- `t` and `readyAt` are rounded to the hour.
- Line counts are rounded to the nearest 10.
- At most the newest 500 ↑ and 200 ↓ records count.

### Transparency

- The formula is public so a developer can see how their points are counted. A hidden formula asked for trust a private nudge does not need.
- A developer can aim for the weights. The ratio is private, so gaming it only fools its owner, and the weights reward the review work the product wants anyway.
- A formula change ships with an extension update. Every install scores with the formula it shipped with.
- This replaces the opaque server formula of the first prototype (docs/decisions.md › Revised decisions).

## Code

One pnpm monorepo, TypeScript throughout. One package, `packages/extension`: the MV3 extension, with GitHub fetching, classification, scoring, the badge, and the scoring page.

| Path | Content |
| --- | --- |
| `src/lib/scoring` | The formula, the bundled class globs, rounding, records |
| `src/scoring` | The **How Review Points are counted** page, rendered from the formula's constants |

**CI gates**
- Score the fixtures against a snapshot, so a formula change shows in review.
- Check the anchor invariant through the whole local pipeline.
- Check that the scoring page shows the constants the formula runs on.
- Typecheck, lint, unit and end-to-end tests.

## Auth

| Mode | Mechanism |
| --- | --- |
| Sign in with GitHub (recommended) | The review-ratio GitHub App with the device flow. One click and a code to type, an expiring user token renewed by itself. Needs an org owner to install the app once. |
| Paste a token (fallback) | Fine-grained PAT, read-only (Pull requests, Contents, Metadata), resource owner the developer's organisation, pasted in the options page |

The permissions are the same in both modes, and both store their tokens in `chrome.storage.local`.
The app's settings and installation are in `docs/github-app-setup.md`.

## Repository

- `dt-alexandre-weisser/review-ratio`, public.
- The extension names no organisation. Each developer types theirs in the options page.

## Open items

- **Rollout.** Each organisation that uses the GitHub App installs it once
  (`docs/github-app-setup.md`).
- **Browsers.** Firefox (small manifest changes) and Safari (Xcode wrapper).
