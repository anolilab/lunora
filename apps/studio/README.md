# @lunora/studio-app

A standalone, deployable build of the Lunora studio. It's a plain Vite SPA
that talks to a remote Lunora worker over HTTP — it ships no worker of its own.

For zero-config local use you usually don't need this app: `lunora dev` (and the
`@lunora/vite` plugin) serves the studio at `/__lunora` against your own
worker. Reach for this app when you want to **host** the studio separately
(e.g. an internal ops site pointed at a production deployment).

## Run

```bash
# Defaults to the playground worker on :5173. Point it at a different local
# worker with LUNORA_DEV_PROXY (vite proxies HTTP + WebSocket to it).
LUNORA_DEV_PROXY=http://localhost:5173 pnpm --filter @lunora/studio-app dev
```

Then open http://localhost:5174 and paste your `LUNORA_ADMIN_TOKEN` into the
header field (or pre-fill it in dev with `VITE_LUNORA_ADMIN_TOKEN`).

In the **dev server** the studio always talks to its own origin and vite's
`/_lunora` proxy forwards every call to the worker, so the browser only ever uses
one origin. `VITE_LUNORA_URL` is therefore **ignored in dev** — to target a
different worker, set `LUNORA_DEV_PROXY` (the proxy target), not `VITE_LUNORA_URL`.
This avoids a cross-origin setup that could storm the socket pool against a cold
worker. `VITE_LUNORA_URL` still applies to a **static/production build** (below).

## Build

```bash
pnpm --filter @lunora/studio-app build   # → dist/ static assets
```

Serve `dist/` from any static host (or reverse-proxy it in front of the worker
so `location.origin` resolves to the same deployment and `VITE_LUNORA_URL` can
be omitted).

## Configuration

| Env var                   | Purpose                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `LUNORA_DEV_PROXY`        | Dev-server only: the worker the `/_lunora` proxy forwards to. Defaults to `:5173`.        |
| `VITE_LUNORA_URL`         | **Static/prod build only** (ignored in dev): worker base URL. Defaults to current origin. |
| `VITE_LUNORA_ADMIN_TOKEN` | Pre-fills the admin token (dev only — never bake into prod).                              |

The worker must be built with `adminToken` set and the matching admin endpoints
configured (see `@lunora/studio`'s README).
