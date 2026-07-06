# {{name}}

A Lunora app on **SvelteKit**, scaffolded by `lunora init`.

Your route loaders are live: a `+page.ts` loader preloads Lunora data on the
server (read-your-writes SSR), the HTML ships with it, and on the client the
**same** data hydrates into a live subscription via `@lunora/svelte`'s
`hydratePreloaded` — re-rendering on every server write with no loading flash.

## Develop

Install dependencies, then start the dev server with the Lunora CLI:

```bash
<pm> install
<pm> exec lunora dev
```

`lunora dev` runs **two processes** for you: SvelteKit's own Vite dev server
(the front door at `http://localhost:5173`, with HMR) and a `wrangler dev`
sidecar (`wrangler.dev.jsonc`, `:8787`) running in `workerd` that owns the real
`ShardDO` Durable Object. Vite proxies `/_lunora/*` (RPC + the WebSocket) to the
sidecar — see `vite.config.ts` — so the browser client stays same-origin and
realtime works with live DOs in dev, not just after deploy. Open
`http://localhost:5173`. `Ctrl-C` tears both processes down.

> Why two processes: SvelteKit's dev server runs SSR in Node, and
> `@sveltejs/adapter-cloudflare` gets its bindings from wrangler's
> `getPlatformProxy`, which cannot emulate an internal Durable Object. The
> sidecar is a real `workerd` so `ShardDO` behaves exactly as it does deployed.
> Running `<pm> run dev` (bare `vite`) works for UI/HMR but has no live `ShardDO`.
>
> Harmless startup noise: because the adapter's `getPlatformProxy` reads the same
> `wrangler.jsonc`, dev logs a `"…internal Durable Objects…will not work in local
development"` / `"ShardDO…not exported"` warning. That's the adapter's own empty
> binding stub — your `ShardDO` runs in the sidecar and `/_lunora/*` reaches it
> through the Vite proxy, so realtime works regardless. SvelteKit `load`/`+server`
> code must reach Lunora via `/_lunora/*` (same origin), not `platform.env.SHARD`.

## What's wired

- `lunora/schema.ts` + `lunora/messages.ts` — a sharded `messages` table with a
  sample `list` query and `send` mutation.
- `src/worker.ts` — the **single-worker entry**: wraps SvelteKit's
  Cloudflare-adapter handler with `withLunora` (see below) and re-exports the
  generated `ShardDO`.
- `src/routes/+layout.svelte` — publishes the `LunoraClient` on Svelte context
  with `setLunoraClient` (the provider), pointed at the **same origin**.
- `src/routes/+page.ts` — a universal `load` that calls `preloadQuery` through a
  request-scoped `createServerClient`, forwarding SvelteKit's `fetch` for
  same-origin session continuity. Because Lunora is mounted in the same worker,
  it is a same-origin loopback.
- `src/routes/+page.svelte` — uses `hydratePreloaded(data.preloaded)` for the
  SSR-seed-to-live handoff and `mutation(api.messages.send)` for optimistic writes.

## Stack

- `@sveltejs/kit` — the meta-framework (file-based routing + load functions)
- `svelte` (5) — runes/stores UI runtime
- `@lunora/svelte` — live stores, optimistic mutations, `hydratePreloaded`
- `@lunora/svelte/worker` — `withLunora` single-worker composition
- `@lunora/*` — the realtime backend on Cloudflare Workers + Durable Objects

---

## Class-B composition: one worker, Lunora mounted under `/_lunora/*`

SvelteKit is a **Class-B** framework: it owns its own Cloudflare adapter
(`@sveltejs/adapter-cloudflare`) and builds its own server worker. So unlike the
Class-A frameworks (TanStack Start, SolidStart), Lunora does **not** own the
worker entry — it **injects** its realtime plane into the very worker SvelteKit
emits.

How it's wired here:

- **`svelte.config.js`** uses `@sveltejs/adapter-cloudflare`, which builds
  SvelteKit's SSR into `.svelte-kit/cloudflare/_worker.js`.
- **`src/worker.ts`** imports that emitted handler and wraps it with
  `withLunora` from `@lunora/svelte/worker`:

    ```ts
    import { withLunora } from "@lunora/svelte/worker";
    import svelteKitWorker from "../.svelte-kit/cloudflare/_worker.js";
    import { createShardDO } from "../lunora/_generated/shard.js";

    export const ShardDO = createShardDO();

    export default withLunora(svelteKitWorker, (env) => ({
        shardDO: env.SHARD,
        // …auth, routes, functions, openApiSpec
    }));
    ```

- **`wrangler.jsonc`**'s `main` points at `src/worker.ts` (not at SvelteKit's
  emitted `_worker.js`), and binds the `SHARD` Durable Object. One Worker bundles
  both planes — no double-bundling the DO class.

The composed worker reserves `/_lunora/*` for Lunora realtime (`/_lunora/rpc`,
`/_lunora/ws`, `/_lunora/admin/*`) and forwards **everything else** to
SvelteKit's SSR handler. The two dispatch flows never collide: pages/API/SSR →
SvelteKit; queries/mutations/subscriptions → `/_lunora/*`. A SvelteKit render
that throws is contained at the seam as a plain 500 and can never take down
`/_lunora/*`.

Because it's one worker, the `+page.ts` loader's `preloadQuery` is a
**same-origin loopback** and the client subscription resumes the same
cookie-based identity on the same origin — no separate worker, one deploy. Set
`VITE_LUNORA_URL` only if you deliberately split Lunora out to a standalone
worker.

> Status: the `withLunora` composition is unit/contract-proven in
> `@lunora/svelte` (`packages/svelte/__tests__/worker.test.ts`). The
> `@sveltejs/adapter-cloudflare` build itself isn't exercised in this repo, so
> the `src/worker.ts` / `wrangler.jsonc` wiring above is a scaffold to run
> against a real `vite build` + `wrangler deploy`.
