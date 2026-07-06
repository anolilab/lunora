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
`lunora/server`. Nitro's `cloudflare_module` output (`.output/server/index.mjs`)
exports only the SSR handler, so a thin root **`worker.ts`** wraps it — re-exporting
Nitro's handler as `default` plus the `ShardDO` class — and `wrangler.jsonc`
deploys that wrapper. One `wrangler.jsonc`, one deploy, a same-origin client.

### Key files

- **`nuxt.config.ts`** — registers `modules: ["@lunora/nuxt"]` and the
  `cloudflare_module` Nitro preset; runs Lunora codegen through the Vite plugin.
- **`worker.ts`** — the deploy entry (`wrangler.jsonc`'s `main`): re-exports
  Nitro's SSR handler (`.output/server/index.mjs`) as `default` plus the
  `ShardDO` class, so the composed worker exports the DO the `SHARD` binding needs.
- **`lunora/server.ts`** — the Lunora app (`defineApp().build()`); exports the
  app as `default` and the bound `ShardDO` class. `@lunora/nuxt` mounts this.
- **`wrangler.jsonc`** — the single worker config: `main` points at the
  `worker.ts` wrapper, with the `SHARD` DO binding + migration.
- **`server/api/messages.get.ts`** — SSR loader; calls `/_lunora/rpc` at the
  request's own origin (a same-origin sub-request into the in-worker Lunora app).
- **`plugins/lunora.client.ts`** — the browser `LunoraClient`, pointed at the
  page's own origin (it reaches `/_lunora/ws` on the same worker).

## Develop

Install dependencies, then start the dev server with the Lunora CLI:

```bash
<pm> install
<pm> exec lunora dev
```

`lunora dev` runs **two processes** for you: `nuxt dev` (the app + HMR at
`http://localhost:3000`) and a `wrangler dev` sidecar (`wrangler.dev.jsonc`,
`:8788`) running in `workerd` that owns the real `ShardDO` Durable Object. In
dev the browser `LunoraClient` talks to the sidecar directly (see
`plugins/lunora.client.ts`); the sidecar's `LUNORA_ALLOWED_ORIGINS` allows that
cross-origin call. Open `http://localhost:3000`. `Ctrl-C` stops both.

> Why the sidecar: `nuxt dev` runs Nitro's SSR in Node, and Cloudflare bindings
> in dev come from wrangler's `getPlatformProxy`, which cannot emulate an
> internal Durable Object — and WebSocket realtime needs `workerd`'s
> `WebSocketPair`, absent under Node. So the `/_lunora/**` route mounted in Nitro
> is a prod-only path; in dev the client hits the real `workerd` sidecar instead.
> (If you add auth, add `http://localhost:3000` to the app's
> `security.csrf.trustedOrigins` so the cookie-bearing WebSocket handshake passes.)

## Build and deploy

```bash
pnpm deploy        # nuxt build && wrangler deploy
```

## Verify before deploy

The `worker.ts` wrapper makes the `ShardDO` export version-independent (it wraps
Nitro's output rather than relying on a Nitro export hook). Two Nitro behaviours
still vary across versions — check them against the toolchain this template pins:

1. **Nitro output path** — `worker.ts` imports `./.output/server/index.mjs`, and
   `wrangler.jsonc`'s `main` is `worker.ts`. Some Nitro versions emit
   `dist/server/index.mjs` instead; if the import can't resolve at deploy, point
   `worker.ts`'s import at whatever `nuxt build` actually produces.
2. **WebSocket upgrade pass-through** — the live feed needs Nitro to return the
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
