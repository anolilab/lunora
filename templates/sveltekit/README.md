# {{name}}

A Cirrus app on **SvelteKit**, scaffolded by `cirrus init`.

Your route loaders are live: a `+page.ts` loader preloads Cirrus data on the
server (read-your-writes SSR), the HTML ships with it, and on the client the
**same** data hydrates into a live subscription via `@cirrus/svelte`'s
`hydratePreloaded` — re-rendering on every server write with no loading flash.

## Develop

```bash
pnpm install
pnpm dev
```

## What's wired

- `cirrus/schema.ts` + `cirrus/messages.ts` — a sharded `messages` table with a
  sample `list` query and `send` mutation.
- `src/worker.ts` — the **single-worker entry**: wraps SvelteKit's
  Cloudflare-adapter handler with `withCirrus` (see below) and re-exports the
  generated `ShardDO`.
- `src/routes/+layout.svelte` — publishes the `CirrusClient` on Svelte context
  with `setCirrusClient` (the provider), pointed at the **same origin**.
- `src/routes/+page.ts` — a universal `load` that calls `preloadQuery` through a
  request-scoped `createServerClient`, forwarding SvelteKit's `fetch` for
  same-origin session continuity. Because Cirrus is mounted in the same worker,
  it is a same-origin loopback.
- `src/routes/+page.svelte` — uses `hydratePreloaded(data.preloaded)` for the
  SSR-seed-to-live handoff and `mutation(api.messages.send)` for optimistic writes.

## Stack

- `@sveltejs/kit` — the meta-framework (file-based routing + load functions)
- `svelte` (5) — runes/stores UI runtime
- `@cirrus/svelte` — live stores, optimistic mutations, `hydratePreloaded`
- `@cirrus/svelte/worker` — `withCirrus` single-worker composition
- `@cirrus/*` — the realtime backend on Cloudflare Workers + Durable Objects

---

## Class-B composition: one worker, Cirrus mounted under `/_cirrus/*`

SvelteKit is a **Class-B** framework: it owns its own Cloudflare adapter
(`@sveltejs/adapter-cloudflare`) and builds its own server worker. So unlike the
Class-A frameworks (TanStack Start, SolidStart), Cirrus does **not** own the
worker entry — it **injects** its realtime plane into the very worker SvelteKit
emits.

How it's wired here:

- **`svelte.config.js`** uses `@sveltejs/adapter-cloudflare`, which builds
  SvelteKit's SSR into `.svelte-kit/cloudflare/_worker.js`.
- **`src/worker.ts`** imports that emitted handler and wraps it with
  `withCirrus` from `@cirrus/svelte/worker`:

    ```ts
    import { withCirrus } from "@cirrus/svelte/worker";
    import svelteKitWorker from "../.svelte-kit/cloudflare/_worker.js";
    import { createShardDO } from "../cirrus/_generated/shard.js";

    export const ShardDO = createShardDO();

    export default withCirrus(svelteKitWorker, (env) => ({
        shardDO: env.SHARD,
        // …auth, routes, functions, openApiSpec
    }));
    ```

- **`wrangler.jsonc`**'s `main` points at `src/worker.ts` (not at SvelteKit's
  emitted `_worker.js`), and binds the `SHARD` Durable Object. One Worker bundles
  both planes — no double-bundling the DO class.

The composed worker reserves `/_cirrus/*` for Cirrus realtime (`/_cirrus/rpc`,
`/_cirrus/ws`, `/_cirrus/admin/*`) and forwards **everything else** to
SvelteKit's SSR handler. The two dispatch flows never collide: pages/API/SSR →
SvelteKit; queries/mutations/subscriptions → `/_cirrus/*`. A SvelteKit render
that throws is contained at the seam as a plain 500 and can never take down
`/_cirrus/*`.

Because it's one worker, the `+page.ts` loader's `preloadQuery` is a
**same-origin loopback** and the client subscription resumes the same
cookie-based identity on the same origin — no separate worker, one deploy. Set
`VITE_CIRRUS_URL` only if you deliberately split Cirrus out to a standalone
worker.

> Status: the `withCirrus` composition is unit/contract-proven in
> `@cirrus/svelte` (`packages/svelte/__tests__/worker.test.ts`). The
> `@sveltejs/adapter-cloudflare` build itself isn't exercised in this repo, so
> the `src/worker.ts` / `wrangler.jsonc` wiring above is a scaffold to run
> against a real `vite build` + `wrangler deploy`.
