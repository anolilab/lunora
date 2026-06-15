# @lunora/studio-app

A standalone, deployable build of the Lunora studio. It's a plain Vite SPA
that talks to a remote Lunora worker over HTTP — it ships no worker of its own.

For zero-config local use you usually don't need this app: `lunora dev` (and the
`@lunora/vite` plugin) serves the studio at `/__lunora` against your own
worker. Reach for this app when you want to **host** the studio separately
(e.g. an internal ops site pointed at a production deployment).

## Run

```bash
# point it at a worker; defaults to the current origin when unset
VITE_LUNORA_URL=https://my-app.workers.dev pnpm --filter @lunora/studio-app dev
```

Then open http://localhost:5174 and paste your `LUNORA_ADMIN_TOKEN` into the
header field (or pre-fill it in dev with `VITE_LUNORA_ADMIN_TOKEN`).

## Build

```bash
pnpm --filter @lunora/studio-app build   # → dist/ static assets
```

Serve `dist/` from any static host (or reverse-proxy it in front of the worker
so `location.origin` resolves to the same deployment and `VITE_LUNORA_URL` can
be omitted).

## Configuration

| Env var                   | Purpose                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `VITE_LUNORA_URL`         | Base URL of the worker. Defaults to the current origin.      |
| `VITE_LUNORA_ADMIN_TOKEN` | Pre-fills the admin token (dev only — never bake into prod). |

The worker must be built with `adminToken` set and the matching admin endpoints
configured (see `@lunora/studio`'s README).
