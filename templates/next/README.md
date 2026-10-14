# {{name}}

A Lunora app on **Next.js** (App Router), scaffolded by `lunora init`.

Real-time queries flow through Lunora's WebSocket transport via `@lunora/react`
hooks, while Next.js owns routing and server rendering. A React Server
Component resolves the data on the server and the client hydrates it into a
**live subscription** — your Server Component load is live.

## How the live loader works

1. `app/page.tsx` (a Server Component) builds a request-scoped client with
   `createServerClient` from `@lunora/react/server` and runs `preloadQuery`
   during the server render (forwarding the request cookie so the load runs as
   the signed-in user). It returns a serializable `Preloaded` token.
2. The token crosses the RSC boundary as a plain object — no second network
   call on the client.
3. `components/message-feed.tsx` (a client component) hands the token to
   `usePreloadedQuery`, which seeds TanStack Query's cache **synchronously**
   (no loading flash) and then attaches a live WebSocket subscription that
   updates on every server delta.
4. `app/providers.tsx` provides the browser `LunoraClient` to the app via
   `LunoraProvider`, so `useQuery` / `useMutation` / `usePreloadedQuery`
   resolve it.

## Two-worker architecture

This template uses a **two-worker split** — the documented, supported way to run
Lunora alongside Next.js on Cloudflare Workers.

**Why two workers?** Next.js deploys to Cloudflare through the OpenNext adapter
(`@opennextjs/cloudflare`), which owns the worker entry it emits
(`.open-next/worker.js`). There is no supported hook to compose extra routes or
Durable Object classes into that output, so `/_lunora/*` can't ride inside the
Next worker.

### Worker 1 — Next.js SSR (`wrangler.opennext.jsonc`)

Built by `opennextjs-cloudflare build`. Handles all page requests, RSC renders,
and route handlers. The emitted `.open-next/worker.js` is the worker entry — no
custom entrypoint, no `ShardDO` export.

### Worker 2 — Lunora realtime (`wrangler.jsonc`)

A standalone Lunora worker (`lunora/server.ts`) that owns:

- `/_lunora/*` — RPC and WebSocket realtime traffic
- `ShardDO` — the Durable Object for state + subscriptions

This worker is identical in shape to the `standalone` template.

### Wiring the two workers together

Set `NEXT_PUBLIC_LUNORA_URL` to the Lunora worker's URL (e.g.
`https://{{name}}-lunora.workers.dev`). It must be present **at build time**
(Next.js inlines `NEXT_PUBLIC_*` into the client bundle) and configures:

- `app/page.tsx` — the RSC loader reaches `/_lunora/rpc` at this URL.
- `app/providers.tsx` — the browser `LunoraClient` connects its WebSocket here.

### Key files

- **`lunora/server.ts`** — standalone Lunora worker entry; exports `ShardDO`.
  Wrangler reads this via the root `wrangler.jsonc`.
- **`wrangler.jsonc`** — Lunora worker config with the `SHARD` DO binding and
  migration. Deploy with `wrangler deploy` (or `pnpm run deploy:lunora`). It is
  the ROOT config because `lunora verify` / `lunora deploy` / `lunora dev` probe
  `wrangler.jsonc` and require the `SHARD` binding.
- **`wrangler.opennext.jsonc`** — Next.js SSR worker config, passed to every
  OpenNext command with `--config`. Deploy with `pnpm run deploy:next` (or
  `pnpm deploy`, which ships both workers).
- **`open-next.config.ts`** — OpenNext Cloudflare adapter config (defaults).
- **`next.config.ts`** — standard Next.js config (no custom entrypoint).

## Develop

```bash
# Terminal 1 — Lunora worker (RPC + WebSocket + ShardDO)
pnpm dev:lunora            # wrangler dev, on the root wrangler.jsonc

# Terminal 2 — Next.js dev server (set the lunora port from terminal 1)
NEXT_PUBLIC_LUNORA_URL=http://localhost:8787 pnpm dev
```

`pnpm dev` runs `lunora codegen` (writes `lunora/_generated/`) and then
`next dev`. Start the Lunora worker first so `NEXT_PUBLIC_LUNORA_URL` is known
— the fallback in the code already matches `wrangler dev`'s default port 8787,
so with defaults you can also just run both commands as-is.

## Build and deploy

```bash
# 1. Deploy the Lunora worker first (get its URL)
pnpm deploy:lunora
#   → https://{{name}}-lunora.workers.dev

# 2. Build and deploy the Next.js SSR worker (env var is inlined at build time)
NEXT_PUBLIC_LUNORA_URL=https://{{name}}-lunora.workers.dev pnpm deploy:next
```

## Stack

- `next` — the React meta-framework (App Router, React Server Components)
- `@opennextjs/cloudflare` — the OpenNext Cloudflare adapter for Next.js
- `@lunora/react` — React hooks for Lunora (`useQuery`, `useMutation`,
  `usePreloadedQuery`) plus the RSC-safe `@lunora/react/server` loaders
- `@lunora/*` — the realtime backend on Cloudflare Workers + Durable Objects
