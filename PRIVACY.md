# Privacy policy

review-ratio is a browser extension that shows you, in the github.com header, how much code review
you gave compared to how much you asked for. This policy covers the extension, whether installed
from a release zip or from the Chrome Web Store.

## What the extension handles

- **Your GitHub credentials**: the tokens of the review-ratio GitHub App you sign in with, or a
  personal access token you paste. They are stored in your browser and sent only to GitHub
  (`api.github.com` and `github.com/login`).
- **Your review activity on GitHub**: pull requests, reviews, file paths and line counts of the
  last 7 days, read from the GitHub API with your own read-only access. The extension turns them
  into numbers in your browser and keeps those numbers, not the file paths.
- **Its settings and caches**: your organisation, exclude list, the last badge and cached
  comparisons, in your browser.
- **An activity log** of the calls it made in the last 30 minutes, in memory only, gone when the
  browser closes.

## What leaves your browser

Only the calls to GitHub that read your activity and sign you in. There is no review-ratio server:
no data is sent to the developer or to anyone else, there is no analytics and no telemetry, and
nobody but you sees your ratio.

## What the developer receives

Nothing. The developer does not collect, sell, transfer or share any data, and does not use it for
anything but showing you your ratio.

## Deleting your data

**Forget local activity data** on the options page clears the caches and the log. **Sign out**
forgets the GitHub tokens. Removing the extension deletes everything it stored. To revoke the
GitHub App's access at GitHub: **Settings › Applications › Authorized GitHub Apps › review-ratio ›
Revoke**.

## More

The technical details are in [SECURITY.md](SECURITY.md). Questions: open an issue on
<https://github.com/dt-alexandre-weisser/review-ratio>.
