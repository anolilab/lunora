# {{name}}

A Lunora app on **Astro**, scaffolded by `lunora init`.

Your loaders are live: a `.astro` page preloads Lunora data on the server
(read-your-writes SSR), the HTML ships with it, and on the client a hydrated
**React island** turns that same data into a live subscription via
`@lunora/react`'s `hydratePreloaded` — re-rendering on every server write with no
loading flash.

## Develop

Install dependencies, then start the dev server with the Lunora CLI:

```bash
<pm> install
<pm> exec lunora dev
```

Astro needs **no sidecar**: `astro dev` runs the whole app — SSR, `/_lunora/*`,
and the `ShardDO` Durable Object — in `workerd` via `@astrojs/cloudflare`'s
embedded Cloudflare Vite plugin (Astro 6+), so a single process gives you
realtime + HMR with live DOs in dev. `lunora dev` runs `astro dev` and, through
the `@lunora/vite` plugins wired in `astro.config.mjs` (with `cloudflare: false`,
so no second Cloudflare plugin), keeps `lunora/_generated/*`, Studio, and dev
state in sync. Open the URL Astro prints. (Bare `<pm> run dev` also works — it
runs the same `astro dev`.)

## Why an island adapter?

Astro is **multi-framework** at the UI layer — it ships zero client JS until you
hydrate an island. So Lunora reactivity comes from whichever **island adapter**
you pick: `@lunora/react`, `@lunora/solid`, `@lunora/svelte`, or `@lunora/vue`.
This template uses a **React** island (`src/components/Messages.tsx` +
`@astrojs/react`). `@lunora/astro` itself is **not** a reactive layer — it owns
the server/composition seams only.

## What's wired

- `lunora/schema.ts` + `lunora/messages.ts` — a sharded `messages` table with a
  sample `list` query and `send` mutation.
- `astro.config.mjs` — adds the `react()` and `lunora()` integrations.
- `src/pages/index.astro` — frontmatter (server-side) calls `preloadQuery`
  through a request-scoped `createServerClient` from `@lunora/astro/server`,
  forwarding the inbound cookie for same-origin session continuity, then passes
  the `Preloaded` token to the island.
- `src/components/Messages.tsx` — a React island using `hydratePreloaded(preloaded)`
  for the SSR-seed → live handoff and `useMutation(api.messages.send)` for
  optimistic writes.
- `src/worker.ts` — the **single-worker composition** (see below).

## Single-worker composition (`withLunora`)

Astro is a **Class-B** framework: it owns its own Cloudflare adapter
(`@astrojs/cloudflare`) and builds its own server worker. So unlike Class-A
frameworks (TanStack Start, SolidStart), Lunora does **not** own the worker entry
— it is **injected into** Astro's worker.

`src/worker.ts` wraps the handler `@astrojs/cloudflare` emits with
`withLunora(astroWorker, { shardDO: env.SHARD })`. The composed single worker:

- reserves `/_lunora/*` for Lunora realtime (`/_lunora/rpc`, `/_lunora/ws`,
  `/_lunora/admin/*`) and the `ShardDO`, and
- forwards **everything else** to Astro's SSR handler.

The two dispatch flows share one worker but never collide: pages/endpoints →
Astro; queries/mutations/subscriptions → `/_lunora/*`. A throwing Astro render is
contained as a 500 and can never take down the realtime plane. Because it's the
same origin, `preloadQuery` is a same-origin loopback and the client subscription
resumes the same cookie-based session — one worker, one deploy.

> Note: `@astrojs/cloudflare`'s real build emits `dist/_worker.js/index.js`, which
> `src/worker.ts` imports and wraps. The import path is a build-time artifact —
> run `pnpm build` (which runs `astro build`) before deploying.

## Stack

- `astro` (6) — the meta-framework (islands + server endpoints)
- `@astrojs/cloudflare` — Astro's Cloudflare adapter (owns the server worker)
- `@astrojs/react` + `react` (19) — the island UI runtime
- `@lunora/astro` — the integration + `withLunora` single-worker composition
- `@lunora/react` — live queries, optimistic mutations, `hydratePreloaded`
- `@lunora/*` — the realtime backend on Cloudflare Workers + Durable Objects
