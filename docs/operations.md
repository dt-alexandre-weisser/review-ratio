# Operations

## Server configuration

| Variable             | Default     | Meaning                                                                                                         |
| -------------------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `PORT`               | `8787`      | Listening port. The Docker image sets `8080`.                                                                   |
| `HOST`               | `127.0.0.1` | Listening address. The Docker image sets `0.0.0.0`.                                                             |
| `TRUSTED_PROXY_HOPS` | `0`         | Proxies in front of the server that append to `X-Forwarded-For`. `0` keys the rate limit on the socket address. |

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
docker run --rm -p 8080:8080 review-ratio-server
```

The image runs one self-contained bundle as the unprivileged `node` user and has a health check
on `/health`. On Cloud Run, set `TRUSTED_PROXY_HOPS=1`: Google's front end appends the client
address to `X-Forwarded-For`.

## Remote: Cloudflare Workers

```sh
pnpm --filter @review-ratio/server build:worker   # checks the bundle has no Node APIs
pnpm --filter @review-ratio/server exec wrangler deploy
```

`wrangler` is not a dependency of the repository; install it where you deploy. The rate limit
keys on `cf-connecting-ip` and lives in one isolate's memory, so it is a soft brake.

## Pointing the extension at a remote server

Set **Server URL** in the extension options. The server answers CORS for `chrome-extension://`
origins, so no manifest change is needed. For a fixed company URL, add it to `host_permissions`
in `packages/extension/manifest.json` and change `DEFAULT_SETTINGS.serverUrl`.

## Releasing the extension

1. Bump `version` in `packages/extension/package.json`; the build copies it into the manifest.
2. `pnpm check && pnpm test:e2e`.
3. Zip `packages/extension/dist` (CI uploads it as an artifact on every run).

## Contract majors

Adding and retiring a major are described in [CONTRIBUTING.md](../CONTRIBUTING.md#the-contract).
Before retiring a major, check that the extension builds in use have moved on: the server cannot
see who sends which major, so announce the update first.
