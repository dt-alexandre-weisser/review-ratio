# Operations

## Server configuration

| Variable                | Default     | Meaning                                                                                                                                                         |
| ----------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | `8787`      | Listening port. The Docker image sets `8080`.                                                                                                                   |
| `HOST`                  | `127.0.0.1` | Listening address. The Docker image sets `0.0.0.0`.                                                                                                             |
| `TRUSTED_PROXY_HOPS`    | none        | Proxies in front of the server that append to `X-Forwarded-For`. Required whenever `HOST` is not a loopback address: the server refuses to start without it.    |
| `RATE_LIMIT_PER_10_MIN` | `600`       | `POST /score` requests per client address and 10 minutes. A badge needs about one; size it for the developers behind your largest shared address (office, VPN). |

`TRUSTED_PROXY_HOPS` decides what the rate limit keys on:

| Deployment                                 | Value | Rate limit key               |
| ------------------------------------------ | ----- | ---------------------------- |
| Clients connect straight to the server     | `0`   | socket address               |
| Cloud Run (Google's front end appends one) | `1`   | last `X-Forwarded-For` entry |
| A load balancer in front of Cloud Run      | `2`   | second to last entry         |

A wrong value either lets clients forge their key or puts every client in one bucket. Check the
value with a real request before launch. IPv6 clients are keyed by their /64 prefix.

Endpoints:

| Route          | Purpose                                                |
| -------------- | ------------------------------------------------------ |
| `GET /health`  | Liveness, server version, supported and retired majors |
| `GET /classes` | Class names and globs, cacheable for an hour           |
| `POST /score`  | `{ up, down, ratio }` for a payload                    |

Logs are one line per request on stdout: method, path, status, duration, request id. Errors go to
stderr with the request id. Bodies are never logged.

## Prototype: local

```sh
pnpm install && pnpm build
pnpm dev:server     # or: node packages/server/dist/node.js
```

The extension's default server URL is `http://127.0.0.1:8787`, which its manifest allows.

## Remote: container (Cloud Run or any container host)

```sh
docker build -f packages/server/Dockerfile -t review-ratio-server .
docker run --rm -p 8080:8080 -e TRUSTED_PROXY_HOPS=0 review-ratio-server
```

The image runs one self-contained bundle, with source maps, as the unprivileged `node` user on
root-owned code. It has no package manager (npm, yarn, corepack and apk are removed; the Alpine
package database stays, for image scanners) and a health check on `/health`. The base image is
pinned by digest in the `FROM` lines; Dependabot proposes updates. On Cloud Run, set
`TRUSTED_PROXY_HOPS=1`.

Cloud Run's request logs record client addresses and user agents. The app logs neither; to keep
the platform from doing it, add a log exclusion before the remote phase:

```sh
gcloud logging sinks update _Default --add-exclusion=name=review-ratio-requests,filter='resource.type="cloud_run_revision" AND log_name:"run.googleapis.com%2Frequests" AND resource.labels.service_name="review-ratio"'
```

## Remote: Cloudflare Workers

```sh
pnpm --filter @review-ratio/server build:worker   # checks the bundle has no Node APIs
pnpm --filter @review-ratio/server exec wrangler deploy
```

`wrangler` is not a dependency of the repository; install it where you deploy. Wrangler bundles
`src/worker.ts` itself; `build:worker` only proves in CI that it bundles without Node APIs. The
rate limit keys on `cf-connecting-ip` and lives in one isolate's memory, so it is a soft brake.
Platform observability is off in `wrangler.toml`: it would record client addresses.

## Pointing the extension at a remote server

Set **Server URL** in the extension options. A remote server must use HTTPS; plain HTTP is only
accepted for `localhost` and `127.0.0.1`. The server answers CORS for `chrome-extension://`
origins, so no manifest change is needed. For a fixed company URL, add it to `host_permissions`
in `packages/extension/manifest.json` and change `DEFAULT_SETTINGS.serverUrl`.

## Releasing the extension

1. Bump `version` in `packages/extension/package.json`; the build copies it into the manifest.
2. `pnpm check && pnpm test:e2e`.
3. Zip `packages/extension/dist` (CI uploads it as an artifact on every run).
4. On update, the extension injects its new content script into GitHub tabs that are already
   open; the old one stops itself.

The manifest's `key` gives unpacked installs a fixed id. The Chrome Web Store assigns its own key;
remove `key` from the manifest when publishing there.

## Contract majors

Adding and retiring a major are described in [CONTRIBUTING.md](../CONTRIBUTING.md#the-contract).
Before retiring a major, check that the extension builds in use have moved on: the server cannot
see who sends which major, so announce the update first.
