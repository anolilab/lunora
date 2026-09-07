# {{name}}

A Lunora app on **Astro**, scaffolded by `lunora init`.

The scaffold ships a static welcome page and the wiring behind it: a sharded
schema, the typed API, and a single Cloudflare Worker that serves Astro SSR and
the Lunora realtime plane together. Add a React island and call
`@lunora/react`'s `hydratePreloaded` on a `preloadQuery` token from a page's
frontmatter to turn a server-rendered read into a live subscription.

## Develop

Install dependencies, then start the dev server with the Lunora CLI:

```bash
<pm> install
<pm> exec lunora dev
```

Astro needs **no sidecar**: `astro dev` runs the whole app — SSR, `/_lunora/*`,
and the `ShardDO` Durable Object — in `workerd` via `@astrojs/cloudflare`'s
embedded Cloudflare Vite plugin, so a single process gives you
realtime + HMR with live DOs in dev. `lunora dev` runs `astro dev` and, through
the `@lunora/vite` plugins wired in `astro.config.mjs` (with `cloudflare: false`,
so no second Cloudflare plugin), keeps `lunora/_generated/*`, Studio, and dev
state in sync. Open the URL Astro prints. (Bare `<pm> run dev` also works — it
runs the same `astro dev`.)

## Why an island adapter?

Astro is **multi-framework** at the UI layer — it ships zero client JS until you
hydrate an island. So Lunora reactivity comes from whichever **island adapter**
you pick: `@lunora/react`, `@lunora/solid`, `@lunora/svelte`, or `@lunora/vue`.
This template installs the **React** one (`@lunora/react` + `@astrojs/react`), so
a `.tsx` island under `src/components/` works with no further setup.
`@lunora/astro` itself is **not** a reactive layer — it owns the server /
composition seams only.

## What's wired

- `lunora/schema.ts` + `lunora/messages.ts` — a sharded `messages` table with a
  sample `list` query and `send` mutation.
- `astro.config.mjs` — adds the `react()` and `lunora()` integrations, and the
  `@lunora/vite` codegen/Studio plugins.
- `src/pages/index.astro` — the static welcome page. It loads no data; use
  `createServerClient` + `preloadQuery` from `@lunora/astro/server` in a page's
  frontmatter (forwarding the inbound cookie for same-origin session continuity)
  and hand the `Preloaded` token to an island to go live.
- `src/server.ts` — the **single-worker composition** (see below).

## Single-worker composition

Astro is a **Class-B** framework: it owns its own Cloudflare adapter
(`@astrojs/cloudflare`) and builds its own server worker. So unlike Class-A
frameworks (TanStack Start, SolidStart), Lunora does **not** own the worker entry
— it is **composed into** Astro's worker.

`src/server.ts` folds the handler `@astrojs/cloudflare` emits into the generated
`defineApp` builder with `.buildFrameworkWorker(handle)`, and exports the
resulting app plus the `ShardDO` class. The composed single worker:

- reserves `/_lunora/*` for Lunora realtime (`/_lunora/rpc`, `/_lunora/ws`,
  `/_lunora/admin/*`) and the `ShardDO`, and
- forwards **everything else** to Astro's SSR handler.

(`withLunora(astroWorker, (env) => ({ shardDO: env.SHARD }))` from
`@lunora/astro` is the standalone spelling of the same seam, for a project that
does not want the builder.)

The two dispatch flows share one worker but never collide: pages/endpoints →
Astro; queries/mutations/subscriptions → `/_lunora/*`. A throwing Astro render is
contained as a 500 and can never take down the realtime plane. Because it's the
same origin, `preloadQuery` is a same-origin loopback and the client subscription
resumes the same cookie-based session — one worker, one deploy.

## Deploy

```bash
<pm> run deploy
```

`wrangler.jsonc` points `main` at `src/server.ts`. `@astrojs/cloudflare`'s
embedded `@cloudflare/vite-plugin` reads that, builds the file into
`dist/server/entry.mjs` (SSR + Lunora + `ShardDO`, one bundle) and writes a
`.wrangler/deploy/config.json` redirect — so `lunora deploy` ships the
adapter-built worker with `dist/client` bound as `ASSETS`. Run the build first;
the `deploy` script does.

> The entry is **not** named `src/worker.ts` on purpose. `lunora deploy` treats
> that exact path as a SvelteKit-shaped composed entry and passes it to wrangler
> positionally, which — with the adapter redirect's `no_bundle: true` — uploads
> the raw TypeScript source as the worker.

## Stack

- `astro` (7) — the meta-framework (islands + server endpoints)
- `@astrojs/cloudflare` — Astro's Cloudflare adapter (owns the server worker)
- `@astrojs/react` + `react` (19) — the island UI runtime
- `@lunora/astro` — the integration + the single-worker composition seam
- `@lunora/react` — live queries, optimistic mutations, `hydratePreloaded`
- `@lunora/*` — the realtime backend on Cloudflare Workers + Durable Objects
