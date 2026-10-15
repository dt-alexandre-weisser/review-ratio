# Changelog

## 0.1.0 (unreleased)

First prototype.

- Contract major 1: anonymous payload schema, fixtures, frozen-schema gate.
- Server: `POST /score` with the opaque formula, `GET /classes`, `GET /health`; decoders per
  major with `426` for retired majors; rate limit, body limit, CORS for the extension; Node and
  Cloudflare Workers entry points; Docker image.
- Extension (Chrome MV3): badge in the GitHub header with every state of the design, options page
  with token, organisation, exclude list and server URL, diagnostics and connection test.
- CI: format, lint, typecheck, unit and contract tests with coverage, build, end-to-end tests in
  Chromium, Docker image smoke test.
