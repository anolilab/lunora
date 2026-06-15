# {{name}}

A Lunora app on **Nuxt**, scaffolded by `lunora init`.

Real-time queries flow through Lunora's WebSocket transport via `@lunora/vue`'s
composables, while Nuxt owns routing and SSR. A server route resolves the data
on the server and the client hydrates it into a **live subscription** — your
loader is live.

## How the live loader works

1. `server/api/messages.get.ts` builds a request-scoped client with
   `createServerClient` and runs `preloadQuery` during SSR (forwarding the
   request cookie so the load runs as the signed-in user). It returns a
   serializable `Preloaded` token.
2. `pages/index.vue` fetches that route with `useFetch`, so the token is
   resolved server-side and embedded in the SSR payload.
3. `components/MessageFeed.vue` hands the token to `hydratePreloaded`, which
   seeds a `ref` **synchronously** (no loading flash) and then attaches a live
   WebSocket subscription that updates on every server delta.
4. `plugins/lunora.client.ts` provides the browser `LunoraClient` to the app via
   `createLunora`, so `useQuery` / `useMutation` / `hydratePreloaded` resolve it.

## Two-worker architecture

This template uses a **two-worker split** — the documented, supported way to run
Lunora alongside Nuxt on Cloudflare Workers.

**Why two workers?** Nitro does not expose its emitted fetch handler as an
importable virtual module. There is no `#nitro-cloudflare-handler` specifier and
`nitro.cloudflare.entrypoint` is undocumented and absent from the Nitro API.
Without a hook to intercept Nitro's handler, composing `/_lunora/*` into the
Nitro output is not achievable through any supported mechanism.

### Worker 1 — Nuxt SSR (`wrangler.jsonc`)

Built by `nuxt build` (Nitro `cloudflare_module` preset). Handles all page
requests, API routes, and SSR. The emitted `.output/server/index.mjs` is the
worker entry — no custom entrypoint, no `ShardDO` export.

### Worker 2 — Lunora realtime (`wrangler.lunora.jsonc`)

A standalone Lunora worker (`lunora/server.ts`) that owns:

- `/_lunora/*` — RPC and WebSocket realtime traffic
- `ShardDO` — the Durable Object for state + subscriptions

This worker is identical in shape to the `standalone` template.

### Wiring the two workers together

Set `NUXT_PUBLIC_LUNORA_URL` to the Lunora worker's URL (e.g.
`https://{{name}}-lunora.workers.dev`). This configures:

- `runtimeConfig.public.lunoraUrl` — used by `server/api/messages.get.ts` to
  reach `/_lunora/rpc` during SSR.
- `plugins/lunora.client.ts` — the browser `LunoraClient` connects its WebSocket
  to this URL.

### Key files

- **`lunora/server.ts`** — standalone Lunora worker entry; exports `ShardDO` and
  calls `createWorker`. Wrangler reads this via `wrangler.lunora.jsonc`.
- **`wrangler.lunora.jsonc`** — Lunora worker config with the `SHARD` DO binding
  and migration. Deploy with `wrangler deploy --config wrangler.lunora.jsonc`.
- **`wrangler.jsonc`** — Nuxt SSR worker config. Deploy with `nuxt build &&
wrangler deploy` (or `pnpm deploy`).
- **`nuxt.config.ts`** — uses `cloudflare_module` preset (standard; no custom
  entrypoint).

## Develop

```bash
# Terminal 1 — Lunora worker (RPC + WebSocket + ShardDO)
wrangler dev --config wrangler.lunora.jsonc

# Terminal 2 — Nuxt SSR (set the lunora port from terminal 1)
NUXT_PUBLIC_LUNORA_URL=http://localhost:8788 pnpm dev
```

`pnpm dev` runs `lunora dev` for the Nuxt side. Start the Lunora worker first so
`NUXT_PUBLIC_LUNORA_URL` is known.

## Build and deploy

```bash
# 1. Deploy the Lunora worker first (get its URL)
wrangler deploy --config wrangler.lunora.jsonc
#   → https://{{name}}-lunora.workers.dev

# 2. Build and deploy the Nuxt SSR worker
NUXT_PUBLIC_LUNORA_URL=https://{{name}}-lunora.workers.dev pnpm build
wrangler deploy --config wrangler.jsonc
```

## Stack

- `nuxt` — the Vue meta-framework (Nitro server engine, `cloudflare_module` preset)
- `@lunora/vue` — Vue composables for Lunora (`useQuery`, `useMutation`,
  `hydratePreloaded`)
- `@lunora/*` — the realtime backend on Cloudflare Workers + Durable Objects
