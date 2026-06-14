# Convex Gap Analysis

> Date: 2026-06-14 · Branch: `feat/studio-schema-diagram`
> Scope: what Cirrus is missing or weaker on compared to Convex, based on a
> source-level pass over `packages/`. Cirrus is at or above Convex parity on most
> core features; this document focuses on the genuine gaps and trade-offs.

## TL;DR

Cirrus is much closer to Convex parity than `CLAUDE.md` implies, and exceeds
Convex in several areas (HTTP router, cross-shard relations, 30-day PITR,
Fivetran/Airbyte CDC, better-auth breadth). The one headline feature gap is
**durable workflows** — and that should be built by **wrapping Cloudflare
Workflows** (a GA first-party durable-execution engine), not from scratch.

Priority order to close gaps:

1. Durable workflows (wrap Cloudflare Workflows) — highest leverage
2. Aggregates at scale (O(log n) running counts/sums)
3. Convex "Components" isolated-state model
4. OCC/versioning ergonomics + `_updatedTime`
5. Online/staged index building
6. Platform polish (hosted dashboard, preview deploys, env UI, turn-key observability)

---

## Real gaps (ranked by impact)

### 1. Durable workflows — the one big hole

**Status: absent.** No equivalent to Convex's workflow component (deterministic,
replay-based, multi-step durable execution with per-step retries and survival
across restarts).

- What exists today: `ctx.scheduler.runAfter/runAt` with retry policies, a
  workpool for bounded concurrency, and a dead-letter queue
  (`packages/scheduler/`).
- What's missing: chaining steps into a single durable unit that **replays
  deterministically** on failure. Today a failed multi-step job re-runs from
  scratch — no memoized step results, no `workflow.step(...)` boundary.
- Why it matters: most-requested Convex feature for sagas, multi-stage AI
  pipelines, and long-running orchestration.

**Build approach — wrap Cloudflare Workflows (GA), don't reinvent.**
Cloudflare Workflows is a first-party durable-execution engine on Workers and
provides essentially the Convex feature set:

- `WorkflowEntrypoint` + `step.do()` — each step's result is persisted and
  **memoized**; on failure only that step retries (configurable policy);
  instances survive Worker restarts and redeploys.
- `step.sleep()` / `step.sleepUntil()` — durable delays (minutes → weeks), not
  held in memory.
- `step.waitForEvent()` — pause until an external event (human-in-the-loop,
  webhooks, approvals).
- Instance lifecycle: `env.MY_WORKFLOW.create({ id, params })` + status/pause/
  resume/terminate via binding + REST API.
- Bound via `[[workflows]]` in `wrangler.jsonc` — the same binding model
  `@cirrus/config` already validates/reconciles.

Proposed shape (`@cirrus/workflow`):

- A `defineWorkflow` / `workflow(...)` builder that codegen compiles into a
  `WorkflowEntrypoint` class (same pattern as `@cirrus/container`'s generated
  container DO classes).
- Inject a Cirrus `ctx` into steps so `step.do("...", () => ctx.runMutation(...))`
  works with typed function refs, auth, and `ctx.db`.
- Wire the `[[workflows]]` binding through `@cirrus/config`; surface
  `ctx.workflows.create(...)` on `MutationCtx`/`ActionCtx` (mirror `ctx.scheduler`).
- Studio tab for instance status/history (reuse the scheduled-jobs panel as a
  template).

Caveats: steps must be JSON-serializable + idempotent (same determinism contract
Convex imposes); Cloudflare bills for workflow instance state storage (billing
started 2025-09-15).

### 2. Convex "Components" isolated-state model

**Status: partial.** Cirrus has plugins (`definePlugin` / `.use()`), the registry
(`cirrus add presence`), and packages — but not Convex's **isolated-state
component** model where a mounted component gets its own _namespaced tables +
functions_ with a transactional boundary callers can't reach around. Cirrus
plugins extend `ctx` and merge schema; they don't sandbox state. Matters for an
ecosystem of installable, encapsulated modules.

### 3. Aggregates at scale

**Status: weak.** `_count` exists on relations, but there's no Convex-style
**aggregate component** (O(log n) running counts/sums/min/max/rank via a balanced
tree). At scale, `_count` over a FK is a table scan. Convex solved this with a
dedicated component — worth matching.

### 4. OCC / versioning ergonomics

**Status: partial.** `ConflictError` + raw `BEGIN/COMMIT` exist
(`packages/do/src/transaction.ts`, `shard-do.ts`), but conflict detection is
**manual** — no transparent `_version` field, no automatic read-set conflict
detection like Convex's serializable mutations. Also **no `_updatedTime`** system
field (only `_id` + `_creationTime`). Small but visible parity gaps.

### 5. Online / staged index building

**Status: absent.** Indexes are schema-time declarations only. No background
backfill of a _new_ index over existing data without a manual data migration.
Convex builds indexes in the background on deploy.

---

## Platform gaps (partly by design — Cirrus is self-hosted on Cloudflare)

| Area                                          | Convex      | Cirrus                                    | Verdict                          |
| --------------------------------------------- | ----------- | ----------------------------------------- | -------------------------------- |
| Hosted production dashboard                   | Cloud       | Local Studio only                         | Gap, but intentional (self-host) |
| Preview deployments                           | Per-branch  | Wrangler `env` blocks only                | Gap                              |
| Env var web UI                                | Dashboard   | CLI (`.dev.vars` + `env push`)            | Minor                            |
| Turn-key observability (Datadog/Axiom/Sentry) | Log streams | Pluggable webhook / Sentry-callback sinks | Minor — bring-your-own-endpoint  |

---

## At or above parity (no action needed)

Confirmed present and complete in source:

- **Database/query**: `ctx.db.query().withIndex().filter().order().take()`,
  `.first()`/`.unique()`/`.collect()`/`get(id)` (`packages/do/src/ctx-db.ts`).
- **Cursor pagination**: `.paginate({cursor, numItems})` → `page` /
  `continueCursor` / `isDone`, keyset-based, plus an `endCursor` bounded-range
  extension (`packages/do/src/query-args.ts`).
- **Full-text search**: `.searchIndex()` / `.withSearchIndex()` over FTS5 with a
  JS fallback scorer (`packages/do/src/search-text.ts`).
- **Vector search**: `.vectorize()` + `ctx.vectors.query()`, Cloudflare Vectorize,
  bring-your-own-embedder (`packages/vectors/`).
- **Indexes**: compound + unique + JSON-expression indexes.
- **Schema-validated writes**: validators run on insert/patch/replace with
  `.check()` refinements (`packages/values/`, `packages/do/src/relations.ts`).
- **Relations**: one/many, nested `with` loading (batched, no N+1), `onDelete`
  cascade/restrict/set-null, `_count`, cross-shard.
- **System fields**: `_id`, `_creationTime`.
- **Functions**: query/mutation/action + internal variants
  (`packages/server/src/functions.ts`).
- **HTTP**: `httpAction` + Hono-based `httpRouter()` with typed routes, validator
  coercion, `.output()` (`packages/server/src/http.ts`) — exceeds Convex `http.ts`.
- **Streaming**: SSE via `.stream()` on routes and queries.
- **Scheduling**: `runAfter`/`runAt`, cron triggers, `_scheduled_functions`
  system table, retry policy, workpool, DLQ (`packages/scheduler/`).
- **Middleware/plugins**: builder `.use()` + `definePlugin` /
  `composePluginMiddleware` (more compositional than Convex `customQuery`).
- **Validators**: `@cirrus/values` + JSON-Schema export.
- **Import/export**: streaming NDJSON with backpressure (`cirrus export/import`).
- **Backup/PITR**: 30-day native point-in-time recovery via DO change log +
  portable R2 backups (`cirrus backup`).
- **Streaming export**: Fivetran + Airbyte CDC connectors
  (`packages/runtime/src/connector-*.ts`).
- **Auth**: better-auth wrapper — email/password, OAuth, magic link, OTP,
  passkeys, 2FA, organizations, admin/impersonation, anonymous, SIWE, JWT/bearer,
  OIDC provider (`packages/auth/`).
- **Migrations**: dual-tier — SQL schema (D1 `.global()`) + resumable per-shard
  data transforms (`defineMigration`).
- **Presence**: TTL-filtered registry module + `usePresence` hook.
- **Studio**: data browser (opt-in edit), function runner, logs, schema diagram,
  advisors, API reference + try-it, auth/storage/payments panels, SQL editor.
- **CTX surface**: db / auth / storage / vectors / scheduler / runQuery /
  runMutation / runAction / log / fetch / `db.system`.

---

## Recommended next steps

1. Draft an implementation plan for `@cirrus/workflow` wrapping Cloudflare
   Workflows (builder + codegen `WorkflowEntrypoint` + `ctx.workflows` + Studio
   panel + `[[workflows]]` binding via `@cirrus/config`).
2. Scope an aggregate index component (balanced-tree counts/sums).
3. Decide whether the component-isolation model is worth the complexity vs the
   current plugin/registry approach.
4. Quick wins: add `_updatedTime` system field; document the manual-OCC pattern
   or add an opt-in `_version` column.

## Sources (Cloudflare Workflows)

- https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/
- https://www.cloudflare.com/products/workflows/
- https://blog.cloudflare.com/building-workflows-durable-execution-on-workers/
- https://developers.cloudflare.com/agents/api-reference/durable-execution/
