# Implementation decisions

DESIGN.md is the source of truth for the product. This file records what the design left open,
and the few places where the code deliberately differs from it. Each entry says why.

## Deviations from the design

### Line counts are rounded without bias, not to the nearest 10

The design rounds line counts to the nearest 10 before they leave the browser. Taken literally,
that erases the comment term: a typical review comment covers one to four lines, which rounds to 0,
and a thread reply earns nothing else. The ratio could then never rise above 1.0 through comments,
which the design explicitly wants.

The extension rounds each count to a multiple of 10 with a probability proportional to the
remainder: 3 lines become 10 with probability 0.3, otherwise 0. The expected value is exact, the
payload keeps its 10-line granularity, and the schema check is unchanged. The draw comes from a
hash of the review or PR key, so a record rounds the same way on every refresh and the badge does
not flicker. See `packages/extension/src/lib/payload.ts`.

**To revert:** make `roundLinesByClass` call `roundLines(n)` without the second argument.

### The comment range cap is applied by the extension

The design lists the 20-line comment range cap among the server-only formula parameters. The
payload carries one sum of commented lines per class, so the server cannot cap each comment. The
extension applies the cap before summing (`COMMENT_RANGE_CAP` in `collect/up.ts`). It is the only
formula parameter in client code.

## Choices the design left open

### Class weights

| Class        | Weight |
| ------------ | ------ |
| `production` | 1.0    |
| `test`       | 0.7    |
| `config`     | 0.5    |
| `ci`         | 0.5    |
| `tooling`    | 0.4    |
| `docs`       | 0.3    |
| `chore`      | 0.2    |
| `generated`  | 0.1    |

`production` is 1.0 so the anchor invariant reads in plain lines. The other values are a starting
point to tune; changing them never breaks the contract.

### Class globs

- A path takes the first class whose globs match, in published order: `generated`, `ci`, `test`,
  `docs`, `chore`, `tooling`, `config`. A path that matches nothing is `production`.
- Matching is case-sensitive, like Git. A case-insensitive `*Test.*` would match `latest.ts`.
- Hand-written SQL migrations are `production`. Only generated EF Core designer and snapshot files
  are `generated`.

### ↑ covered lines

- The first review on a PR covers the PR's diff at the reviewed commit: a three-dot compare from
  the base branch tip. When the reviewed commit is the current head, the PR's own file list
  answers it without a compare call.
- A later review covers the three-dot compare from my previous real review's commit. That compare
  spans the two commits' merge base, so after the author rebases onto a newer base it would count
  the base branch's changes too. The result is therefore capped, per class, by the PR's current
  diff.
- When GitHub cannot compare any more (force-push, garbage-collected commit), the review covers
  the PR's current diff.
- A second review on the same commit covers nothing new.
- GitHub returns at most 300 files per comparison. Larger diffs are undercounted.

### Review actions

| GitHub review                                                     | Action                       |
| ----------------------------------------------------------------- | ---------------------------- |
| `APPROVED`                                                        | `approve`                    |
| `CHANGES_REQUESTED`                                               | `request_changes`            |
| `DISMISSED` (only approvals and change requests can be dismissed) | `approve`: the work was done |
| `COMMENTED`, empty body, every comment a reply                    | `thread_reply`               |
| `COMMENTED`, otherwise                                            | `comment`                    |
| `COMMENTED`, empty body, no comments                              | nothing                      |
| `PENDING`                                                         | nothing                      |

A thread reply is not a real review: it neither covers lines nor moves the previous-review anchor.

### Viewed bonus

- Only my latest real review on a given commit gets the Viewed bonus, so three reviews on one head
  do not triple it.
- The snapshot is taken when that commit is still the PR head, and reused once the head moves.
  Snapshots of reviews that left the window are dropped.

### Rescue

`waitedHoursWithoutReview` is non-zero only when my review is the first review by a human other
than the PR author. It is measured from ready-for-review to my review.

### ↓ side

- A PR that is a draft now does not count. A PR that went back to draft and was marked ready
  again restarts its clock at the last ready-for-review event.
- Merged and closed PRs keep counting until day 7, with `closedAt` sent but unused by the formula.

### Time

- A record dated in the future (hour rounding, clock skew) counts as age 0.
- The server rounds ↑ and ↓ to whole RP and the ratio to two decimals. `ratio` is `null` when ↓
  is 0; the badge then shows `∞` or `—`.

### Refresh

- The 10-minute throttle counts from the last attempt, successful or not, so a broken server is not
  hammered. Saving the options lifts the throttle for the next page load.
- A refresh marks its start in storage. Another one may start only after 3 minutes, which covers a
  service worker killed mid-refresh.
- The class globs are cached for 24 hours. When the server cannot serve new ones, the cached globs
  are used.

### Limits

| Limit                      | Value                   | Why                         |
| -------------------------- | ----------------------- | --------------------------- |
| ↑ records per payload      | 2,000                   | A week never needs more     |
| ↓ records per payload      | 500                     |                             |
| Lines per class per record | 1,000,000               | Rejects absurd numbers      |
| Request body               | 256 KiB                 | A full payload is a few KiB |
| `POST /score` per client   | 120 per 10 minutes      | Stops a runaway client      |
| GitHub search              | 1,000 results per query | GitHub's own cap            |
| Review comments read       | 100 per review          | One GraphQL page            |

### Errors

| Situation                    | Status                                   |
| ---------------------------- | ---------------------------------------- |
| Body is not JSON             | 400 `invalid_json`                       |
| No integer `contractVersion` | 400 `invalid_payload`                    |
| Unknown major                | 400 `unsupported_version`                |
| Retired major                | 426 `upgrade_required`                   |
| Payload breaks the schema    | 400 `invalid_payload`, with the problems |
| Body over 256 KiB            | 413 `payload_too_large`                  |
| Rate limited                 | 429 `rate_limited`, with `Retry-After`   |
