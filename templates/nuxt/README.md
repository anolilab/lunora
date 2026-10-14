# {{name}}

A Lunora app on **Nuxt**, scaffolded by `lunora init`.

The scaffold ships a static welcome page plus the wiring behind it: a sharded
schema, the typed API, and one Cloudflare Worker that serves Nuxt SSR and the
Lunora realtime plane together. `plugins/lunora.ts` already provides the
`LunoraClient`, so `useQuery` / `useMutation` / `hydratePreloaded` from
`@lunora/vue` resolve in any component you add.

## Making a loader live

The scaffold does not load data yet. To go live:

1. Add a server route (e.g. `server/api/messages.get.ts`) that builds a
   request-scoped client with `createServerClient` and runs `preloadQuery`
   during SSR (forward the request cookie so the load runs as the signed-in
   user). It returns a serializable `Preloaded` token.
2. Fetch that route from a page with `useFetch`, so the token resolves
   server-side and is embedded in the SSR payload.
3. Hand the token to `hydratePreloaded` in a component. It seeds a `ref`
   **synchronously** (no loading flash) and then attaches a live WebSocket
   subscription that updates on every server delta.

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
- **`plugins/lunora.ts`** — the `LunoraClient`, pointed at the page's own
  origin in production (it reaches `/_lunora/ws` on the same worker) and at the
  `wrangler dev` sidecar in dev. Universal, not `.client.ts`: `@lunora/vue`'s
  composables resolve the client during SSR too, and throw without a provider.
- **`pages/index.vue`** — the static welcome page. It loads no data; see
  "Making a loader live" above.

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
`plugins/lunora.ts`); the sidecar's `LUNORA_ALLOWED_ORIGINS` allows that
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
   `wrangler.jsonc`'s `main` is `worker.ts`; `assets.directory` is
   `.output/public`, the preset's `output.publicDir`. Some Nitro versions emit
   `dist/server/index.mjs` and `dist/public` instead; if the import can't resolve
   at deploy, or wrangler reads 0 files from the assets directory, point both at
   whatever `nuxt build` actually produces.
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
