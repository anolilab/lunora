# {{name}}

A Cirrus app on **React Router v7** (framework mode), scaffolded by `cirrus init`.

Your loaders are live. The route `loader` runs on the server (inside the
Cloudflare Worker), calls `preloadQuery` so the HTML ships with data, and on the
client that same data hydrates into a live `useQuery` that re-renders on every
write — no refetch, no loading flash.

## How it composes

One Cloudflare Worker (`workers/app.ts`) wraps both halves with
`createWorker({ httpRouter })`:

- `/_cirrus/rpc` + `/_cirrus/ws` → Cirrus realtime (RPC + WebSocket subscriptions).
- everything else → the React Router SSR handler (`createRequestHandler`).

They never collide: reserved `/_cirrus/*` paths route to Cirrus, every other
path to React Router. The `@cirrus/vite` plugin detects React Router (class A),
runs codegen, and reconciles the `SHARD` Durable Object binding into
`wrangler.jsonc`.

## Develop

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs `cirrus dev`, which boots the React Router dev server alongside
the Cirrus worker so your client and worker share one origin.

## Build

```bash
pnpm build      # react-router build
pnpm deploy     # cirrus deploy → one Cloudflare Worker
```

## Generated files (do not edit, do not commit)

These are produced by the framework's typegen / Cirrus codegen on the first
`pnpm dev`, `pnpm typecheck`, or `pnpm build`, and are gitignored:

- `.react-router/` — React Router's route types (`react-router typegen`). The
  per-route `./+types/<route>` imports (e.g. `./+types/home`) resolve here.
- `cirrus/_generated/` — the Cirrus API client, function registry, OpenAPI
  document, and `ShardDO` factory (`cirrus codegen`).

## Stack

- `react-router` (v7, framework mode) — type-safe SSR routing with live loaders
- `@tanstack/react-query` — async cache (powers Cirrus's `useQuery`)
- `@cirrus/*` — the realtime backend on Cloudflare Workers + Durable Objects
