# Cirrus ↔ Convex Parity & Gap Analysis

> Generated 2026-06-04 from a code-grounded inventory of the repo (10 Convex feature
> domains verified against the actual `packages/*` and `apps/*` source — not guessed).
> Tally: **117 features at full parity · 12 areas where Cirrus leads · 15 partial · 17 missing.**

Legend: **full** = equivalent capability · **partial** = present but shallower · **missing** = no equivalent · **cirrus-only** = Cirrus exceeds Convex.

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

### Tier 1 — Architectural / fundamental (hardest; these define the platform)

| # | Feature | Status | Gap |
|---|---------|--------|-----|
| 1 | **Node.js-runtime actions (`"use node"`)** | missing | Actions run in workerd (edge) only. No separate Node runtime → cannot use Node-built-in / Node-only npm packages in actions. |
| 2 | **Cross-shard / global transactions** | missing | Mutations are ACID only within a single shard (DO). No atomic write across shards, or across sharded↔global(D1) tables; cross-backend cascades are one-way (documented consistency loss). Convex mutations are globally serializable. |
| 3 | **Cross-query consistency snapshot** | partial | Per-shard consistency with row-dependency tracking, but no cross-shard MVCC / version vectors / causal snapshot across shards. |
| 4 | **Durable action execution** | missing | No `@convex-dev/workpool` (bounded-concurrency pools) and no action-retrier (retry w/ backoff). Action retry/pooling must be hand-rolled via `ctx.scheduler`. |
| 5 | **Installable Component ecosystem** | partial/missing | `defineComponent`/`definePlugin` exist but are local plugins/schema-extensions: namespacing is conventional (not runtime-enforced), all plugin tables share the host DB (no sandboxed storage boundary), functions must be manually re-exported (no auto codegen namespacing — flagged as a v1 follow-up in `plugin.ts:214`), and there's no per-component scheduler/queue. No `@convex-dev/*`-style installable, sandboxed npm components. |

### Tier 2 — Meaningful product gaps

| # | Feature | Status | Gap |
|---|---------|--------|-----|
| 6 | **Presence / collaborative cursors** | missing | No presence/awareness API (`@convex-dev/presence` equivalent). Must DIY via subscriptions + mutations. |
| 7 | **Log streaming to external services** | missing | Logs sit in a bounded in-memory ring buffer + dashboard. No built-in adapters to ship to Axiom / Datadog / webhook (the `ObservabilitySink` interface exists; adapters are user-supplied). |
| 8 | **Exception reporting (Sentry)** | missing | No bundled Sentry client/adapter — only the optional `ObservabilitySink`. |
| 9 | **Streaming export connectors (Fivetran/Airbyte)** | missing | Raw material exists (CDC `/sync`, full-table `/export`), but no turn-key data-warehouse connectors. |
| 10 | **`ctx.storage` upload in handlers** | partial | No `generateUploadUrl`/`store` on the handler `ctx` (ActionCtx/MutationCtx/QueryCtx). Upload only via the standalone `@cirrus/storage` client; signed-URL helper also lacks a `contentType` param despite docs showing it. |
| 11 | **File Range requests / partial downloads** | missing | No HTTP 206 Partial Content support. |
| 12 | **Serve files via `httpAction`** | partial | No native helper to stream storage content from an HTTP action — must proxy R2 manually. |
| 13 | **File sha256 metadata** | partial | Returns R2 `ETag`, not an explicit sha256 like Convex. |
| 14 | **Auth: WebAuthn / passkeys** | missing | Not exposed in `@cirrus/auth`; would need a better-auth upgrade/import. |
| 15 | **Auth: Clerk / Auth0 integration** | missing | No direct integration; must wire via better-auth custom providers. |
| 16 | **Auth: session token rotation / policies** | partial | Only better-auth's built-in TTL; no automatic rotation or richer session policies. |

### Tier 3 — Polish / DX

| # | Feature | Status | Gap |
|---|---------|--------|-----|
| 17 | **Persisted function metrics** | partial | Metrics are in-memory (reset on DO restart); no time-series/graphs, call hierarchies, or custom dimensions. |
| 18 | **Env vars as a runtime data store** | partial | Cirrus uses Workers secrets (platform bindings) managed via wrangler; Convex offers a durable, runtime-queryable env service. |
| 19 | **Automatic PITR** | partial | PITR is manual (CLI restore + CDC-retention replay), not an always-on fine-grained/branching service. |
| 20 | **Live-updating pagination deltas** | partial | Pages update live (each page is its own subscription), but client-side delta merging isn't implemented (`ServerDataMessage.delta` is an opaque blob on the wire). |
| 21 | **Scheduler list/inspect** | partial | Implemented in `SchedulerDO` storage but not exposed on the public `Scheduler` client (requires direct DO `/list` access). |
| 22 | **Aggregate randomness / offset pagination** | missing | No random-access operator; keyset cursors only (offset pagination is omitted by design). |
| 23 | **Dashboard: deployment/env management UI** | missing | No UI for deployments, env bindings, rollback, or deploy history. |
| 24 | **CLI `verify` (type check)** | partial | Appears to be a stub for future enhancement. |

---

## Recommendation (effort × value)

- **Biggest strategic gaps:** #2 (cross-shard transactions) and #4/#5 (durable actions + installable components). #2 is partly inherent to the DO-sharding model that gives Cirrus its scaling lead — treat it as a deliberate trade-off, not a bug.
- **Highest effort-to-value (bounded, additive):** #7/#8/#9 (log/Sentry/export adapters) and #10–#13 (in-handler upload + range serving + serve-from-httpAction). These are self-contained features with no architectural risk.
- **Quick DX wins:** #21 (expose scheduler list/inspect on the client), #10 (`generateUploadUrl` on `ctx.storage`).

> Benchmark context: the closest Convex-on-Cloudflare competitor is `zerodeploy-dev/zeroback` — useful for tracking parity over time.
