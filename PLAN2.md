# Cirrus — Plan 2: kitcn Parity Gap Analysis

## Context

This plan captures a feature-gap analysis of **Cirrus** against **[`udecode/kitcn`](https://github.com/udecode/kitcn)** — a Convex framework with a tRPC-style server API (cRPC), a Drizzle-style ORM, and TanStack Query client integration ("Convex + Better Auth + tRPC + Drizzle + TanStack Query + shadcn").

Cirrus and kitcn are close conceptual cousins: both wrap a Convex-style functional backend with end-to-end type safety. The difference is the substrate — **kitcn targets Convex's managed backend**, while **Cirrus targets user-owned Cloudflare Workers + Durable Objects + D1**. That means most of kitcn's _DX patterns_ map directly onto Cirrus, but several of its _runtime mechanisms_ (aggregates, migrations, counts) lean on Convex syscalls and would need a DO-SQLite / D1 reimplementation rather than a straight port.

This document is the parity backlog: what kitcn has that Cirrus lacks, ranked by leverage, with notes on how each maps to Cirrus's architecture.

**Analysis date**: 2026-05-28. Cirrus side verified against actual source in `packages/*`, not package descriptions.

**Status update 2026-06-03:** Tiers 1, and most of 2–3, have since landed and are test-covered. The matrix below is updated; see 'Remaining gaps (verified 2026-06-03)' at the end for what's actually left.

**Status update 2026-06-08:** A second reconciliation pass closed the remaining 🟡 rows in the matrix that had in fact shipped — #3 (codegen `createCaller`), #12 (RLS permissions/grant via `definePermission`/`ctx.auth.can`), #14 (data-migration `batchSize`/`maxBatches`/`dryRun` + resume), #15 (reducer-aware `__agg_` sum/avg/min/max + cross-shard merge), #16 (cross-shard rank merge in the coordinator), #20 (`@cirrus/react` is built on TanStack Query, incl. `useMutation`), #22 (`@cirrus/react/server` RSC helpers — prefetch/hydrate + preload-token + one-shot fetch, 10 tests), and #26 (all six CLI commands `analyze`/`env`/`info`/`verify`/`view`/`docs` shipped). The 'Remaining gaps' list at the end is trimmed accordingly. Still genuinely partial: #24 (plugin system — core works; no one-shot install verb, namespaced-function codegen deferred), #25/#27/#28.

---

## Executive summary

- **Cirrus is narrower on the data layer and server API**, broader on infrastructure.
- The single highest-leverage gap is the **cRPC procedure builder + middleware chain** — most of kitcn's other features (RLS, rate-limit, plugins, typed HTTP routes, server callers) are built _on top of_ that abstraction. Building it first unlocks the rest.
- The second cluster is the **Drizzle-style ORM query layer + relations + triggers** — kitcn's data ergonomics far exceed Cirrus's current `withIndex().filter().take()`.
- Cirrus is at **parity or ahead** on mail, storage, scheduler, codegen, Vite tooling, and is **uniquely ahead** on DO sharding, cross-shard query coordination, offline queue, optimistic updates, and D1 bookmark read-your-writes.

---

## Parity matrix

Legend: ✅ implemented · 🟡 partial · ❌ missing (Cirrus side). Evidence cites Cirrus source.

| #   | Capability                                                                 | kitcn | Cirrus | Evidence (Cirrus)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------- | ----- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | tRPC-style procedure builder (`.input()`/`.use()`/`.query()`)              | ✅    | ✅     | `packages/server/src/builder/*` — `initCirrus`, `.input/.use/.query/.mutation/.action` (landed 2026-06-03)                                                                                                                                                                                                                                                                                                                                |
| 2   | Server-side middleware chain (auth, ctx extension)                         | ✅    | ✅     | `packages/server/src/builder/*` — `.use()` chain, typed `next({ ctx })`                                                                                                                                                                                                                                                                                                                                                                   |
| 3   | Server-side typed callers (`createXCaller(ctx)`)                           | ✅    | ✅     | codegen emits a typed `createCaller(ctx)` (`packages/codegen/src/emit.ts`) — server-to-server query/mutation/action callers; `ActionCtx.run*` also available                                                                                                                                                                                                                                                                              |
| 4   | Drizzle-style ORM query builder (`where`/`orderBy`/`with`/`limit`)         | ✅    | ✅     | `packages/do/src/ctx-db.ts`, `packages/d1/src/d1-ctx-db.ts` — where/orderBy/keyset cursor/count/findMany/findFirst                                                                                                                                                                                                                                                                                                                        |
| 5   | Column builders + modifiers (`.notNull()`, `.default()`, `.$onUpdateFn()`) | ✅    | ✅     | `packages/values/src/v.ts` — `.default/.unique/.$defaultFn/.$onUpdateFn/.nullable/.$type`                                                                                                                                                                                                                                                                                                                                                 |
| 6   | Column types: date, timestamp, vector, enum                                | ✅    | ✅     | `packages/values/src/v.ts` — date/timestamp; vector via `@cirrus/vectors`; enum via `v.union`                                                                                                                                                                                                                                                                                                                                             |
| 7   | Table relations (1-n, n-1) + relation queries (`with`, `_count`)           | ✅    | ✅     | `packages/do/src/relations.ts` (one/many/nested `with`/`_count`, `onDelete` cascade/set null/restrict), wired in ctx-db.ts + d1-ctx-db.ts; cross-backend relation loading throws by design (relations.ts:112)                                                                                                                                                                                                                             |
| 8   | Constraints: unique, FK, cascade actions                                   | ✅    | ✅     | unique + FK `onDelete` cascade/set-null/restrict (`packages/do/src/relations.ts`)                                                                                                                                                                                                                                                                                                                                                         |
| 9   | Indexes + index-range queries                                              | ✅    | ✅     | `packages/do/src/ctx-db.ts` `.withIndex()`                                                                                                                                                                                                                                                                                                                                                                                                |
| 10  | Cursor pagination for queries                                              | ✅    | ✅     | keyset cursor pagination in `packages/do/src/ctx-db.ts`                                                                                                                                                                                                                                                                                                                                                                                   |
| 11  | Streaming query results                                                    | ✅    | ✅     | `.stream()` terminal + SSE in the HTTP router (`packages/server/src/http.ts`)                                                                                                                                                                                                                                                                                                                                                             |
| 12  | Row-Level Security (policies, roles, evaluator)                            | ✅    | ✅     | `packages/server/src/rls/middleware.ts` — policy defs, read filtering (baseWhere AND-merge), default-deny write rejection (WITH-CHECK), roles, `COUNT_RLS_UNSUPPORTED`, DO+D1 seam (`query-args.ts`), + permissions/grant (`definePermission` / role `permissions` / `ctx.auth.can`)                                                                                                                                                      |
| 13  | Schema triggers / lifecycle hooks (before/after CRUD)                      | ✅    | ✅     | `packages/do/src/triggers.ts` — before/after insert/update/delete                                                                                                                                                                                                                                                                                                                                                                         |
| 14  | Online data migrations (`defineMigration`, up/down, batch, dry-run)        | ✅    | ✅     | `packages/do/src/data-migration.ts` — per-DO state tracking + `runDataMigration` with `batchSize`/`maxBatches`/`dryRun`, keyset batches + resume                                                                                                                                                                                                                                                                                          |
| 15  | Aggregates: `aggregateIndex`, `count()`, `aggregate()`, `groupBy()`        | ✅    | ✅     | `count()` O(1) via `__agg_` counter tables (incremental, DO+D1); sum/avg/min/max answered from the reducer-aware `__agg_` companion (`__value__`+`__count__`) by index lookup; `groupBy(count)`; cross-shard sum/max/min merge                                                                                                                                                                                                            |
| 16  | Ranked index / `rank()` (btree, sorted pagination, random access)          | ✅    | ✅     | `packages/do/src/rank.ts` + ctx-db.ts — `rank()`/`rankPage()` (btree companion, keyset); per-shard + cross-shard merge in the coordinator (`orchestrateRank`/`mergeRank`)                                                                                                                                                                                                                                                                 |
| 17  | Rate limiting (algorithms, deny list, React hook)                          | ✅    | ✅     | `packages/ratelimit` — token-bucket/sliding/fixed window, stores, middleware, `useRateLimit`                                                                                                                                                                                                                                                                                                                                              |
| 18  | Vector search / vector columns                                             | ✅    | ✅     | `packages/vectors` — `createVectors`, `.vectorize()`, `defineVectorIndex`                                                                                                                                                                                                                                                                                                                                                                 |
| 19  | React `useInfiniteQuery`                                                   | ✅    | ✅     | `packages/react` — `useInfiniteQuery`                                                                                                                                                                                                                                                                                                                                                                                                     |
| 20  | TanStack Query integration                                                 | ✅    | ✅     | `packages/react` is built on TanStack Query — `useQuery`/`useInfiniteQuery`/`useMutation` (the last rebuilt on `@tanstack/react-query`'s `useMutation` with `onMutate`/`onSettled` ref-counted pending)                                                                                                                                                                                                                                   |
| 21  | Typed HTTP/REST router (`.get().searchParams().output()`, Hono, webhooks)  | ✅    | ✅     | `packages/server/src/http.ts` — `httpRouter`/`httpRoute` `.get/.post/…searchParams/.params/.body/.output/.handler/.stream`, Hono                                                                                                                                                                                                                                                                                                          |
| 22  | RSC / SSR server helpers                                                   | ✅    | ✅     | `packages/react/src/server.ts` (`@cirrus/react/server`, no `"use client"`) — `createServerClient`, `prefetchQuery` (seeds the TanStack cache under the client key) + `dehydrate`/`HydrationBoundary`, `preloadQuery`/`preloadedQueryResult` token flow, one-shot `fetchQuery`/`fetchMutation`/`fetchAction`, transport-free `cirrusQueryOptions`; auth via per-request `token`; 10 tests + docs §"Server Components (Next.js App Router)" |
| 23  | Solid.js client                                                            | ✅    | ❌     | React only (deferred by design)                                                                                                                                                                                                                                                                                                                                                                                                           |
| 24  | Plugin system (`definePlugin`, `defineSchemaExtension`, plugin middleware) | ✅    | 🟡     | `packages/server/src/plugin.ts` — `definePlugin`/`defineSchemaExtension`/`defineComponent` + schema `.extend()` (auto-prefix, collision detection, relation/index `on` rewriting), middleware via `.use()` (`ctx.api.<key>`). Gaps: no one-shot install verb (manual `.extend()`+`.use()`), namespaced-function codegen deferred, trigger rewriting untested                                                                              |
| 25  | shadcn-style `add` registry (scaffold into user project)                   | ✅    | ❌     | no registry                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 26  | CLI: `analyze`, `env`, `info`, `verify`, `view`, `docs`                    | ✅    | ✅     | all six shipped in `packages/cli/src/commands/` (`analyze`/`env`/`info`/`verify`/`view`/`docs`), registered via Cerebro in `cli.ts`; alongside `init`/`dev`/`codegen`/`deploy`/`prepare`/`logs`/`run`/`reset`/`migrate`/`export`/`import`/`backup`/`registry`                                                                                                                                                                             |
| 27  | Init templates: TanStack Start, Expo                                       | ✅    | 🟡     | next/vite/standalone only                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 28  | Auth: organizations/teams, admin (ban/impersonate), billing (Polar)        | ✅    | 🟡     | thin better-auth wrapper; org/teams partial                                                                                                                                                                                                                                                                                                                                                                                               |
| 29  | Mail (Resend, templates, queue)                                            | ✅    | ✅     | `packages/mail`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 30  | Storage (R2, signed URLs)                                                  | ✅    | ✅     | `packages/storage`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 31  | Scheduler (runAfter/runAt, cron)                                           | ✅    | ✅     | `packages/scheduler`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 32  | Codegen (api/dataModel/server)                                             | ✅    | ✅     | `packages/codegen`                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Cirrus-unique (not in kitcn):** DO sharding (`.shardBy()`), cross-shard query coordinator with merge strategies, global D1 tables (`.global()`), offline mutation queue, first-class optimistic updates, D1 bookmark read-your-writes, Vite-first DX with dev overlay.

---

## Tier 1 — Core API & data layer (highest leverage)

These are foundational; later tiers depend on them. Build in order.

### 1.1 cRPC procedure builder + middleware `[matrix #1, #2, #3]`

✅ Landed 2026-06-03 — `packages/server/src/builder/*`.

**What kitcn has.** A chainable builder created once per app:

```ts
const c = initCRPC.dataModel<DataModel>().context({}).create({});
export const publicRoute = c.httpAction;
export const authRoute = c.httpAction.use(async ({ ctx, next }) => {
    const id = await ctx.auth.getUserIdentity();
    if (!id) throw new CRPCError({ code: "UNAUTHORIZED" });
    return next({ ctx: { ...ctx, userId: id.subject } });
});
export const router = c.router;
```

Procedures chain `.input(schema)`, `.use(mw)`, `.output(schema)`, `.query()/.mutation()/.action()`. Middleware composes context (`next({ ctx })`), enabling reusable auth/authorization/logging/rate-limit layers.

**Cirrus today.** Flat `query({ args, handler })` / `mutation(...)` / `action(...)` (`packages/server/src/functions.ts`). No chaining, no middleware, fixed context shape (`packages/server/src/types.ts`).

**Why it's #1.** RLS (#12), rate limiting (#17), the plugin system (#24), typed HTTP routes (#21), and per-procedure auth all attach via `.use()`. Without the builder they each need a bespoke mechanism.

**Cirrus mapping.** Pure TypeScript/type-level work; no DO runtime dependency. Should layer _over_ the existing function registration so codegen still discovers procedures. Preserve backward-compatible `query({...})` or migrate it to `c.query`.

**Scope.** Builder factory, middleware composition + typed `next({ ctx })`, `CirrusError` with code taxonomy (mirror `CRPCError` codes: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, …), context-extension type inference, codegen integration.

### 1.2 ORM query layer `[matrix #4, #5, #6, #8, #10]`

✅ Landed 2026-06-03 — `packages/do/src/ctx-db.ts`, `packages/d1/src/d1-ctx-db.ts`, `packages/values/src/v.ts`.

**What kitcn has.** `ctx.orm.query.todos.findMany({ where: { projectId }, with: { author: true }, orderBy, limit, cursor })`, `findFirstOrThrow`, plus writes `ctx.orm.insert(t).values(...)` / `update` / `delete`. Column modifiers: `.notNull()`, `.default()`, `.unique()`, `.$onUpdateFn()`, `.$defaultFn()`, `.$type<T>()`, `timestamp().defaultNow()`. Inference via `$inferSelect` / `$inferInsert`. Constraints (unique, FK, cascade) enforced by ORM mutations.

**Cirrus today.** Real query API is `tableReader.withIndex(name, range).filter().take()` (`packages/do/src/ctx-db.ts`) — index + in-memory filter + limit. No where-chaining, orderBy, relations, or column modifiers. Validators (`v.*`) exist but lack date/timestamp/vector and builder modifiers (`packages/values/src/v.ts`).

**Cirrus mapping.** Query builder compiles to DO-SQLite (`SQLiteStorage`) for shard-local tables and to D1 SQL for `.global()` tables — two backends behind one API. This is real runtime work, not just types. Constraints (unique/FK) enforced at the ORM write layer, since raw `ctx.db` bypasses them (mirror kitcn's documented rule).

### 1.3 Relations `[matrix #7]`

✅ Landed 2026-06-03 — `packages/do/src/relations.ts` (cross-backend relation loading throws by design).

**What kitcn has.** Relation declarations on schema, `with` loading, `_count` relation aggregation, FK `.references(() => t.id, { onDelete: 'cascade' | 'set null' | 'restrict' })`, self-referencing and bidirectional pointers.

**Cirrus today.** None — schema is `shape` + `indexes` only.

**Cirrus mapping.** Within a shard, relations are local SQLite joins. **Cross-shard relations are the hard case** — a relation that crosses shard keys must fan out through the Query Coordinator. Define which relation topologies are supported (same-shard = cheap; cross-shard = coordinator round-trip or disallow in v1).

### 1.4 Schema triggers / lifecycle hooks `[matrix #13]`

✅ Landed 2026-06-03 — `packages/do/src/triggers.ts`.

**What kitcn has.** `.triggers({...})` on schema extension for cross-row side effects on insert/update/delete (the documented home for denormalization, counters, audit).

**Cirrus today.** Direct CRUD, no hook invocation.

**Cirrus mapping.** Fire inside the DO transaction for shard-local writes (atomic). Triggers that touch _other_ shards must enqueue async work (Cloudflare Queues) — not transactional; document the boundary.

### 1.5 Online data migrations `[matrix #14]`

✅ Landed — `packages/do/src/data-migration.ts`: per-DO state tracking + `runDataMigration` with `batchSize`/`maxBatches`/`dryRun`, keyset batches + resume.

**What kitcn has.** `defineMigration({ id, up: { table, migrateOne }, down })`, `defineMigrationSet`, CLI `migrate create|up|down` with `--steps`/`--to`/`--prod`, `batchSize`, `writeMode: safe_bypass|normal`, `dryRun`.

**Cirrus today.** `packages/d1` + CLI `migrate` do **SQL schema** migrations only — no per-document data backfills.

**Cirrus mapping.** Schema migrations stay as-is. Add a _data_-migration runner that iterates rows in batches per DO (and across shards via the coordinator), tracks run state in a migrations table inside each DO, supports dry-run + rollback.

---

## Tier 2 — Client & framework reach

### 2.1 TanStack Query integration + `useInfiniteQuery` `[matrix #19, #20]`

✅ Landed — `packages/react` is built on TanStack Query: `useQuery`/`useInfiniteQuery`/`useMutation`, the last rebuilt on `@tanstack/react-query`'s `useMutation` with `onMutate`/`onSettled` ref-counted pending.

kitcn builds the React client on TanStack Query (`queryOptions`, `infiniteQueryOptions`, SSR hydration via SuperJSON, `staleTime: Infinity` since the socket pushes updates). Cirrus adopted TanStack as the cache substrate (ecosystem gravity, devtools, SSR hydration) while keeping its own optimistic + offline-queue layer on top.

### 2.2 Typed HTTP / REST router `[matrix #21]`

✅ Landed 2026-06-03 — `packages/server/src/http.ts`.

cRPC HTTP routes: `publicRoute.get('/api/todos').searchParams(z…).output(z…).query(...)`, Hono integration, webhooks, streaming. Cirrus has RPC + WS but no typed REST surface. **High practical value** for inbound webhooks (Stripe, Resend, OAuth callbacks) — those need real HTTP endpoints. Depends on Tier 1.1 (builder).

### 2.3 Server-side typed callers `[matrix #3]`

✅ Landed — codegen emits a typed `createCaller(ctx)` (`packages/codegen/src/emit.ts`) for server-to-server query/mutation/action calls without HTTP; `ActionCtx.run*` also remains available.

### 2.4 RSC / SSR server helpers `[matrix #22]`

✅ Landed — `packages/react/src/server.ts`, exported as `@cirrus/react/server` (no `"use client"`, opens no socket, touches no browser globals — safe to import from a Server Component).

Two RSC flows, mirroring kitcn's `kitcn/rsc`:

- **Cache hydration.** `prefetchQuery(queryClient, client, fn, args)` runs the query server-side over HTTP RPC and seeds the `QueryClient` under the exact key `useQuery` reads, so the client's first paint has data and a live WS subscription attaches on mount. Pair with the re-exported `dehydrate` + `HydrationBoundary`.
- **Explicit token.** `preloadQuery` → serializable `Preloaded<T>` handed to a client `usePreloadedQuery`; `preloadedQueryResult` extracts the value.

Plus one-shot inline reads (`fetchQuery`/`fetchMutation`/`fetchAction`), a request-scoped `createServerClient({ url, token?, fetch? })` (auth runs as the signed-in user by forwarding a cookie/bearer `token`), and the transport-free `cirrusQueryOptions` factory for `queryClient.ensureQueryData`. Covered by `packages/react/__tests__/server.test.tsx` (10 tests) and documented in `apps/docs/content/docs/api/react.mdx` §"Server Components (Next.js App Router)". Remaining nice-to-have (not a parity gap): a standalone Next.js example app under `apps/` — the worked examples currently live in the docs.

### 2.5 Solid.js client `[matrix #23]`

Full `src/solid/` parallel to React in kitcn. Cirrus is React-only by design decision (PLAN.md: "Solid/Vue/Svelte deferred to v0.2"). Keep deferred.

---

## Tier 3 — Performance, security & ecosystem

### 3.1 Aggregates + ranked index `[matrix #15, #16]`

✅ Landed — `count()` is O(1) via `__agg_` counter tables (DO+D1); `sum`/`avg`/`min`/`max` are answered from the reducer-aware `__agg_` companion (`__value__`+`__count__`) by index lookup; `groupBy(count)`; `rank()`/`rankPage()` ship in `packages/do/src/rank.ts` with cross-shard merge in the coordinator (`orchestrateRank`/`mergeRank`) and sum/max/min cross-shard merge.

`aggregateIndex` → O(1) `count()`/`aggregate()`/`groupBy()` with no-scan filter planning; `rankIndex` + `rank()` (btree) for rankings, random access, sorted pagination; auto-backfill on dev. Cirrus only has cross-shard _merge_ strategies (sum/topK) — single-shard counts must enumerate rows. **Convex-coupled:** kitcn uses native count syscalls; on Cirrus this is a btree/counter structure maintained in DO-SQLite via triggers (ties to 1.4). Highest-effort item; sequence after the ORM + triggers land.

### 3.2 Row-Level Security `[matrix #12]`

✅ Landed — `packages/server/src/rls/middleware.ts` (policy defs, read filtering, default-deny write rejection, roles, `COUNT_RLS_UNSUPPORTED`, DO+D1 seam) plus permissions/grant: `definePermission`, role `permissions`, and `ctx.auth.can(permission)` in policy context.

`orm/rls/` — policies, roles, evaluator, role tables. Cirrus auth is identity-only. Implement as middleware (1.1) + ORM query rewriting (1.2). Note kitcn's documented constraint: `count()` is unsupported in RLS-restricted contexts (`COUNT_RLS_UNSUPPORTED`).

### 3.3 Rate limiting `[matrix #17]`

✅ Landed 2026-06-03 — `packages/ratelimit`.

`kitcn/ratelimit`: token-bucket / sliding-window algorithms, deny list, React `useRateLimit` hook, store. Natural fit as Cirrus middleware (1.1) with state in a DO (counter) or KV. Self-contained once the builder exists.

### 3.4 Vector search / vector columns `[matrix #18]`

✅ Landed 2026-06-03 — `packages/vectors` (`createVectors`, `.vectorize()`, `defineVectorIndex`).

kitcn `vector()` column builder. Cirrus has FTS search indexes but no vector type. On Cloudflare maps to **Vectorize**; design a `v.vector()` / vector column + query surface backed by Vectorize bindings.

### 3.5 Plugin system `[matrix #24]`

`definePlugin('<key>', …)` + `defineSchemaExtension('<key>', { tables }).relations().triggers()` + `plugin.middleware()` injecting `ctx.api.<plugin>`; app installs via `defineSchema(tables).extend(myExtension())`. This is how kitcn ships auth/resend/ratelimit as composable units. Depends on 1.1 + 1.2 + 1.4. Defines the extension contract for everything else.

### 3.6 shadcn-style `add` registry `[matrix #25]`

The defining "kitcn" mechanic: `npx kitcn add auth|ratelimit|resend` scaffolds user-owned code (schema, runtime, templates) into the project, with a planner, dependency resolution, dry-run, and schema reconciliation/ownership tracking. Cirrus has remote whole-project templates (`giget`) but no per-feature registry. High marketing/adoption value; sequence after the plugin contract (3.5) so registry items target a stable shape.

### 3.7 Auth feature expansion `[matrix #28]`

better-auth org/teams, admin (ban/impersonate), billing (Polar) adapters. Cirrus wraps better-auth thinly — most of these are better-auth plugins surfaced through Cirrus's schema + registry, so they ride on 3.5/3.6.

### 3.8 CLI command expansion `[matrix #26, #27]`

✅ Commands landed — `analyze` (wrangler dry-run → bundle size + top modules + `_generated`), `env` (`.dev.vars` list/get/set/unset + push secrets), `info` (resolved `@cirrus/*` versions + wrangler + schema summary), `verify` (wrangler validate + codegen dry-run + `tsc --noEmit`), `view` (open studio), `docs` (open docs) — all in `packages/cli/src/commands/`, registered via Cerebro in `cli.ts`. Still open (#27): TanStack Start + Expo init templates.

---

## Recommended sequencing

```
Phase A (unlocks everything):     1.1 builder+middleware → 1.2 ORM query layer
Phase B (data ergonomics):        1.3 relations → 1.4 triggers → 1.5 data migrations
Phase C (reach, parallelizable):  2.1 TanStack/infinite · 2.2 HTTP router · 2.3 callers
Phase D (perf+security):          3.2 RLS · 3.3 rate-limit (both ride 1.1)
Phase E (ecosystem):              3.5 plugins → 3.6 registry → 3.7 auth expansion
Phase F (heavy/independent):      3.1 aggregates+rank · 3.4 vector (Vectorize)
Anytime:                          2.4 RSC · 2.5 Solid · 3.8 CLI/templates
```

Phase A is the keystone — it is the abstraction the majority of remaining items attach to.

---

## Architectural caveats (kitcn → Cirrus)

1. **Aggregates & counts** lean on Convex count syscalls; Cirrus must maintain its own counter/btree structures in DO-SQLite (via triggers). Same API surface, different engine.
2. **Online migrations** in kitcn iterate a single Convex dataset; Cirrus must iterate **per-shard** and coordinate cross-shard runs.
3. **Relations & triggers** are cheap within a shard (local SQLite, one transaction) but cross-shard cases need the Query Coordinator or Queues and are **not transactional** — define supported topologies explicitly.
4. **RSC/Next helpers** assume a Node/Next server; the Cirrus equivalent is Cloudflare Pages SSR.
5. **Vector** maps to Cloudflare **Vectorize**, not an in-DB column — a binding, not pure SQLite.
6. Cirrus's **sharding, offline queue, optimistic updates, and D1 bookmarks have no kitcn equivalent** — preserve them; any TanStack adoption (2.1) must keep optimistic+offline first-class.

---

## Already at parity — no action

Mail/Resend (`packages/mail`), R2 storage + signed URLs (`packages/storage`), scheduler + cron (`packages/scheduler`), codegen (`packages/codegen`), Vite plugin (`packages/vite`), wrangler config validation (`packages/config`), and core CLI (`init`/`dev`/`deploy`/`codegen`/`run`/`reset`/`migrate`).

---

## Remaining gaps (verified 2026-06-03)

After the Tier 1–3 landings above (including the 2026-06-08 reconciliation that closed #3/#12/#14/#15/#16/#20), these are the genuine remaining gaps, confirmed by source read + passing test suites:

- **D1 full-text search.** FTS works on the DO backend only; D1 / `.global()` tables have no FTS5 surface yet (being implemented separately now).
- **`SearchIndexName<T>` typing.** The type is not wired into the reader signature.
- **`baseWhere` on the typed read facade.** RLS `baseWhere` injection is only exposed on `count`; the typed read facade does not surface it.
- **Cross-backend relation loading.** Relations that cross the DO/D1 backend boundary throw by design (`relations.ts:112`).
- **Solid.js client (#23).** Deferred by design.
- **shadcn-style `add` registry (#25).** No per-feature registry.
