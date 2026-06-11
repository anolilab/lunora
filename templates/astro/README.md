# {{name}}

A Cirrus app on **Astro**, scaffolded by `cirrus init`.

Your loaders are live: a `.astro` page preloads Cirrus data on the server
(read-your-writes SSR), the HTML ships with it, and on the client a hydrated
**React island** turns that same data into a live subscription via
`@cirrus/react`'s `hydratePreloaded` — re-rendering on every server write with no
loading flash.

## Develop

```bash
pnpm install
pnpm dev
```

## Why an island adapter?

Astro is **multi-framework** at the UI layer — it ships zero client JS until you
hydrate an island. So Cirrus reactivity comes from whichever **island adapter**
you pick: `@cirrus/react`, `@cirrus/solid`, `@cirrus/svelte`, or `@cirrus/vue`.
This template uses a **React** island (`src/components/Messages.tsx` +
`@astrojs/react`). `@cirrus/astro` itself is **not** a reactive layer — it owns
the server/composition seams only.

## What's wired

- `cirrus/schema.ts` + `cirrus/messages.ts` — a sharded `messages` table with a
  sample `list` query and `send` mutation.
- `astro.config.mjs` — adds the `react()` and `cirrus()` integrations.
- `src/pages/index.astro` — frontmatter (server-side) calls `preloadQuery`
  through a request-scoped `createServerClient` from `@cirrus/astro/server`,
  forwarding the inbound cookie for same-origin session continuity, then passes
  the `Preloaded` token to the island.
- `src/components/Messages.tsx` — a React island using `hydratePreloaded(preloaded)`
  for the SSR-seed → live handoff and `useMutation(api.messages.send)` for
  optimistic writes.
- `src/worker.ts` — the **single-worker composition** (see below).

## Single-worker composition (`withCirrus`)

Astro is a **Class-B** framework: it owns its own Cloudflare adapter
(`@astrojs/cloudflare`) and builds its own server worker. So unlike Class-A
frameworks (TanStack Start, SolidStart), Cirrus does **not** own the worker entry
— it is **injected into** Astro's worker.

`src/worker.ts` wraps the handler `@astrojs/cloudflare` emits with
`withCirrus(astroWorker, { shardDO: env.SHARD })`. The composed single worker:

- reserves `/_cirrus/*` for Cirrus realtime (`/_cirrus/rpc`, `/_cirrus/ws`,
  `/_cirrus/admin/*`) and the `ShardDO`, and
- forwards **everything else** to Astro's SSR handler.

The two dispatch flows share one worker but never collide: pages/endpoints →
Astro; queries/mutations/subscriptions → `/_cirrus/*`. A throwing Astro render is
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
- `@cirrus/astro` — the integration + `withCirrus` single-worker composition
- `@cirrus/react` — live queries, optimistic mutations, `hydratePreloaded`
- `@cirrus/*` — the realtime backend on Cloudflare Workers + Durable Objects
