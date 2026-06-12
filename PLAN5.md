# Plan 5 — Execution roadmap: "Cirrus Everywhere" + the remaining DX gaps

The concrete, ordered, PR-sized step list to execute **PLAN4** (be the reactive backend any
meta-framework plugs into — _your loaders are live_), plus the independent DX wins that close the
remaining gaps vs void (`VOID-TEARDOWN.md` §6) and the open backend-correctness items.

**How to read this.** Each `N.x` step is a shippable unit (≈ one PR) with **files**, **does**, and
**done-when** (acceptance). `[P]` = can run in parallel with its siblings. `[dep: …]` = hard
dependency. Phases are ordered by dependency; the dependency graph + parallelization is at the end.

**Confirmed preconditions (already in the tree, do not rebuild):** `createWorker({ httpRouter })`
composition seam (`packages/runtime/src/create-worker.ts`); framework-agnostic `@cirrus/client`
(transport/subscribe/offline/delta-merge) with `preloadQuery`/`preloadedQueryResult`; React server
helpers `createServerClient`/`prefetchQuery`/`preloadQuery` (`packages/react/src/server.ts`);
`cirrus({ cloudflare: false })` opt-out (`packages/vite/src/index.ts`). **Missing:**
`getServerSession`, an in-process server-query fast-path, a framework-neutral `@cirrus/ssr`, the
single-worker composition sugar, framework detection in `@cirrus/vite`, and all non-React adapters.

---

## Phase 0 — Foundations: the framework-neutral contract `[dep for Phases 1–4]`

### 0.1 — `@cirrus/ssr` package (the neutral server contract)

- **Does:** create `packages/ssr/` exporting the framework-neutral SSR surface that every adapter + every framework template imports: `createServerClient({url,token?,fetch?})`, `preloadQuery(client,fn,args,{shardKey?})→Preloaded<T>`, `serializePreloaded`/`dehydrate`, re-export `preloadedQueryResult`. Move the non-React server bits out of `@cirrus/react/server` and have `@cirrus/react` re-export from `@cirrus/ssr` (no breaking change).
- **Files:** new `packages/ssr/{src/index.ts,package.json,...}`; refactor `packages/react/src/server.ts` to import from it.
- **Done-when:** `@cirrus/ssr` builds ESM-only, has unit tests (preload snapshot is serializable + round-trips), and `@cirrus/react` still passes its tests re-exporting from it.

### 0.2 — `getServerSession(request, auth)` helper `[P]`

- **Does:** add the missing helper that every app hand-rolls today (`auth.api.getSession({headers})`): `getServerSession(request, auth) → { user, session } | null`, plus `getServerAuthToken(request)` to extract the cookie/token a `createServerClient` needs to act as that identity.
- **Files:** `packages/auth/src/` (new `server-session.ts`); export from `@cirrus/auth` and re-export from `@cirrus/ssr`.
- **Done-when:** unit-tested against a fake request with a session cookie; documented as the SSR-loader entry point.

### 0.3 — In-process `serverQuery` fast-path `[dep: 0.1]`

- **Does:** when the SSR loader runs _inside the same worker_, bypass the `POST /_cirrus/rpc` self-fetch and call the generated `createCaller` directly (RLS/identity semantics identical to the HTTP path). Expose `composeWorker`/`createWorker` so a loader can obtain a `serverQuery(ctx, fn, args)` bound to the request's identity.
- **Files:** `packages/runtime/src/create-worker.ts` (surface an in-process caller on the action ctx); `packages/ssr` (`serverQuery` that prefers in-process, falls back to `createServerClient` over HTTP for cross-worker SSR).
- **Done-when:** a test proves in-process `serverQuery` returns identical results + honors RLS vs the HTTP path; a benchmark shows it skips the self-fetch.

### 0.4 — Harden the `httpRouter` composition contract `[P]`

- **Does:** make the worker composition first-class + safe: document precedence (auth → explicit routes → `httpRouter` → `/_cirrus/*`), and **isolate failures** so a framework SSR 500 cannot break `/_cirrus/rpc`/`ws`. Add a thin `composeWorker({ httpRouter, ...cirrusOptions })` sugar.
- **Files:** `packages/runtime/src/create-worker.ts`; tests.
- **Done-when:** test: a throwing `httpRouter` still serves `/_cirrus/*`; `composeWorker` documented.

---

## Phase 1 — M0 proof: "live loaders" end-to-end on TanStack Start `[dep: Phase 0]`

### 1.1 — `hydratePreloaded` in `@cirrus/react`

- **Does:** formalize the SSR→live handoff as one primitive: `hydratePreloaded(preloaded)` seeds the cache with the server snapshot (no refetch, `staleTime: ∞`) and opens the WS subscription on mount. (Generalize the existing `usePreloadedQuery`.)
- **Files:** `packages/react/src/use-preloaded-query.ts`, `hydrate-preloaded.ts`.
- **Done-when:** unit + integration test: seeded value renders immediately, then a delta updates it.

### 1.2 — The spike app/template wiring

- **Does:** wire the existing `templates/tanstack-start` so a route **loader** runs `getServerSession` → `createServerClient`/`serverQuery` → `preloadQuery`, SSRs the data, and the component calls `hydratePreloaded` → live `useQuery`. One worker (`composeWorker({ httpRouter: tanstackHandler })`).
- **Files:** `templates/tanstack-start/{src/server.ts, src/routes/*, vite.config.ts}`.
- **Done-when:** **the proof** — run the template, open two tabs, mutate in tab A, see tab B's SSR'd-then-live loader data update without a manual refetch. SSR HTML contains the data (view-source check). This validates the _entire_ contract.

### 1.3 — Identity continuity SSR→client (PLAN4 §5.2)

- **Does:** ensure the WS subscription opened on the client resumes the **same** identity the server loader used (same-origin cookie is simplest; verify the token path for cross-origin).
- **Done-when:** an authed loader's preloaded data and its live subscription both reflect the logged-in user; logging out drops the subscription's access per RLS.

---

## Phase 2 — Build/deploy composition + class-A templates `[dep: Phase 1]`

### 2.1 — Framework detection in `@cirrus/vite`

- **Does:** port void's `detectFramework(root)` (read `package.json`): map `@tanstack/react-start`, `@react-router/dev`, `@solidjs/start`, `@sveltejs/kit`, `nuxt`, `astro` → a class (A: own-worker-entry · B: hook-injection · C: SPA/static). Drive plugin composition off it.
- **Files:** `packages/vite/src/detect-framework.ts`, `index.ts`.
- **Done-when:** unit-tested against fixture package.jsons; returns correct class.

### 2.2 — One-worker emit + wrangler reconcile for class-A `[dep: 2.1]`

- **Does:** when a class-A framework is detected, compose its Vite plugin + the Cirrus plugins so a single worker bundle is emitted (no double-bundled DO classes); run the existing binding reconcile (SHARD/SESSION/SCHEDULER/DB).
- **Files:** `packages/vite/src/index.ts`; integration with `@cloudflare/vite-plugin`.
- **Done-when:** `pnpm build` on the tanstack-start template emits one worker that serves SSR + `/_cirrus/*`; `wrangler.jsonc` is reconciled.

### 2.3 — `cirrus init -t react-router` template `[P, dep: 2.2]`

- **Does:** second class-A template (React Router v7 / Vite) wired identically (composeWorker + live loader sample). Proves the contract isn't TanStack-specific.
- **Done-when:** template builds + the live-loader sample works.

---

## Phase 3 — Adapter breadth `[dep: Phase 1; each P]`

> All adapters are thin over the agnostic `@cirrus/client`; the contract per adapter is: live
> `query`, optimistic `mutation`, `hydratePreloaded`, provider/context, (optional) presence/stream.

### 3.1 — `@cirrus/solid` (+ SolidStart template) `[P]`

- **Does:** Solid signals/resources adapter — the best fine-grained match for Cirrus deltas. `createQuery`/`createCirrusResource`, `hydratePreloaded`, provider. SolidStart class-A template.
- **Done-when:** live-loader sample works in SolidStart; published ESM-only.

### 3.2 — `@cirrus/svelte` (+ SvelteKit-ready stores) `[P]`

- **Does:** Svelte store/runes adapter (`createCirrusQuery → { subscribe }`), `hydratePreloaded`. (Used by the SvelteKit class-B work in Phase 4.)
- **Done-when:** stores update on deltas; SSR seed hydrates without refetch.

### 3.3 — `@cirrus/vue` `[P]`

- **Does:** Vue composables (`useCirrusQuery` → `ref`/`reactive`), `hydratePreloaded`, plugin/provide-inject.
- **Done-when:** composable reactivity verified; SSR hydrate works.

---

## Phase 4 — Class-B frameworks (own CF adapter) `[dep: Phases 2–3]`

> Hardest tier: these frameworks bundle their own worker, so we _inject_ Cirrus rather than own the
> entry (void's hooks-injection model). Do after the contract + adapters are proven.

### 4.1 — SvelteKit integration `[dep: 3.2]`

- **Does:** a `@cirrus/vite` hook-injection plugin that wraps SvelteKit's server entry/`handle` to mount Cirrus realtime under `/_cirrus/*` + expose `serverQuery`/`getServerSession` in `+page.server.ts` loaders; ship `withCirrus()` wrappers. SvelteKit template.
- **Done-when:** a SvelteKit load function preloads a live query; one worker deploys; realtime works under SvelteKit's dev server.

### 4.2 — Nuxt integration `[dep: 3.3, P]` and 4.3 — Astro integration `[P]`

- **Does:** same hook-injection pattern for Nuxt (Nitro) and Astro (`nodejs_als`); templates.
- **Done-when:** live-loader sample works in each; single-worker deploy verified.

---

## Phase 5 — Remote-binding dev `[independent; start in parallel with Phase 0]` — ✅ done via platform (design pivot)

The one in-scope DX gap (`VOID-TEARDOWN.md` §4.5). Proxy local dev bindings to deployed resources.

> **Status (2026-06-12): shipped via a different mechanism.** Cirrus does NOT hand-roll the
> custom HTTP proxy below (5.1/5.2 `ProxyD1Database`/`/__cirrus/{d1,kv,r2}` routes were never
> built). Instead it leans on **wrangler 4's native remote-binding mode** (`"remote": true` per
> binding): `resolveRemoteEnabled` + `materializeRemoteWranglerConfig` + `planRemoteBindings`
> (`packages/config/src/remote-bindings.ts`), wired into `cirrus dev` (`--remote` /
> `CIRRUS_REMOTE` / `cirrus.json` `remote`) and the Vite dev path
> (`packages/vite/src/remote-bindings-plugin.ts`). DOs stay local (5.3 boundary honored).
> So `cirrus dev --remote` reads/writes deployed D1/KV/R2 today — the custom proxy protocol
> in 5.1/5.2 is intentionally abandoned (superseded by the platform). The sub-steps below are
> kept for historical context.

### 5.1 — Deployed-side binding handler `[P]`

- **Does:** mount `/__cirrus/{d1,kv,r2}/*` Hono routes on the deployed worker that execute against the real bindings, guarded by an `x-cirrus-internal` shared secret. Responses match Cloudflare's D1/KV/R2 wire shapes so Drizzle/D1 callers need zero changes.
- **Files:** `packages/runtime/` (or new `packages/remote/`); wired into `createWorker`.
- **Done-when:** authed POSTs execute against real D1/KV/R2; unauthed → 403.

### 5.2 — Local-side proxy shims `[dep: 5.1]`

- **Does:** `ProxyD1Database`/`ProxyKVNamespace`/`ProxyR2Bucket` that POST to the deployed handler; when `CIRRUS_REMOTE=1`, the dev worker entry swaps `env.DB/KV/STORAGE` for the shims (token + project id from the linked project).
- **Files:** `packages/remote/`; `@cirrus/vite` dev wiring (env injection).
- **Done-when:** `CIRRUS_REMOTE=1 pnpm dev` reads/writes the **deployed** D1/KV/R2 from local code; documented limitations (latency, no R2 multipart).

### 5.3 — DO-state caveat decision `[P]`

- **Does:** decide scope — proxy D1/KV/R2 only (shards run locally) vs also proxying ShardDO RPC. Document the chosen boundary; ship the D1/KV/R2 cut first.
- **Done-when:** documented; `cirrus` honors `remote` in `cirrus.json`/`--remote` like the existing flag.

---

## Phase 6 — Small additive gaps vs void `[independent; each P]`

### 6.1 — Standard Schema input validation for functions `[P]` — ✅ shipped

- **Shipped.** `v.from(schema)` (`packages/values/src/v.ts`) accepts any Standard Schema v1
  validator (zod/valibot/arktype) and validates via `schema["~standard"].validate` (sync-only,
  args-only via `isOrWrapsFromValidator`); function args validate it through the normal
  `parseValidatorMap`/`validateArgs` path (`packages/server/src/functions.ts`). `@cirrus/values`
  also exposes `~standard` on every native validator for the reverse interop.
- **Does (original):** let `query`/`mutation`/`action` args accept any Standard Schema validator (zod/valibot/arktype) via `schema["~standard"].validate`, alongside the existing `v.*`. Schema-lib-agnostic, no coupling.
- **Files:** `packages/values/` or `packages/server/` arg-validation seam; codegen type extraction.
- **Done-when:** a function declared with a zod schema validates + types end-to-end.

### 6.2 — `@cirrus/ai` (Workers AI helper) `[P]` — ✅ shipped (package + inference + ctx.ai)

- **Status (2026-06-12):** **fully shipped.**
    - **Package:** `packages/ai/` on Vercel AI SDK v6 + `workers-ai-provider` (decision below),
      provider-agnostic, lint/type clean, 13 unit tests. AI SDK v6 exact-pinned in the `ai` catalog +
      allow-listed in `minimumReleaseAgeExclude` (v6 shipped inside the 24h maturity window).
    - **Binding inference:** `@cirrus/config` infers `AI` from a `@cirrus/ai` import **or** `env.AI`
      use and auto-reconciles `"ai": { "binding": "AI" }` into `wrangler.jsonc` (`infer-bindings.ts`
      `usesAi` + `reconcile-bindings.ts` `reconcileAi`; +5 tests).
    - **`ctx.ai` codegen wiring:** `@cirrus/codegen` detects AI use (`discover-ai-usage.ts`:
      `@cirrus/ai` import or `ctx.ai` read) and, when present, emits the `@cirrus/ai` import + a
      `createAi({ binding: env.AI })` build (with a throwing stub fallback) into the ShardDO and a
      typed `readonly ai: CirrusAi` on the generated **ActionCtx** (inference is an external call →
      action-only, like `ctx.fetch`). **No core `@cirrus/server` coupling** — the field is added in
      the generated `_generated/server.ts` (`emitServer`), so the AI SDK never enters non-AI workers.
      Gated, so existing golden fixtures stay byte-identical; +5 codegen tests (180 total).
    - **Provider-agnostic:** Workers AI (`env.AI`) is the zero-config default; `ctx.ai.model(id)` /
      `ctx.ai.embeddingModel(id)` resolve Workers AI from a string, and any AI SDK model object
      (`@ai-sdk/openai` / `@ai-sdk/anthropic` / …) passes straight through — no lock-in.
- **Decision (build-vs-reuse, see `AI-PACKAGE-RESEARCH.md`):** build on the **Vercel AI SDK v6 core +
  `workers-ai-provider`** (Cloudflare-official, in the `cloudflare/ai` monorepo). Pinned:
  `ai@^6.0.202` + `workers-ai-provider@^3.1.14` (peers `ai ^6.0.0`). NOT void's hand-rolled binding
  wrapper (locks to Workers AI only, re-implements tools/stream/structured output by hand); NOT
  TanStack AI (no Workers AI adapter, pre-1.0).
- **Provider-agnostic:** Workers AI (`env.AI`) is the zero-config default, but `ctx.ai`'s helpers
  accept any AI SDK `LanguageModel`, so apps can drop in `@ai-sdk/openai` / `@ai-sdk/anthropic` /
  `@ai-sdk/google` / OpenRouter (optional bring-your-own peers, optionally via AI Gateway) without
  lock-in. `@cirrus/ai` deps stay `ai` + `workers-ai-provider`; external providers are optional peers.
- **Does:** additive **server** package over the `AI` binding. Wire `env.AI → createWorkersAI`,
  expose `ctx.ai` in functions, re-export `streamText`/`generateText`/`generateObject`/`embed`/`tool`,
  keep a raw `ctx.ai.run(model, input)` escape hatch, and pair `embed` with `@cirrus/vectors` for RAG.
- **Files:** new `packages/ai/`; `packages/config/src/infer-bindings.ts` (add `AI`).
- **Done-when:** `ctx.ai`/`streamText` works inside a function against `env.AI`; `embed`→`@cirrus/vectors`
  round-trips; the `AI` binding is auto-reconciled into `wrangler.jsonc`.
- **Deferred (Layer B, separate item):** client chat hooks — stream tokens over Cirrus's own
  transport; if a client SDK is used, prefer TanStack AI via its `custom` connection adapter (the
  one seam that rides Cirrus's WS subscriptions) over `@ai-sdk/react`'s fixed data-stream `useChat`.

---

## Phase 7 — Backend correctness follow-ups (from PLAN2) `[independent; P]` — ✅ both shipped

### 7.1 — Cross-shard `rankPage` k-way merge `[P]` — ✅ shipped

- **Shipped.** `orchestrateRankPage` + `kWayMergeRankPages` (`packages/runtime/src/query-coordinator.ts`)
  fan `__cirrus_admin__:rankPage` to every live shard and merge with `compareRankKeys` — ordering
  by `__partition__` (encodePartitionKey) → sort columns (per `index.sortBy` direction) → `__id__`,
  byte-identical to each shard's `ORDER BY` via `serializeSqlValue`/`RankPageKey`, returning an
  opaque composite `continueCursor` so pages don't drop/duplicate at boundaries.
- **Does (original):** finish PLAN2 #3 — `orchestrateRankPage` coordinator whose comparison is byte-identical to each shard's `ORDER BY __partition__,sortcols,__id__` (encodePartitionKey + serializeSqlValue) so pages don't drop/duplicate at boundaries. Plus client sugar that builds the rank key tuple.
- **Done-when:** real-coordinator fan-out test paginates a cross-shard rankIndex without gaps/dupes.

### 7.2 — Reverse cross-backend relations `[P]` — ✅ shipped

- **Shipped.** Global-parent → shard-local-child loading works via fan-out: `serveRelationFanout`
  (`packages/do/src/relation-fanout.ts`) serves reserved `__cirrus_relation__:read`/`:count`;
  `createCrossShardRelationCapabilities` (`packages/runtime/src/cross-shard-relations.ts`) fans out
  via `/_cirrus/rpc` and merges with identity propagation; the worker gate default-denies
  `__cirrus_relation__:*` unless `authorizeFanOut` is set; codegen emits a `runRelationFanoutRead`
  override only for projects with `.global()` tables. Tests in `cross-shard-relations.test.ts`.
- **Does (original):** finish PLAN2 #7 — global-parent → shard-local-child relation loading via fan-out (currently throws).
- **Done-when:** loading a global parent with its shard-local children works across shards.

---

## Phase 8 — Docs & DX polish `[dep: relevant phases]`

### 8.1 — "Bring your framework" docs matrix — one page per framework (class A/B/C) + the **reactive-loaders** concept page (the differentiator). `[dep: Phases 2–4]`

### 8.2 — `cirrus init --here` across frameworks — extend the in-place patcher to add Cirrus to an existing meta-framework app (detect framework, wire composeWorker). `[dep: 2.1]`

### 8.3 — Composed dev HMR — verify client+server HMR under one Vite/Miniflare for class-A and under each framework's dev server for class-B. `[dep: Phase 4]`

### 8.4 — Remote-dev + AI + Standard-Schema docs. `[dep: 5.x, 6.x]`

---

## Dependency graph & suggested parallelization

```
Phase 0 (foundations) ─┬─▶ Phase 1 (M0 proof) ─▶ Phase 2 (build/deploy) ─▶ Phase 3 (adapters) ─▶ Phase 4 (class-B) ─▶ 8.1/8.3
                       └─▶ 0.2/0.4 [P]
Phase 5 (remote-dev)  ── independent, start now in parallel ──────────────────────────────────▶ 8.4
Phase 6 (small wins)  ── independent [P] ─────────────────────────────────────────────────────▶ 8.4
Phase 7 (backend)     ── independent [P] ─────────────────────────────────────────────────────
```

**Critical path to the differentiator:** 0.1 → 0.3 → 1.1 → 1.2 (live loaders proven). Everything
else is breadth/independent tracks on the proven contract.

**Recommended first three PRs:** (1) **0.1** `@cirrus/ssr` + **0.2** `getServerSession`; (2) **0.3**
in-process `serverQuery` + **0.4** harden composition; (3) **1.1** `hydratePreloaded` + **1.2** the
TanStack Start live-loader proof. Land those and the whole strategy is de-risked.

---

## Risks (carried from PLAN4 §5)

1. WS opens client-side post-hydration — need clean loading→live with no flash (the `staleTime:∞` +
   `initialData` pattern; replicate per adapter).
2. Identity continuity SSR→client (1.3) — verify cross-origin token path.
3. In-process vs HTTP server query (0.3) — RLS/identity semantics must match exactly.
4. Class-B single-worker bundling (Phase 4) — don't double-bundle DO classes; budget for
   hooks-injection transforms.
5. Composed dev HMR (8.3) — Cirrus realtime must work under each framework's dev server.
6. Remote-dev: DO state isn't trivially proxyable (5.3) — ship D1/KV/R2 first, shards local.

---

_Companion plans: `PLAN4.md` (the strategy + seam map), `VOID-TEARDOWN.md` (the reference for void's
class-A/B/C composition, remote-binding-dev protocol, and the gap analysis). Memories:
[[void-cloud-teardown]], [[plan2-gap-status]], [[esm-only-packages]] (new packages must ship ESM-only)._
