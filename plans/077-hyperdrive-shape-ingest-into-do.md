# Plan 077: Hyperdrive → per-agent DO shape ingest (external source materialization)

> **Executor instructions**: This is a **design spike + phased rollout**, not a
> single surgical change. Phase 0 is a written design doc the maintainer signs
> off on BEFORE any code lands. Each later phase is independently shippable and
> gated on the phase before it. Do NOT start Phase 1 until Phase 0's open
> questions (§ Decisions) have answers. When a phase ships, update the status row
> in `plans/README.md`.
>
> **Drift check (run first)**: confirm the "Current state" excerpts still match
> live code at HEAD:
> `git diff --stat HEAD -- packages/do/src/ctx-db-cdc.ts packages/do/src/shard-do.ts packages/do/src/ctx-db-global-shape-snapshot.ts packages/hyperdrive/src packages/server/src/shapes.ts`
> On a mismatch, re-read the cited symbols before trusting this plan.

## Status

- **Priority**: P2 (requested use case: multitenant Hyperdrive Postgres as the
  source of truth, per-agent DOs that materialize their own slice, clients
  consuming the same slice). Not P1 because the manual `ctx.sql` → `ctx.db`
  projection bridge already unblocks the use case today (see "Current state").
- **Effort**: XL (multi-phase; each phase is M). Phase 3 (real CDC) is L–XL on
  its own and may be split out.
- **Risk**: HIGH — touches the ingest boundary (external, non-deterministic data
  entering the deterministic DO write path), the RLS boundary, and the
  shape/poll transport. The three places Lunora cannot afford a regression.
- **Depends on**: nothing hard-blocking. Phase 3 (CDC) benefits from but does not
  require plan 072's shared op-range work.
- **Category**: architecture / data-ingest
- **Planned at**: commit `HEAD` (alpha), 2026-06-30
- **Origin**: external question (Mats Erdkamp): "multitenant DB (Hyperdrive), but
  multiple agents on DOs who should only have access to their own SQLite table —
  is it possible to sync shapes into those? Cherry on top: clients consuming the
  same shapes." The client-consuming-shapes half is already shipped (`defineShape`
    - `@lunora/db`); the missing half is **getting the external Postgres slice into
      the per-agent DO's SQLite in the first place**, and (stretch) a DO consuming
      another DO's shape.

## Why this matters

Lunora today has a clean answer for **DO SQLite → client** live replication
(`defineShape`: RLS-filtered, column-projected, op-log-poked partitions consumed
by TanStack DB). It has **no** first-class answer for the **upstream** edge:
**external Postgres → DO SQLite**. The only bridge is manual and unsupported as a
pattern:

1. Read the tenant slice in an **action** via `ctx.sql` (action-only,
   non-reactive, request/response).
2. Write the rows into the DO's own (sharded) SQLite via `ctx.db`.
3. From there, `defineShape` + `@lunora/db` give clients the live slice for free.

That works but is a hand-rolled pull with no declared cadence, no resume, no
membership diffing, no tenant-scoping guard, and no Studio visibility. The use
case ("each agent syncs its own slice of a multitenant Postgres, clients ride the
same slice") is common enough — RAG agents, per-tenant caches, edge-local working
sets — to deserve a declarative primitive.

### The alignment that makes Phase 1–2 tractable

Lunora **already polls an external source into a per-socket-diffed shape**: that
is exactly what `.global()`-table shapes do. `.global()` tables live in D1 /
Hyperdrive, not in the DO's CDC op-log, so they cannot use the live poke path.
Instead the DO runs a **latency-tiered alarm poll** that re-reads membership from
the external backend and diffs it against a durable per-socket snapshot that
survives hibernation. The "external read → diff vs durable snapshot → poke"
machine we need for Postgres-ingest is structurally the same machine — we point
it at a Hyperdrive query and land the result in a **real local SQLite table**
instead of (or in addition to) re-broadcasting it.

## Current state

- **`ctx.sql` is action-only, non-reactive, request/response.**
  `packages/hyperdrive/src/index.ts:7-8` ("`ActionCtx` only. External SQL is
  non-deterministic (action-only) and non-reactive"). `SqlClient.query<Row>(text,
params)` is the only method (`packages/hyperdrive/src/types.ts:74-83`). No CDC,
  no streaming, no shapes — explicit non-goal (README: "No logical-replication /
  CDC ingestion of external Postgres into Lunora tables … out of scope").
  Multitenancy is the user's WHERE clause; one connection string per binding.

- **A CDC replay-into-a-writer primitive already exists.**
  `packages/do/src/ctx-db-cdc.ts` — `applyCdcChange(writer, change)` (≈219) and
  `applyCdcChanges(writer, changes)` (≈256) replay an ordered change list through
  the **validated** `DatabaseWriterLike`, preserving per-row order. Today it
  backs PITR + streaming export. This is the "land external changes into SQLite
  through the trusted writer" primitive an ingest feature reuses — `CdcChange` is
  the canonical shape of an applied upsert/delete.

- **The latency-tiered alarm poll is the architectural template.**
  `packages/do/src/shard-do.ts` — `.global()` shapes seed via `seedGlobalShape`
  (≈6414) and refresh via `refreshGlobalShape` (≈6459) on a DO alarm
  (`ShardDO.alarm`, ≈2368; `scheduleGlobalPoll`/`setAlarm`, type at ≈181-186).
  The durable per-socket baseline lives in `__global_shape_snapshot`
  (`packages/do/src/ctx-db-global-shape-snapshot.ts`) so the diff survives
  hibernation. Diff logic: `packages/do/src/shape-global-diff.ts`
  (`diffGlobalMembership`, `buildPokeFrames`, `projectColumns`). **This is the
  loop to generalize**: source = Hyperdrive query instead of D1; sink = a real
  local table (not just a re-broadcast).

- **Per-shard SQLite isolation is structural.** `.shardBy(key)` →
  `resolveShard(namespace, shardKey)` (`packages/runtime/src/resolve-shard.ts:65-73`)
  → one DO per key, each with a private `state.storage.sql`. An agent only sees
  its own table by construction (no cross-shard SQLite API). The shard key is the
  natural **tenant scope** for an ingest predicate.

- **`defineShape` already does DO SQLite → client.**
  `packages/server/src/shapes.ts` — `defineShape({ table, where(ctx,args),
columns?, args? })` (≈81), RLS-AND-composed, op-log-poked, consumed by
  `@lunora/db`. Once external rows land in a tracked DO table, this half is free
  and unchanged.

- **Migrations provision the full non-global schema per shard.**
  `runShardMigrations` (`packages/do/src/ctx-db-migrations.ts:166-208`) creates
  every non-`.global()` table as `(id, _creationTime, __doc__)` in each shard's
  SQLite. An ingest target table is just a `defineSchema` table flagged as
  externally-sourced — no new storage shape needed.

- **No DO-consumes-another-DO's-shape primitive.** Shapes terminate at the client
  over WS. There is no transport for one DO to subscribe to another DO's shape and
  materialize it locally (the relay work in plan 075 is owner→relay broadcast, not
  DO-side materialization). This is the Phase 4 stretch.

## Scope

**In scope (phased)**:

- A new **external-source table declaration** in `@lunora/server` schema builder
  (working name `.source(...)` / `defineExternalSource`) — marks a `defineSchema`
  table as materialized-from-Hyperdrive, carrying: the source query template, the
  tenant-scope binding (shard-key → predicate param), the refresh cadence, and the
  primary-key mapping (external row id → `_id`).
- `@lunora/hyperdrive` — a **read-side ingest adapter** (reuse `SqlClient`): a
  paged, parameterized pull the DO can call from inside the alarm/poll loop
  (not an action — a controlled, system-driven read, see Decision 2).
- `packages/do/src` — generalize the global-shape latency-tiered poll into an
  **external-source materialization loop**: poll Hyperdrive → diff vs durable
  snapshot → apply upserts/deletes through `applyCdcChanges` into the local table.
- `@lunora/codegen` — discover external-source tables, wire the ingest config onto
  the DO, emit the tenant-scope typing.
- `@lunora/advisor` — lints (unscoped ingest = full-table leak across tenants;
  missing PK mapping; non-indexed source predicate).
- Studio surface — show ingest freshness / last-poll / row counts per shard.

**Out of scope (unless explicitly promoted)**:

- **Real logical-replication / WAL CDC** from Postgres as the _default_ path. Poll
  is v1. True CDC is Phase 3 and is itself gated/optional (needs an external slot
  consumer or trigger→queue producer; see Decision 5). Do not make core depend on
  a replication slot.
- Writing _back_ from the DO to Postgres (this plan is read/ingest only; writes
  stay the user's `ctx.sql` action concern).
- Changing `ctx.sql`'s action-only contract. The ingest loop is a separate,
  system-owned read path — it does **not** loosen `ctx.sql` into queries/mutations.
- `.global()` semantics, `shardBy` routing, the relay tier (plan 075) — orthogonal.

## Decisions (Phase 0 — answer before any code)

1. **Declaration surface.** Is external-source a table-builder modifier
   (`defineTable({...}).source({ binding, query, tenantBy, refresh })`) or a
   standalone `defineExternalSource` registry like `defineShape`? Proposal:
   **table-builder modifier** — the materialized rows ARE a schema table (clients
   shape over it), so it belongs on the table, parallel to `.shardBy()`/`.global()`.
   Confirm it composes with `.shardBy()` (it must: per-agent tenant scoping is the
   whole point) and is mutually exclusive with `.global()`.

2. **Who runs the pull, and under what determinism contract.** The ingest read is
   external + non-deterministic, which is _why_ `ctx.sql` is action-only. But the
   materialization must be **system-driven** (alarm/poll), not user-invoked per
   request. Proposal: the DO's poll loop owns the read via an internal
   Hyperdrive client (same `SqlClient`), and the **only** thing that enters the
   deterministic write path is the already-materialized `applyCdcChanges` apply —
   identical to how the global-shape alarm already reads D1 outside any
   query/mutation. Pin: does the poll run on the existing single DO alarm (shared
   with global-shape poll) or a dedicated cadence? One alarm, multiplexed.

3. **Tenant scoping = correctness boundary.** The shard key must bind into the
   source predicate so DO `tenant-A` can only ever pull tenant-A's rows. Proposal:
   `tenantBy: (shardKey) => params` is **mandatory** when the table is `.shardBy()`
    - sourced; an unscoped sourced+sharded table is a STOP condition (every agent
      would replicate the whole multitenant table — the exact leak the use case is
      trying to avoid). Advisor lint enforces it statically.

4. **Cadence & freshness.** Poll interval per source table (latency tiers like the
   global-shape poll already has)? On-demand "pull now" trigger (e.g. before an
   agent run)? TTL/staleness bound surfaced to clients? Proposal: a declared
   `refresh: { everyMs } | "manual"`, plus a system action/RPC to force a pull;
   reuse the global-shape latency-tier ladder. Measure poll cost before picking a
   default floor.

5. **Phase 3 CDC source.** If/when we do live (not polled) ingest, what produces
   the change stream? Options: (a) Postgres logical replication slot consumed by a
   sidecar that pushes to a Lunora ingest RPC; (b) Postgres triggers →
   `@lunora/queue` → per-tenant fan-out; (c) Hyperdrive does not expose WAL, so
   never in-DO. Proposal: **(b) trigger→queue** as the first live path (no slot
   infra, tenant-routable), (a) as an advanced opt-in. Decide whether Phase 3 is
   in this plan or spun out to its own.

6. **DO-consumes-DO shape (Phase 4 stretch).** Is "agent DO materializes another
   DO's `defineShape` into its local SQLite" in this plan or separate? Proposal:
   **separate follow-up** — it shares the `applyCdcChanges` sink but needs a
   DO↔DO subscription transport that does not exist; keep this plan
   Hyperdrive-focused and note the seam.

## Phases

### Phase 0 — Design doc + sign-off (no code)

Write the external-source declaration grammar, the poll/materialize state machine
(generalizing the global-shape alarm loop), the tenant-scope binding + its
enforcement, the resume/snapshot model, and answers to all six Decisions into this
file (or a sibling design doc). **Maintainer sign-off required before Phase 1.**
Deliverable: a measured poll cost on `ShardDO` (rows pulled vs per-tick CPU/IO),
not a guessed cadence floor.

**Status: SIGNED OFF (2026-06-30); Phases 0–1 landed.** The design + Decision
answers live in the sibling [077-phase0-design.md](077-phase0-design.md) (§11
checklist all approved). The measured gate is **closed**:
`packages/do/__bench__/external-source-{materialize-tick,apply}.bench.ts`
(lint/types/run green); results + the derived **~10k full-pull row cap** and
**size-scaled cadence** are in §9. Phase 2 (`.source()` modifier + codegen + poll
loop) may now proceed on the signed-off answers.

### Phase 1 — Manual bridge, documented + hardened (ship first, lowest risk)

Make the **existing** `ctx.sql` (action) → `ctx.db` projection a blessed,
documented pattern with a helper, so the use case is fully unblocked while the
declarative path is built. Ship: a `@lunora/hyperdrive` helper that pages a
tenant-scoped query and upserts via the writer (thin wrapper over
`applyCdcChanges`), a docs recipe ("materialize a Postgres slice into a per-agent
DO, then `defineShape` it to clients"), and a `@lunora/scheduler` cron example for
periodic refresh.

**Verify**: example app pulls a tenant slice into a sharded DO table, a client
`subscribeShape`s it live; `pnpm --filter "@lunora/hyperdrive" run test` +
`@lunora/do` tests green; no public-API change beyond the new helper export.

**Status: LANDED.** Read side `pullSourceRows` / `projectSourceRow` in
`@lunora/hyperdrive` (`src/source.ts`, 7-case test green); write side
`materializeExternalRows` + `diffExternalSource` exported from `@lunora/do`
(round-trip integration test green); docs recipe "Per-agent shape ingest" in
`packages/hyperdrive/docs/index.mdx`. Empty-baseline call = upsert-only; full-pull
deletes come with the Phase 2 poll loop. No public-API change beyond the new
exports.

### Phase 2 — Declarative polled external-source table (the core deliverable)

Land the `.source({ binding, query, tenantBy, refresh })` table modifier +
codegen wiring + the generalized poll/materialize loop in the DO (read Hyperdrive
→ diff vs durable `__external_source_snapshot` → `applyCdcChanges` into the local
table). Tenant scoping mandatory under `.shardBy()`. Clients shape over the
materialized table with **zero** new client code — it is an ordinary table to them.

**Status: IN PROGRESS — all logic landed; only codegen emission remains.**

- **Builder LANDED** — `.source()` on `@lunora/server`'s `TableBuilder`
  (`ExternalSourceDefinition` type, `externalSource` on `TableDefinition`, implies
  `.externallyManaged()`, composes with `.shardBy()`; 6-case test).
- **Codegen IR + advisor lints LANDED** — `discover-schema` captures `.source()` into
  `TableIR.externalSource` (threaded through both advisor feeders); the two signed-off
  hard-error lints `external_source_unscoped` + `external_source_on_global` ship
  (5-case suite). No golden-fixture change (nothing emits it yet).
- **Materialize core LANDED** — `diffExternalSource` (canonical `stableStringify` +
  `_creationTime`-stripping projection), `materializeExternalRows`,
  `readExternalSourceBaseline`, `runExternalSourceTick` in `@lunora/do` (+ benchmarks);
  steady-tick canonicalization proven.
- **DO alarm seam LANDED** — `ShardDO.alarm()` drives `pollExternalSources()` (base
  no-op → zero regression) alongside the global-shape poll; `scheduleSourcePoll()`
  arms the shared alarm. Subclass-driven test proves alarm → tick → materialize +
  re-arm; global-shape + shard-do suites green.
- **Codegen emission LANDED** — `emit.ts` generates the DO subclass's
  `pollExternalSources` override (per sourced table: system `createShardCtxDb` writer,
  Hyperdrive query via `tenantBy(this.currentShardKey())`, project, `runExternalSourceTick`),
  a constructor that arms the alarm (`scheduleSourcePoll`), a per-binding client memo,
  and the `sourceClient?: (env, binding) => SqlClient` config seam. All gated on
  `hasSourcedTables`, so a non-sourced `shard.ts` is byte-identical (481 codegen tests
  confirm). Focused emit test + the runtime alarm test cover it.

**Phase 2 is COMPLETE.** `.source()` → codegen → DO poll loop → materialize →
`defineShape` → clients works end-to-end. Open follow-ups (non-blocking): per-source
cadence (`refresh.everyMs` honored vs every-tick), `"manual"`-mode pull RPC, Studio
freshness surface, and the incremental-mode delete-visibility lint (§3.3) — all
deferred refinements, not gates.

**Verify**: a sourced+sharded table on agent DO `tenant-A` only ever contains
tenant-A rows (explicit cross-tenant isolation test); membership diff applies
upserts AND deletes correctly; the slice live-pokes to a `defineShape` client as
the poll advances; freshness visible in Studio. Reuse the global-shape resume/diff
tests as the oracle for the diff engine.

### Phase 3 — Live CDC ingest (optional, gated; may spin out)

Per Decision 5: a trigger→`@lunora/queue` producer (or replication-slot sidecar)
pushes per-tenant change frames to a Lunora ingest RPC that routes each frame to
the owning shard DO and `applyCdcChanges` it. Replaces polling with live updates
for sources that opt in. Hard-gated; the polled path (Phase 2) stays the default.

**Verify**: an external Postgres write to tenant-A's row appears in agent DO
tenant-A's SQLite (and its shape clients) without a poll; tenant-B is untouched;
the deterministic write path is never entered by raw external data (only via
`applyCdcChanges`).

### Phase 4 — DO-consumes-DO shape (stretch; likely a separate plan)

A primitive for one DO to subscribe to another DO's `defineShape` and materialize
it locally via the same `applyCdcChanges` sink, over a new internal DO↔DO
transport. Scoped out here; the seam (shared sink, missing transport) is noted so
Phase 2's snapshot/diff code is written to be transport-agnostic.

## Commands you will need

| Purpose          | Command                                                           | Expected on success           |
| ---------------- | ----------------------------------------------------------------- | ----------------------------- |
| Build deps first | `pnpm run build:packages`                                         | exit 0 (run once)             |
| Hyperdrive tests | `pnpm --filter "@lunora/hyperdrive" run test`                     | all pass                      |
| DO tests         | `pnpm --filter "@lunora/do" run test`                             | all pass                      |
| Codegen golden   | `pnpm --filter "@lunora/codegen" run test`                        | golden fixtures updated+green |
| Typecheck        | `pnpm --filter "@lunora/do..." run lint:types`                    | exit 0                        |
| Lint             | `pnpm run lint:eslint`                                            | exit 0                        |
| workerd e2e      | `LUNORA_WORKERD_TESTS=1 pnpm --filter "@lunora/runtime" run test` | ingest e2e passes             |

## Git workflow

- Branch per phase: `advisor/077-hyperdrive-ingest-phaseN`.
- Commit style: `feat(hyperdrive): …` / `feat(do): …` / `feat(server): …` per phase.
- Do NOT push or open a PR unless instructed. Phase 0 lands as docs only.

## Done criteria (per phase; ALL must hold)

- [ ] No loosening of `ctx.sql`'s action-only contract (`git diff` over
      `packages/codegen/src/emit.ts` ctx wiring shows `ctx.sql` still ActionCtx-only).
- [ ] `pnpm --filter "@lunora/do..." run lint:types` exits 0.
- [ ] `pnpm --filter "@lunora/do" run test` + `@lunora/hyperdrive` tests exit 0.
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] Phase 2+ only: an explicit cross-tenant isolation test proves a
      sourced+sharded table on shard `A` never contains shard `B`'s rows.
- [ ] Phase 2+ only: codegen golden fixtures regenerated and committed.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- A sourced + `.shardBy()` table has no mandatory `tenantBy` scope — this would
  replicate the whole multitenant table into every agent DO (the exact leak the
  use case avoids). Tenant scoping is non-negotiable; do not ship without it.
- Materialization requires entering the deterministic query/mutation write path
  with raw external rows — it must only enter via `applyCdcChanges` from the
  system poll/ingest loop, never via a user query/mutation reading `ctx.sql`.
- The poll cost (Phase 0 measurement) makes the default cadence untenable for the
  expected slice sizes — re-scope to manual/on-demand pull before automating.
- Phase 3 appears to require Cloudflare Hyperdrive to expose the Postgres WAL — it
  does not; route via trigger→queue or a sidecar, not in-DO log tailing.
- Resume/diff against the durable snapshot diverges from the global-shape oracle —
  do not ship a materialization that can drop or duplicate a row across a poll.

## Maintenance notes

- **Tenant scoping is the correctness boundary.** The shard key MUST bind into the
  source predicate. Per-agent isolation is structural for SQLite but NOT for what
  the ingest query pulls — an unscoped pull defeats the entire point.
- **External data enters only through `applyCdcChanges`.** That is the single,
  validated chokepoint where non-deterministic upstream rows become tracked DO
  state. Never let raw `ctx.sql` rows reach a query/mutation handler — that is why
  `ctx.sql` stays action-only and the ingest loop is system-owned.
- **Generalize the global-shape poll, don't fork it.** `seedGlobalShape` /
  `refreshGlobalShape` + `__global_shape_snapshot` + `shape-global-diff.ts` are
  the proven external-read→diff→poke loop. The ingest loop is the same machine
  with a Hyperdrive source and a local-table sink; share the diff/snapshot code so
  resume correctness is proven once.
- **The client half is already done.** Once rows land in a tracked table,
  `defineShape` + `@lunora/db` deliver them live with zero new client code. Keep
  the materialized table an ordinary schema table so this stays free.
- **Poll is the default; CDC is opt-in.** Most slices tolerate a polled refresh.
  Do not make the core path depend on replication-slot infrastructure — that is an
  advanced, gated upgrade, not the baseline.
- **Visible, not silent.** Surface ingest freshness/last-poll/row-count in Studio.
  A stale or failing pull must be observable, not a silently empty agent table.
