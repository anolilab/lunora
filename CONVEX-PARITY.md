# Cirrus ↔ Convex Parity & Gap Analysis

> Generated 2026-06-04 from a code-grounded inventory of the repo (10 Convex feature
> domains verified against the actual `packages/*` and `apps/*` source — not guessed).
> Original tally: **117 full · 12 lead · 15 partial · 17 missing**.
> **Refreshed 2026-06-07:** of the 24 tracked gaps below, **16 are now closed** (#4, #6–#17 as
> noted, #20, #21, #24, plus the #5 registry) and **5 are deliberate won't-do/by-design** (#1,
> #2, #3, #18, #22, and #23's deployment plane) — the per-row Status column reflects current
> code. What remains is a short tail: managed PITR (#19 ships the building block), the buildable
> read-only half of #23, and #9's connector wrappers — plus the `PLAN3.md` dashboard
> differentiators, which go beyond raw Convex parity.

Legend: **full** = equivalent capability · **partial** = present but shallower · **missing** = no equivalent · **cirrus-only** = Cirrus exceeds Convex.

---

## ✅ Shipped since this analysis (Phase A — 2026-06)

The following gaps are now closed (see the tiered tables below for the original descriptions):

- **#21 Scheduler introspection** — `ctx.scheduler.cancel/list/get` + `list/get` on the `@cirrus/scheduler` client.
- **#10 In-handler storage upload** — `ctx.storage.generateUploadUrl()` + `store()`; `contentType` now supported in signed PUT URLs.
- **#11 / #12 / #13 File serving** — `serveStorageObject(ctx, key, request)` httpAction helper with HTTP **Range/206** + `Content-Range`/416, `ETag`, and `sha256` surfaced in object metadata.
- **#7 / #8 Observability adapters** — built-in `consoleSink` / `webhookSink` (Axiom/Datadog) / `sentrySink` / `combineSinks`, exported from `@cirrus/runtime`.

## ✅ Shipped since this analysis (Phase B — 2026-06-06)

A second wave closed the query-layer DX gaps the original inventory had counted as
"at parity" but were actually missing, plus several tracked items. These supersede the
relevant rows/tally below (the **117 full / 15 partial / 17 missing** counts predate this wave):

- **Function composition** — `ctx.runQuery` / `ctx.runMutation` from queries & mutations (in-process, same ctx), with a `RUN_DEPTH_EXCEEDED` cycle guard.
- **Query builder** — `.order("asc"|"desc")`, `.unique()`, and `ctx.db.normalizeId(table, id)`.
- **Reactive pagination** — range-bounded `(cursor, endCursor]` pages with client-side split/join rebalancing (the page-boundary half of **#20**; the wire-level delta _merge_ is still open).
- **Optimistic `localStore`** — multi-query optimistic updates (`useMutation(...).withOptimisticUpdate`), generalizing the per-call rollback.
- **Code-first crons** — `cronJobs()` builder → codegen discovery/emit → `wrangler.jsonc` sync → runtime `scheduled()` dispatch (incl. internal functions via a system-dispatch header) + a `cirrus-cron` generator.
- **Client auth identity** — `useAuth().user` populated from the session endpoint (closes the client side of the Phase-6 auth gap).
- **Storage metadata** — `ctx.storage.getMetadata(key)`.
- **`ctx.db.system` system tables** — read-only `_scheduled_functions` / `_storage` proxies (eventually-consistent, not transaction-snapshot — documented).
- **Component table isolation** — schema-extension tables auto-namespaced (`${key}_table`, runtime-enforced) + codegen `.extend()` discovery + type-safe `RankIndexName` (see **#5**, re-scoped below).

## ✅ Shipped since this analysis (Phase C — 2026-06-06)

A third wave closed the remaining bounded gaps:

- **#4 Durable action execution** — `createWorkpool({ maxConcurrency })` (durable per-pool semaphore in `SchedulerDO`) + per-enqueue retry policy (`maxAttempts`/backoff) over the existing attempts+dead-letter, with the runtime releasing slots via `/complete`. `@convex-dev/workpool` + action-retrier parity, no new DO binding.
- **#6 Presence** — `definePresence()` (auto-namespaced `presence_present` table + `heartbeat`/`listPresent`/internal `sweep`, read-time TTL) + `usePresence(roomId)`; `heartbeat` patches one row so the roster rides the per-row delta merge.
- **#9 Export connectors** — `POST /_cirrus/admin/connector/sync`: resumable CDC-position incremental source (inserts/updates/delete tombstones) + `toFivetranResponse`/`toAirbyteMessages` helpers. (The deployable connector wrappers remain an external effort.)
- **#14 Passkeys** — `passkey` server plugin re-exported from `@cirrus/auth/plugins` (`@better-auth/passkey`); the browser `passkeyClient` is user-wired.
- **#16 Session policies** — `SessionPolicy` + `sessionPresets` (`rolling`/`strict`/`longLived`) forwarded to better-auth.
- **#17 Persisted metrics** — durable `__cirrus_metrics`/`_buckets` SQLite tables (survive restart) + coarse time-series; admin RPCs read persisted data.
- **#20 Live pagination deltas** — completed end-to-end: the DO now emits per-row `{type:"delta"}` frames (diffed against the prior result, order-preserving, snapshot fallback) and the client merges them via `applyDelta`.
- **#5 (registry)** — `cirrus registry add | list | view | build` (giget resolve → manifest plan/dry-run/`--diff`/`--overwrite` → `create-or-skip` with a lock-aware 3-way upgrade + idempotent `schema-extension` AST merge → deps/devDeps/wrangler-bindings(merged)/`.dev.vars` apply). Manifests carry `title`/`docs`/`envVars`; the catalog is generated (`registry build`); items type-check in CI. Function-namespacing landed (`api.<key>.*`). Nine items shipped: ratelimit, presence, mail, storage, crons, auth (+auth-clerk/auth-auth0), backup. See `COMPONENT-REGISTRY.md`.
- **#15 (Clerk/Auth0)** — `auth-clerk` / `auth-auth0` registry items scaffold the provider as a better-auth `genericOAuth` plugin on top of the base `auth` item (provider client-id/secret env vars).
- **#19 (PITR building block)** — `backup` registry item: a scheduled `internalAction` snapshotting configured tables to a dedicated R2 bucket as NDJSON; pairs with `cirrus backup restore`. (An always-on managed PITR service remains out of scope.)
- **#24 (CLI `verify`)** — `cirrus verify` now runs a real `tsc --noEmit` over the project (injectable spawner, `--no-typecheck` opt-out, skips cleanly without a tsconfig) on top of the wrangler + codegen checks.

---

## Where Cirrus already leads Convex

These are differentiators — do not regress them.

- **Row-level security** — `definePolicy` / `defineRole` / `rls` (`packages/server/src/rls/`). Convex has no built-in RLS.
- **Row-level sharding** — `defineTable().shardBy(field)` partitions a table across many Durable Objects (`packages/server/src/schema.ts:258`), with **automatic client-side shard routing** (`packages/client/src/cirrus-client.ts`).
- **Global tables in D1** — `defineTable().global()` moves a table to Cloudflare D1 for cross-tenant/cross-shard reads.
- **Cross-shard rank** — `packages/do/src/rank.ts` (ranked queries spanning shards).
- **Trigger-maintained aggregate/rank indexes** — kept in sync via table triggers.
- **Client `useRateLimit`** — client-side token-bucket / fixed-window prediction (`packages/react/src/use-rate-limit.ts`).
- **Shard-aware dashboard + admin RPC introspection** — `__cirrus_admin__:*` RPC layer; panels target specific shards; separate shard-local vs global data browsers.

---

## Gaps (what Cirrus still misses vs Convex)

> **Status note (refreshed 2026-06-06).** The tables below are the original 2026-06-04
> assessment, kept for detail. Current reality by row:
>
> - **Closed** (see Phase A/B/C above): #4, #6, #7, #8, #9 (source endpoint), #10, #11, #12,
>   #13, #14, #15, #16, #17, #20, #21, #24 — plus the #5 `cirrus registry` system (now with
>   function-namespacing, a 9-item catalog, and the CI-checked add/list/view/build surface). The
>   query-layer items the original inventory miscounted as parity (composition,
>   `.order`/`.unique`/`normalizeId`, optimistic `localStore`, crons, reactive pagination,
>   `ctx.db.system`) are also done.
> - **Deliberate won't-do / by-design:** #1 (workerd has no Node runtime for actions), #2 & #3
>   (cross-shard atomicity / snapshot — the price of the sharding model that is Cirrus's lead),
>   #22 (keyset-only pagination), #18 (no runtime env store — secrets live in the wrangler/CF
>   plane; PLAN3 §3.2), and the deployment/rollback half of #23 (CF's control plane — dashboard
>   deep-links, not a reimplementation).
> - **Still genuinely open:** #19 (always-on managed PITR — the `backup` registry item ships the
>   scheduled-snapshot building block), the buildable half of #23 (a read-only env/bindings
>   Settings tab — PLAN3 §3.2), and #9's deployable Fivetran/Airbyte connector _wrappers_ (the
>   source endpoint exists; the wrappers are an external effort). The dashboard differentiators
>   (correlated request log, causal insights, app-aware Files) are tracked in `PLAN3.md`.

### Tier 1 — Architectural / fundamental (hardest; these define the platform)

| #   | Feature                                        | Status  | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Node.js-runtime actions (`"use node"`)**     | missing | Actions run in workerd (edge) only. No separate Node runtime → cannot use Node-built-in / Node-only npm packages in actions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2   | **Cross-shard / global transactions**          | missing | Mutations are ACID only within a single shard (DO). No atomic write across shards, or across sharded↔global(D1) tables; cross-backend cascades are one-way (documented consistency loss). Convex mutations are globally serializable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 3   | **Cross-query consistency snapshot**           | partial | Per-shard consistency with row-dependency tracking, but no cross-shard MVCC / version vectors / causal snapshot across shards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 4   | **Durable action execution**                   | missing | No `@convex-dev/workpool` (bounded-concurrency pools) and no action-retrier (retry w/ backoff). Action retry/pooling must be hand-rolled via `ctx.scheduler`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5   | **Component ecosystem** (re-scoped 2026-06-06) | shipped | **Decision: pursue the kitcn/shadcn "registry" model, NOT Convex's sandboxed-component model.** Convex's `@convex-dev/*` components are black-box, runtime-sandboxed npm packages (own tables/storage/scheduler the app can't read; writes join the caller's transaction). That model exists for a _managed, multi-tenant_ backend running untrusted third-party code, and it would require **cross-DO transactions (gap #2 — inherently hard on the sharding substrate)** and per-component storage isolation to replicate. It also clashes with Cirrus's _user-owned-infra_ positioning, and Convex is FSL (ideas-only, can't vendor). **Won't-do: sandboxed runtime components.** Instead, build on the existing kitcn-style plugin contract — `definePlugin`/`defineSchemaExtension`/`.extend()` with **auto table-namespacing (runtime-enforced)** and **codegen `.extend()` discovery** — plus the `cirrus registry` system that scaffolds **user-owned** schema+functions+middleware into the project (shadcn-style, white-box, editable; PLAN2 §3.6). **Shipped:** `cirrus registry add | list | view | build` (giget resolve, plan/`--dry-run`/`--diff`/`--overwrite`, lock-aware whole-file upgrades, idempotent schema-extension AST merge, dep/devDep/wrangler-binding(merge)/`.dev.vars`apply); manifest`title`/`docs`/`envVars`; a generated, CI-checked catalog; **auto function-namespacing** (`api.<key>.\*`+ typed`ctx.api.<key>`); and a 9-item catalog. See `COMPONENT-REGISTRY.md`. |

### Tier 2 — Meaningful product gaps

| #   | Feature                                            | Status  | Gap                                                                                                                                                                                                                        |
| --- | -------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | **Presence / collaborative cursors**               | missing | No presence/awareness API (`@convex-dev/presence` equivalent). Must DIY via subscriptions + mutations.                                                                                                                     |
| 7   | **Log streaming to external services**             | missing | Logs sit in a bounded in-memory ring buffer + dashboard. No built-in adapters to ship to Axiom / Datadog / webhook (the `ObservabilitySink` interface exists; adapters are user-supplied).                                 |
| 8   | **Exception reporting (Sentry)**                   | missing | No bundled Sentry client/adapter — only the optional `ObservabilitySink`.                                                                                                                                                  |
| 9   | **Streaming export connectors (Fivetran/Airbyte)** | missing | Raw material exists (CDC `/sync`, full-table `/export`), but no turn-key data-warehouse connectors.                                                                                                                        |
| 10  | **`ctx.storage` upload in handlers**               | partial | No `generateUploadUrl`/`store` on the handler `ctx` (ActionCtx/MutationCtx/QueryCtx). Upload only via the standalone `@cirrus/storage` client; signed-URL helper also lacks a `contentType` param despite docs showing it. |
| 11  | **File Range requests / partial downloads**        | missing | No HTTP 206 Partial Content support.                                                                                                                                                                                       |
| 12  | **Serve files via `httpAction`**                   | partial | No native helper to stream storage content from an HTTP action — must proxy R2 manually.                                                                                                                                   |
| 13  | **File sha256 metadata**                           | partial | Returns R2 `ETag`, not an explicit sha256 like Convex.                                                                                                                                                                     |
| 14  | **Auth: WebAuthn / passkeys**                      | missing | Not exposed in `@cirrus/auth`; would need a better-auth upgrade/import.                                                                                                                                                    |
| 15  | **Auth: Clerk / Auth0 integration**                | shipped | `cirrus registry add auth-clerk` / `auth-auth0` scaffold each as a better-auth `genericOAuth` provider on the base `auth` item.                                                                                            |
| 16  | **Auth: session token rotation / policies**        | partial | Only better-auth's built-in TTL; no automatic rotation or richer session policies.                                                                                                                                         |

### Tier 3 — Polish / DX

| #   | Feature                                      | Status              | Gap                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17  | **Persisted function metrics**               | partial             | Metrics are in-memory (reset on DO restart); no time-series/graphs, call hierarchies, or custom dimensions.                                                                                                                                                                                                                                    |
| 18  | **Env vars as a runtime data store**         | by-design           | Deliberate (PLAN3 §3.2): Cirrus uses Workers secrets/bindings managed via wrangler — **view in Cirrus, edit in wrangler/CF**, no runtime config store. A runtime-mutable env service would duplicate the platform's secret plane. (App data that needs to be runtime-editable belongs in a table.)                                             |
| 19  | **Automatic PITR**                           | partial             | `cirrus registry add backup` ships a scheduled-snapshot cron (→ R2 NDJSON) as the PITR building block; an always-on managed/branching service is still out of scope.                                                                                                                                                                           |
| 20  | **Live-updating pagination deltas**          | partial             | Pages update live (each page is its own subscription), but client-side delta merging isn't implemented (`ServerDataMessage.delta` is an opaque blob on the wire).                                                                                                                                                                              |
| 21  | **Scheduler list/inspect**                   | partial             | Implemented in `SchedulerDO` storage but not exposed on the public `Scheduler` client (requires direct DO `/list` access).                                                                                                                                                                                                                     |
| 22  | **Aggregate randomness / offset pagination** | missing             | No random-access operator; keyset cursors only (offset pagination is omitted by design).                                                                                                                                                                                                                                                       |
| 23  | **Dashboard: deployment/env management UI**  | partial / by-design | Split (PLAN3 §3.1–3.2 + Non-goals): deployments / rollbacks / routes are an **explicit non-goal** — CF's control plane, reached via dashboard deep-links, not half-reimplemented. Env/bindings get a planned **read-only** Settings tab (values masked). The app-lens dashboard (Data/Schema/Functions/Metrics/Logs/Insights/…) already ships. |
| 24  | **CLI `verify` (type check)**                | shipped             | `cirrus verify` runs `tsc --noEmit` over the project (plus wrangler + codegen checks); `--no-typecheck` opts out, skips cleanly without a tsconfig.                                                                                                                                                                                            |

---

## Recommendation (effort × value) — refreshed 2026-06-06

The bounded, high-value gaps are essentially cleared (Phase A/B/C). What's left:

- **Inherent trade-offs (won't-do / by-design):** #1 (no Node runtime), #2/#3 (cross-shard atomicity & snapshot), #22 (keyset-only), #18 (no runtime env store), and #23's deployment/rollback half (CF's control plane). #2 is the deliberate price of the DO-sharding model that gives Cirrus its scaling lead — not a bug; the env/deploy ones are deliberate CF hand-offs (PLAN3 §3.1–3.2): Cirrus is the app lens, CF is the infra plane.
- **#5 registry — done & extensible:** function-namespacing, the add/list/view/build surface, and a 9-item CI-checked catalog all shipped. Growth from here is just authoring more items. See `COMPONENT-REGISTRY.md`.
- **Remaining additive features:** an always-on managed PITR beyond the #19 `backup` snapshot item, the deployable Fivetran/Airbyte connector wrappers on top of #9's source endpoint, and a read-only env/bindings Settings tab (the buildable half of #23).
- **Dashboard differentiators (separate roadmap):** the correlated structured request log, causal metrics→insights attribution, and app-aware Files (schema↔R2) — the "beat Cloudflare" work in `PLAN3.md`, beyond raw Convex parity.

> Benchmark context: the closest Convex-on-Cloudflare competitor is `zerodeploy-dev/zeroback` — useful for tracking parity over time.
