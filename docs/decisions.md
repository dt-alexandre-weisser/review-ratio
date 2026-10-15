# Implementation decisions

DESIGN.md is the source of truth for the product. This file records what the design left open,
and the few places where the code deliberately differs from it. Each entry says why.

## Deviations from the design

### Commented lines are rounded without bias

The design rounds every line count to the nearest 10 before it leaves the browser. Taken
literally, that erases the comment term: a typical review comment covers one to four lines, which
rounds to 0, and a thread reply earns nothing else.

Commented lines are therefore rounded to a multiple of 10 with a probability proportional to the
remainder: 3 lines become 10 with probability 0.3, otherwise 0. The expected value is exact and
the payload keeps its 10-line granularity. The draw comes from a hash of the review id, so a
review rounds the same way on every refresh and the badge does not flicker.

Covered, Viewed and ↓ lines keep the design's rounding to the nearest 10. Equal sizes then round
alike on both sides, which the anchor invariant needs: with independent draws, an approve on a
15-line PR would balance my own 15-line PR only half of the time.

**To revert:** drop the seed argument of `roundLinesByClass` for commented lines in
`packages/extension/src/lib/payload.ts`.

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
- Matching is case-sensitive, like Git, and always uses `/`. The extension matches with its own
  glob matcher (`packages/extension/src/lib/glob.ts`), not regular expressions: compiled to
  regular expressions, a crafted server glob backtracked for seconds per path. The matcher agrees
  with picomatch (`{ dot: true }`) on every published glob and on 200,000 fuzzed cases; the one
  known difference is a path segment literally named like a brace pattern, which picomatch also
  matches as text. A refresh spends at most 5 seconds classifying, whatever the globs.
- `scripts/`, `tools/` and `bin/` are tooling at the repository root or at the top of a monorepo
  package only: `src/agent/tools/` is production code.
- `*Test.*` is a test only in languages that name tests that way (C#, Java, Kotlin…): `ABTest.tsx`
  is a component.
- Scaffolded migrations (EF Core, Django, Alembic) and vendored code (`vendor/`, `wwwroot/lib/`)
  are `generated`. Hand-written SQL migrations and GraphQL schemas are `production`.

### ↑ covered lines

- My first review of a PR covers the PR's diff at the reviewed commit, compared from the PR's
  fork point (the parent of its first commit). The fork point stays meaningful after the PR is
  merged, unlike the base branch tip. When the reviewed commit is the head, the PR's file list
  answers without a compare call.
- A later review covers the diff since my previous real review's commit.
- Either way, only files of the PR count, each capped by its own diff in the PR. A merge of the
  base branch into the PR ("Update branch") or a rebase brings in other files and larger diffs;
  none of that counts as reviewed code.
- Each reviewed commit is credited once, to my strongest review on it: an approval or a change
  request beats a comment review. Among equally strong reviews the earliest keeps the credit, so
  approving the same commit again does not restart its decay; but a review made once the PR was
  ready takes the credit from an equally strong review of the draft. Commenting first and approving the
  same commit afterwards is worth the same as approving, rescue included. The weaker review keeps
  its commented lines.
- A review whose commit GitHub no longer knows covers nothing: it cannot be placed in the PR's
  history without risking double counting.
- When GitHub cannot compare any more (force-push, garbage-collected commit, server error), the
  review covers the PR's diff.
- GitHub returns at most 300 files per comparison. Larger diffs are undercounted.
- Comparisons of two SHAs never change, so they are cached locally between refreshes.
- Records are sent sorted by time, ties in hash order, so their order does not group the reviews
  of one PR.

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

A thread reply is not a real review: it covers no lines and does not move the previous-review
anchor. A reply's commented lines are its thread's range, as the design says; see the open
question below.

### Viewed bonus

- The bonus covers the files of the credited range that I marked Viewed: on a re-review, only
  the files that changed since my previous review. Files that stayed Viewed from an earlier round
  do not earn it again.
- The snapshot is taken while the reviewed commit is still the PR head, and reused once the head
  moves. Snapshots are kept for 7 days, even when their PR could not be read on one refresh.

### Ownership and rescue

- A PR is mine when I authored it, or when it is a `github-actions` PR assigned to me. I earn no ↑
  on a PR that is mine, even when GitHub lets me approve it.
- `waitedHoursWithoutReview` is non-zero only when my review is the first review by a human who
  does not own the PR since it first became ready. The wait counts only the time the PR spent
  ready for review before that first review, from its draft and ready events: draft periods never
  count, and converting a PR back to draft later does not take an earned rescue away. Reviews of
  the draft before it first became ready do not count. The wait is rounded up, so the server's
  "more than 48 hours" test is exact. The rescue goes with the covered lines of the commit the
  first review was on, when that credited review is the first review or a later one.

### ↓ side

- A PR that is a draft now does not count. A PR that went back to draft and was marked ready
  again restarts its clock at the last ready-for-review event.
- Merged and closed PRs keep counting until day 7, with `closedAt` sent but unused by the formula.

### Time

- Timestamps are UTC (`Z`); the schema rejects any other zone, which a server would read in its
  own local time.
- A record dated up to 2 hours in the future (hour rounding, clock drift) counts as age 0. Further
  in the future, it counts for nothing: a forged date cannot escape the decay.
- The server rounds ↑ and ↓ to whole RP and the ratio to two decimals. `ratio` is `null` when ↓
  is 0; the badge then shows `∞` or `—`.

### Refresh

- The 10-minute throttle counts from the last attempt, successful or not, so a broken server is not
  hammered. Saving the options refreshes at once.
- The server's class globs are fetched first on every refresh: a server that is down costs no
  GitHub call.
- One PR that GitHub cannot serve is skipped and reported in the options page. The refresh fails
  when most PRs fail, or on an auth or rate-limit error.
- A GitHub rate limit (REST or GraphQL) postpones the next refresh until it resets, at most an
  hour. Times left in the future by a clock change are ignored.
- Refreshes run one at a time. A refresh forced from the options page runs after the one in
  progress, so it always uses the settings just saved.
- A refresh marks its start in storage, and counts refreshes that started without finishing.
  Another may start only after 5 minutes, which covers a service worker killed mid-refresh. The
  score is shown greyed when a refresh has run for more than 5 minutes, or when the current one
  follows a refresh that died; a refresh that is merely running does not grey it. While a refresh runs, the
  worker calls a cheap extension API every 20 seconds so Chrome does not stop it for idleness, and
  each GitHub request times out after 25 seconds, under Chrome's 30-second limit.

### Badge states

| Status             | Cause                                   | Badge                                  |
| ------------------ | --------------------------------------- | -------------------------------------- |
| `ok`               | last refresh succeeded                  | the ratio, coloured                    |
| `stale`            | the review-ratio server failed          | last ratio greyed, `stale since HH:MM` |
| `github_error`     | GitHub failed, rate limited, or refused | same as `stale`                        |
| `upgrade_required` | the server answered 426                 | `update the extension`                 |
| `bad_token`        | GitHub answered 401                     | `review-ratio: token rejected`         |
| `no_token`         | no token yet                            | `review-ratio: set up`                 |

### Limits

| Limit                               | Value                                                                | Why                                                           |
| ----------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| ↑ records per payload               | 500, newest kept                                                     | A week of one person never needs more                         |
| ↓ records per payload               | 200, newest kept                                                     |                                                               |
| Lines per class per record          | 1,000,000, clamped                                                   | One huge data file must not break the badge                   |
| Request body                        | 512 KiB                                                              | The largest valid payload fits                                |
| Validation problems echoed          | 10                                                                   | Keeps error answers small                                     |
| Keys per object, array items, depth | 32, 1,000, 8                                                         | Rejected cheaply, before schema validation                    |
| Failed records validated            | 10                                                                   | An invalid payload is rejected in milliseconds                |
| Published globs                     | 1,000; 200 characters each; 2,000 patterns after braces; 32 segments | No regular expressions; 5 s classification budget per refresh |
| `POST /score` per client            | 600 per 10 minutes, configurable                                     | Room for an office behind one address                         |
| GitHub search                       | 1,000 results per query                                              | GitHub's own cap                                              |
| Reviews read per PR                 | 100 (all of mine)                                                    | One GraphQL page; mine are paginated                          |
| Review comments read                | 100 per review                                                       | One GraphQL page                                              |

### Errors

| Situation                    | Status                                        |
| ---------------------------- | --------------------------------------------- |
| Body not declared as JSON    | 415 `unsupported_media_type`                  |
| Body is not JSON             | 400 `invalid_json`                            |
| No integer `contractVersion` | 400 `invalid_payload`                         |
| Unknown major                | 400 `unsupported_version`                     |
| Retired major                | 426 `upgrade_required`                        |
| Payload breaks the schema    | 400 `invalid_payload`, with up to 10 problems |
| Body over 512 KiB            | 413 `payload_too_large`                       |
| Rate limited                 | 429 `rate_limited`, with `Retry-After`        |

## Open questions for the product owner

- **Thread replies inherit their thread's range.** A one-word reply on a 20-line thread earns
  20 × 10 = 200 RP, as much as approving 200 lines. Counting a reply as one line would close that.
- **Data minimisation.** The formula never reads `prKey` or `closedAt`, and only compares
  `waitedHoursWithoutReview` with 48. A future major could drop the first two and send a
  `rescued` boolean, which would make records harder to link to a PR. See SECURITY.md.
