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

## Single-worker architecture

This template ships the **whole app as one Cloudflare Worker** — Nuxt SSR and the
Lunora realtime plane in a single deploy — via the [`@lunora/nuxt`](https://lunora.sh)
module.

**How?** `@lunora/nuxt` mounts Lunora _inside_ Nitro: it registers a server route
at `/_lunora/**` (`addServerHandler`) that forwards every RPC / WebSocket / admin
request to the Lunora app in-process, and aliases the `#lunora/app` virtual to
`lunora/server`. The `ShardDO` Durable Object class reaches the emitted Cloudflare
worker entry through the project-root `exports.cloudflare.ts` (the Nitro
`cloudflare_module` preset appends its named exports). One `wrangler.jsonc`, one
deploy, a same-origin client.

### Key files

- **`nuxt.config.ts`** — registers `modules: ["@lunora/nuxt"]` and the
  `cloudflare_module` Nitro preset; runs Lunora codegen through the Vite plugin.
- **`exports.cloudflare.ts`** — re-exports `ShardDO` onto the Nitro worker entry
  so the `SHARD` binding resolves. (If your Nitro/Nuxt version doesn't pick this
  file up, see **Verify before deploy** below.)
- **`lunora/server.ts`** — the Lunora app (`defineApp().build()`); exports the
  app as `default` and the bound `ShardDO` class. `@lunora/nuxt` mounts this.
- **`wrangler.jsonc`** — the single worker config: `main` points at Nitro's
  output (`.output/server/index.mjs`), with the `SHARD` DO binding + migration.
- **`server/api/messages.get.ts`** — SSR loader; calls `/_lunora/rpc` at the
  request's own origin (a same-origin sub-request into the in-worker Lunora app).
- **`plugins/lunora.client.ts`** — the browser `LunoraClient`, pointed at the
  page's own origin (it reaches `/_lunora/ws` on the same worker).

## Develop

Start the dev server with your package manager (`npm`, `pnpm`, `yarn`, or `bun`):

```bash
<pm> run dev
```

`nuxt dev` serves the app and the `/_lunora/**` route together. Live queries
need the Cloudflare bindings (the `SHARD` Durable Object) in dev — Nuxt surfaces
them through Nitro's Cloudflare dev runtime; if a live query reports
`LUNORA_RUNTIME_UNAVAILABLE`, enable the Cloudflare Nitro dev runtime (e.g.
`nitro-cloudflare-dev`) so `event.context.cloudflare` is populated.

## Build and deploy

```bash
pnpm deploy        # nuxt build && wrangler deploy
```

## Verify before deploy

Single-worker composition rides on two Nitro behaviours that vary across versions
— check them against the toolchain this template pins for you:

1. **`exports.cloudflare.ts` hook** — the `cloudflare_module` preset must append
   this file's exports onto `.output/server/index.mjs`. If `wrangler deploy` fails
   with "ShardDO class not exported", your Nitro version may use a different hook
   (`nitro.cloudflare.additionalModules`, or a `rollupConfig` output export).
2. **`main` target** — some Nitro versions emit `dist/server/index.mjs` instead of
   `.output/server/index.mjs`; point `wrangler.jsonc`'s `main` at whatever
   `nuxt build` actually produces.
3. **WebSocket upgrade pass-through** — the live feed needs Nitro to return the
   Lunora app's `101 Switching Protocols` response (carrying its Cloudflare
   `webSocket`) untouched. RPC (plain JSON) works regardless; if live
   subscriptions never connect while RPC does, Nitro is normalising the upgrade
   response and the seam needs a deploy-boundary handoff for `/_lunora/ws`.

## Stack

- `nuxt` — the Vue meta-framework (Nitro server engine, `cloudflare_module` preset)
- `@lunora/nuxt` — mounts Lunora inside Nitro for single-worker deploys
- `@lunora/vue` — Vue composables for Lunora (`useQuery`, `useMutation`,
  `hydratePreloaded`)
- `@lunora/*` — the realtime backend on Cloudflare Workers + Durable Objects
