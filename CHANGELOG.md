# Changelog

## 0.1.0 (unreleased)

First prototype.

- Contract major 1: anonymous payload schema with a strict key allowlist at every level, UTC
  timestamps, fixtures, and append-only pins of the schema and fixtures.
- Server: `POST /score` with the opaque formula, `GET /classes`, `GET /health`; decoders per
  major with `426` for retired majors; JSON-only bodies, body and rate limits with explicit proxy
  configuration, CORS for the extension; Node and Cloudflare Workers entry points; hardened Docker
  image.
- Extension (Chrome MV3): badge in the GitHub header with every state of the design; options page
  with token, organisation, exclude list and server URL, diagnostics and a connection test that
  checks organisation access; per-file review coverage, cached comparisons, per-PR error
  isolation, rate-limit back-off; token hidden from content scripts.
- Activity log on the options page: every call of the last 30 minutes with its time, status and
  duration, plus refresh start and end lines; live, copyable, kept in memory only.
- The badge sits just left of the header's search bar, and checks that it shows there. When the
  header has no place for it, it floats in the bottom-right corner instead of not showing; the
  options page says where it went and what it saw of the header. ↑ and ↓ take GitHub's colours
  for added and removed lines, from the user's theme.
- CI: format, lint, typecheck (scripts included), unit and contract tests with per-package
  coverage thresholds, released-pin comparison with `main`, build, end-to-end tests in Chromium,
  Docker image smoke test.
