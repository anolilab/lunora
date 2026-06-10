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
- `src/routes/+layout.svelte` — publishes the `CirrusClient` on Svelte context
  with `setCirrusClient` (the provider).
- `src/routes/+page.ts` — a universal `load` that calls `preloadQuery` through a
  request-scoped `createServerClient`, forwarding SvelteKit's `fetch` for
  same-origin session continuity.
- `src/routes/+page.svelte` — uses `hydratePreloaded(data.preloaded)` for the
  SSR-seed-to-live handoff and `mutation(api.messages.send)` for optimistic writes.

## Stack

- `@sveltejs/kit` — the meta-framework (file-based routing + load functions)
- `svelte` (5) — runes/stores UI runtime
- `@cirrus/svelte` — live stores, optimistic mutations, `hydratePreloaded`
- `@cirrus/*` — the realtime backend on Cloudflare Workers + Durable Objects

---

## Class-B composition (mounting Cirrus realtime under `/_cirrus/*` inside SvelteKit's adapter) is wired in PLAN4 M4 — TODO

SvelteKit is a **Class-B** framework: it owns its own Cloudflare adapter
(`@sveltejs/adapter-cloudflare`) and builds its own server worker. So unlike the
Class-A frameworks (TanStack Start, SolidStart), Cirrus does **not** own the
worker entry here — it must be **injected into SvelteKit's** server build rather
than fighting it.

The intended approach (PLAN4 M4):

- Ship a `withCirrus()`-style wrapper from `@cirrus/svelte` (or `@cirrus/vite`)
  that hook-injects Cirrus's worker composition into SvelteKit's generated
  Cloudflare server entry — the way void does framework wiring via
  hook-injection plugins.
- The composed single worker reserves `/_cirrus/*` for Cirrus realtime
  (`/_cirrus/rpc`, `/_cirrus/ws`, `/_cirrus/admin/*`) and forwards **everything
  else** to SvelteKit's SSR handler. The two dispatch flows never collide:
  pages/API/SSR → SvelteKit; queries/mutations/subscriptions → `/_cirrus/*`.
- With that in place the `+page.ts` loader's `preloadQuery` becomes a
  **same-origin loopback** (and can take the in-process `serverQuery` fast-path),
  and the client subscription resumes the same cookie-based identity on the same
  origin — no separate worker, one deploy.

Until M4 lands, run the Cirrus worker as a standalone worker (the current
default) and point `VITE_CIRRUS_URL` at it; the adapter surface above
(`setCirrusClient` / `query` / `mutation` / `hydratePreloaded`) is unchanged
once composition is wired.
