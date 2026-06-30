# Plan 077 — Phase 0 design doc: Hyperdrive → per-agent DO shape ingest

> Sibling design doc for [077-hyperdrive-shape-ingest-into-do.md](077-hyperdrive-shape-ingest-into-do.md).
> This is the Phase 0 deliverable: the declaration grammar, the materialize state
> machine (generalizing the `.global()`-shape poll loop), the tenant-scope binding
>
> - enforcement, the resume/snapshot model, the failure/observability model, and
>   answers to the six Decisions. **Maintainer sign-off on this doc gates Phase 1
>   code.** All code excerpts below are anchored to HEAD; re-run the plan's drift
>   check before trusting them.

## 0. One-paragraph thesis

The expensive, correctness-critical half of "sync a Postgres slice into a per-agent
DO" already exists in Lunora as the `.global()`-shape **latency-tiered poll loop**:
read an external store → diff against a durable baseline → emit only the delta. We
generalize that loop. The source becomes a tenant-scoped Hyperdrive query (instead
of D1); the sink becomes a **real local SQLite table** materialized through the
existing validated `applyCdcChanges` writer (instead of a per-socket client poke).
Once rows land in that ordinary tracked table, `defineShape` + `@lunora/db` carry
them to clients live with **zero new client code** — the "cherry on top" is already
built. The only genuinely new surfaces are: a `.source()` table modifier, a
codegen-wired Hyperdrive read hook, and a tenant-scope guard.

## 1. The two structural facts that shape the design

**Fact A — the local table IS the diff baseline.** The `.global()`-shape path keeps
a per-socket `__global_shape_snapshot` because it has **no local copy** of the data
to diff against (`ctx-db-global-shape-snapshot.ts:6-14` documents exactly this:
the snapshot exists only because there is nothing else to compare to, and a
hibernation eviction that cleared the in-memory baseline produced phantom rows). The
ingest path is different in kind: it **materializes a real table**, so the table's
current rows are themselves the durable baseline. We diff freshly-pulled membership
against the current local table — **no new snapshot table is needed** for the
full-pull mode. That removes the entire phantom-row failure class the global-shape
path had to engineer around.

**Fact B — `applyCdcChanges` is the single legitimate ingress.** External rows are
non-deterministic; that is precisely why `ctx.sql` is action-only/non-reactive
(`packages/hyperdrive/src/index.ts:7-8`). The materialize loop must therefore land
external rows **only** through `applyCdcChanges(writer, changes)`
(`ctx-db-cdc.ts:256`), which routes every upsert/delete through the validated
`DatabaseWriterLike` (insert-with-explicit-id → fallback replace; delete). That keeps
the deterministic query/mutation handlers from ever touching raw external data —
they only ever read the already-materialized local table — and reuses the writer's
index/companion/CDC-append maintenance for free (so the materialized rows are
_themselves_ shapeable, because the write path appends to `__cdc_log` like any other).

## 2. Declaration grammar — `.source()` table modifier

`.source()` is a **table-builder modifier**, parallel to `.shardBy()`/`.global()` but
recorded **separately** (it is orthogonal to shard mode — a sourced table almost
always _also_ `.shardBy()`s). It composes like `softDelete`/`isPublic`, not like the
mutually-exclusive `shardMode` set.

```ts
// lunora/schema.ts
export default defineSchema({
    documents: defineTable({
        title: v.string(),
        body: v.string(),
        orgId: v.string(),
    })
        .shardBy("orgId") // one DO per tenant (the agent)
        .source({
            binding: "HYPERDRIVE_DOCS", // wrangler Hyperdrive binding name
            // The full tenant membership query. `$1…$n` bind from `tenantBy`.
            query: 'SELECT id, title, body, org_id AS "orgId", updated_at FROM documents WHERE org_id = $1',
            // MANDATORY under .shardBy(): maps this DO's shard key → bound params.
            // This is the tenant-isolation boundary (see §4).
            tenantBy: (shardKey) => [shardKey],
            // External PK → Lunora `_id`. Defaults to the `id` column.
            idColumn: "id",
            // How the pulled row maps to the doc. Default: identity over selected
            // columns minus idColumn (which becomes `_id`).
            map: (row) => ({ title: row.title, body: row.body, orgId: row.orgId }),
            refresh: { everyMs: 5_000 } /* | "manual" */,
            // delete-detection strategy — see §3.3. Default "full-pull".
            mode: "full-pull" /* | "incremental" */,
        }),
});
```

### 2.1 Builder integration (exact)

`packages/server/src/schema.ts` `defineTable` records orthogonal flags as locals
(`shardMode`, `isExternallyManaged`, `isPublic`, `softDelete` at :227-230). Add:

```ts
let externalSource: ExternalSourceDefinition | undefined;
// …
source(definition) {
  externalSource = definition;
  isExternallyManaged = true;   // implied — see §2.2
  return builder;
},
get externalSource() { return externalSource; },
```

`.source()` does **not** touch `shardMode`, so `.shardBy("orgId").source({…})`
records both. Validation in the modifier:

- `binding` and `query` non-empty (throw like the other builder guards do).
- If `shardMode.kind === "shardBy"` then `tenantBy` is **required** (throw —
  unscoped + sharded is the cross-tenant leak; §4). If `shardMode.kind === "root"`
  (single-DO app), `tenantBy` is optional (one global slice).
- `shardMode.kind === "global"` + `.source()` is a **hard error** — a `.global()`
  table already lives in the external store; sourcing it into a DO is contradictory.

### 2.2 Relationship to `.externallyManaged()`

`.externallyManaged()` already means "rows are written outside Lunora's discoverable
insert path, so advisor insert-path lints skip the table" (`ir.ts:115-122`). A
sourced table is exactly that — written by the ingest loop, never by a user
mutation. So `.source()` **implies** `externallyManaged: true` in the IR (set it in
the builder, §2.1). The two are compatible; `.source()` is the strict specialization
("externally managed, _and here is how Lunora pulls it_").

### 2.3 Type & IR surface

- `ExternalSourceDefinition` type in `@lunora/server` (alongside `ShapeDefinition`).
- `TableIR` gains `externalSource?: ExternalSourceIR` (binding, query, idColumn,
  refreshMs | "manual", mode, and a **stable serialization of `tenantBy`/`map`** —
  these are functions, so codegen captures them the way it captures shape
  `where`/`columns`: discovered from source, emitted onto the DO subclass, _not_
  shipped to the client).
- Codegen discovery: a `discover-external-sources.ts` pass (mirrors
  `discover-shapes.ts`) lifts the config into a `LUNORA_EXTERNAL_SOURCES` registry
  and overrides the DO read hook (§3.2).

## 3. The materialize state machine

### 3.1 Where it runs — one alarm, multiplexed

Reuse the existing single DO alarm. Today `ShardDO.alarm` (`shard-do.ts:2368`) drives
`scheduleGlobalPoll` (`:6575`, idempotent arm, `GLOBAL_SHAPE_POLL_INTERVAL_MS = 2000`
at :1485). Add an **ingest poll** multiplexed onto the same alarm tick:
`scheduleIngestPoll()` arms the alarm when a sourced table exists in the shard and
`refresh` is not `"manual"`; the alarm handler runs both the global-shape refresh and
the ingest refresh. Per-source cadence is honored by storing each source's
`nextDueAt` and skipping sources not yet due (a source with `everyMs: 60_000` runs
every 30th 2 s tick; the floor stays the alarm granularity). `"manual"` sources never
arm — they pull only on the explicit trigger (§5).

### 3.2 The read hook — codegen subclass override (mirrors `readGlobalShapeRows`)

`readGlobalShapeRows` (`shard-do.ts:3809`) is a `protected` base hook returning `[]`,
overridden by the codegen subclass to drain the global backend under the socket's
verified identity. Add the exact analog:

```ts
/** Pull the full (or incremental) tenant membership for a sourced table from
 *  Hyperdrive. Base returns []; the codegen subclass overrides it to call the
 *  declared binding's SqlClient with tenantBy(shardKey) params. */
protected readExternalSourceRows(
  _source: ResolvedExternalSource,
  _shardKey: string,
  _sinceCursor?: string,    // incremental mode only
): Promise<ExternalRow[]> {
  return Promise.resolve([]);
}
```

The override constructs the `SqlClient` from the declared binding (the user already
owns the driver per `@lunora/hyperdrive`; codegen wires `createHyperdrive(env[binding])`

- the user-selected adapter, the same way `globalDb` is wired) and runs
  `query(source.query, source.tenantBy(shardKey))`. **The read is system-owned** — it
  runs inside the alarm tick, not inside a user query/mutation — so it does not loosen
  `ctx.sql`'s action-only contract (Decision 2). `ExternalRow` is `Record<string,
unknown>`; the loop applies `source.map` + `source.idColumn` to produce `{ _id, …doc }`.

### 3.3 Diff → writer ops — the two modes (Decision-grade)

The membership read must become an ordered `CdcChange[]` fed to `applyCdcChanges`.
There are two pull modes with a genuine correctness trade-off:

**`full-pull` (default — sees deletes).** Pull the _entire_ tenant membership each
tick. Diff against the current local table: a present-locally-but-absent-upstream row
is a **delete**; a new/changed row is an **upsert**. This is the only mode that can
observe upstream deletes (a deleted Postgres row simply stops appearing) — the exact
property the global-shape snapshot doc calls out (`ctx-db-global-shape-snapshot.ts:9-14`).
Cost: O(membership) read + diff each tick, so it is bounded to slices under a cap
(reuse the `GLOBAL_SHAPE_MAX_ROWS` guard pattern, `shard-do.ts:6427`,
`withinGlobalShapeBound`). Diff baseline = current local rows (Fact A), compared by
`(_id, content-hash)`; **no per-socket snapshot table**.

**`incremental` (cheap — cannot see deletes alone).** Pull only rows changed since a
stored per-source cursor (`WHERE updated_at > $cursor`). Applies upserts only; it is
**blind to deletes** by construction. Allowed ONLY when the source provides
delete-visibility: either soft-deletes surfaced as a column the `map` turns into a
local delete, OR a declared periodic **full reconcile** (`reconcileEveryMs`) that runs
a full-pull diff on a slower cadence to garbage-collect tombstones. An `incremental`
source with neither is a STOP condition (silent phantom rows). The cursor is stored in
a tiny `__external_source_cursor(table, cursor TEXT)` table (one row per sourced table;
far smaller than the global-shape snapshot since there is one tenant per DO).

The diff→`CdcChange[]` mapping is a small pure helper — **already landed**:
`packages/do/src/external-source-diff.ts` (`diffExternalSource`, unit-tested in
`__tests__/external-source-diff.test.ts`, 6 cases green; the materialize-tick
benchmark calls it so the two never drift). Given pulled rows + the current local
baseline (`id → projected JSON`), it emits `{op:"insert"|"update", table, id, doc}` /
`{op:"delete", table, id}` in a deterministic order plus the next baseline, ready for
`await applyCdcChanges(writer, changes)`. It is the writer-side mirror of
`diffGlobalMembership` and reuses its `projectColumns` so the column-projection logic
exists once. Because `applyCdcChanges` runs through the real writer, the materialized
rows get indexes, companions, **and a `__cdc_log` append** — so they are immediately
live-pokeable to `defineShape` subscribers with no extra work. (The pure diff is the
only Phase-2 surface built ahead of sign-off: it has no public API, schema, or codegen
footprint — the `.source()` modifier + codegen wiring still await maintainer sign-off.)

### 3.4 Atomicity & ordering

Run the per-tick apply inside the DO's storage transaction (the same boundary
mutations use), so a tick is all-or-nothing: a partway failure leaves the prior
materialized state and the cursor un-advanced, and the next tick retries from the same
point. Advance the incremental cursor **only after** the apply commits (mirror the
global-shape "advance baseline only after the poke lands" discipline, `shard-do.ts:6437-6445`).

## 4. Tenant scoping — the correctness boundary

Per-shard SQLite isolation is structural (`resolveShard`, `resolve-shard.ts:65-73` —
distinct shard key → distinct DO → private SQLite), but that only isolates _where rows
land_, **not what the ingest query pulls**. The query is the leak surface: an unscoped
`SELECT * FROM documents` on every agent DO would replicate the entire multitenant
table into each tenant. Therefore:

- `tenantBy(shardKey) → params` is **mandatory** for a sourced + `.shardBy()` table
  (§2.1 throws otherwise).
- The shard key is bound as a **parameter** (`$1…`), never string-interpolated, so it
  cannot break out of the predicate (same discipline as `readCdcChanges`' bound table
  filter, `ctx-db-cdc.ts:88-96`).
- **Advisor lint `external_source_unscoped`** (static): a `.source()` on a `.shardBy()`
  table whose `query` does not reference every `tenantBy` parameter, or whose
  `tenantBy` is absent, fails the build. Sibling lints: `external_source_on_global`
  (sourced `.global()` table), `external_source_missing_id` (no resolvable `_id`),
  `external_source_incremental_no_delete_path` (incremental mode without soft-delete or
  reconcile, §3.3).

## 5. Cadence, freshness, manual pull

- `refresh: { everyMs }` → polled on the multiplexed alarm (§3.1), floor = alarm
  granularity (2 s today). `refresh: "manual"` → never auto-polls.
- A system-driven **pull-now**: an internal RPC / admin action (`ingest.pull(table)`)
  that runs one materialize tick on demand — for "refresh this agent's working set
  before a run" without waiting for the interval. Routed to the shard DO like any
  other RPC.
- **Freshness is observable** (Decision 4): store `lastPolledAt` / `lastError` /
  `rowCount` per sourced table; surface in Studio (a sourced-table badge: last pull,
  staleness, row count, last error). A stale or failing pull must be visible, never a
  silently empty agent table.

## 6. Resume / epoch

The materialized table participates in the **existing** CDC epoch + cursor model
(`__cdc_meta`, `readCdcEpoch`/`bumpCdcEpoch`, `ctx-db-cdc.ts:167-210`) because
`applyCdcChanges` appends to `__cdc_log` like any write. So a `defineShape` client over
a sourced table resumes exactly as it does over any table — `(sinceSeq, sinceEpoch)`,
re-seed on fork. **The ingest path adds no new client-facing resume surface.** The only
ingest-internal resumable state is the incremental cursor (§3.3), which is server-local
and never shipped to clients.

## 7. Failure & observability model

- The poll is **best-effort, isolated** per source: one source's Hyperdrive read
  failing must not abort the others or the global-shape refresh sharing the tick. Reuse
  `recordShapeError` (`shard-do.ts:6603`) → the DO log ring, plus the per-source
  `lastError` (§5).
- Over-cap membership (full-pull): leave the prior materialized state, skip the tick,
  surface the cap error — mirror `refreshGlobalShape`'s over-cap handling
  (`shard-do.ts:6468-6472`). Never partially materialize a truncated pull.
- Hyperdrive unreachable: retain last-good materialized rows; the table is stale, not
  emptied. Clients keep their last shape state; Studio shows the staleness.

## 8. Answers to the six Decisions

1. **Declaration surface** → table-builder modifier `.source()`, recorded orthogonally
   to `shardMode`, composing with `.shardBy()`, hard-error with `.global()`, implying
   `externallyManaged` (§2). _Resolved._
2. **Who runs the pull / determinism** → the DO's alarm poll loop via a codegen-wired
   internal `SqlClient`; only `applyCdcChanges` enters the deterministic write path;
   `ctx.sql`'s action-only contract is untouched. One alarm, multiplexed with the
   global-shape poll (§3.1, §3.2). _Resolved._
3. **Tenant scoping** → mandatory `tenantBy` under `.shardBy()`, parameter-bound,
   enforced by `external_source_unscoped` advisor lint (§4). _Resolved — non-negotiable._
4. **Cadence & freshness** → `refresh: {everyMs} | "manual"` + a pull-now RPC + Studio
   freshness surface (§5). Default `everyMs` floor TBD by the Phase 0 benchmark (§9).
   _Resolved pending the measured floor._
5. **Phase 3 CDC source** → trigger→`@lunora/queue` per-tenant producer as the first
   live path; replication-slot sidecar as advanced opt-in; Hyperdrive never exposes the
   WAL in-DO. Recommend **spinning Phase 3 into its own plan** — it is L–XL and the
   polled path fully covers the use case. _Resolved (direction); split recommended._
6. **DO-consumes-DO shape** → **separate follow-up plan.** It shares the
   `applyCdcChanges` sink and the `external-source-diff` helper but needs a DO↔DO
   subscription transport that does not exist. Phase 2's diff/apply code is written
   transport-agnostic (read-hook + pure diff + writer sink) so that follow-up reuses it
   by swapping the read hook from "Hyperdrive query" to "peer-DO shape stream". _Resolved
   (deferred, seam preserved)._

## 9. Phase 0 measured gate — RESULTS

**Benchmark.** `packages/do/__bench__/external-source-materialize-tick.bench.ts`
(read + diff) and `external-source-apply.bench.ts` (apply), over the real
`createShardCtxDb` writer + a real SQLite engine (`node:sqlite`), the established
`__bench__` harness. These measure DO-isolate **CPU/IO**, which is what scales with
membership; the workerd/Miniflare wrapper would add fixed per-call overhead
irrelevant to the per-row scaling question, so the micro-bench is the right tool (the
CodSpeed-tracked numbers come from the committed `.bench.ts` files in CI). The
**Hyperdrive network read is excluded** by construction — it is an external
round-trip, not isolate CPU, and is measured separately against a real binding.

**Measured (single run, `node:sqlite`, 200 b document body; for cadence-sizing — CI
CodSpeed numbers are the tracked source of truth):**

| Membership  | pure diff (JS) | read + diff (full tick, no change) | apply (`applyCdcChanges`, cdc on) |
| ----------- | -------------- | ---------------------------------- | --------------------------------- |
| 10 rows     | ~3 µs          | ~18 µs                             | —                                 |
| 100 rows    | ~28 µs         | ~143 µs                            | —                                 |
| 1 000 rows  | ~0.29 ms       | ~1.4 ms                            | —                                 |
| 10 000 rows | ~3.6 ms        | ~20 ms                             | —                                 |
| (apply)     | —              | —                                  | **~16.8 µs/row** (~60k rows/s)    |

**Readings:**

- **The steady tick is read-dominated, not diff-dominated.** The pure JS diff is
  ~0.3 µs/row (linear); the full-scan + `JSON.parse` to rebuild the baseline is ~4–5×
  that. So the cost lever is the local re-read, not the comparison.
- **Full-pull is viable for bounded per-agent slices.** At ≤1k rows a no-op tick is
  ≤1.4 ms — negligible even at the 2 s alarm floor. At 10k rows a no-op tick is ~20 ms
  of CPU every 2 s ≈ ~1% of one isolate per subscribed source. At ~100k rows
  extrapolates to ~200 ms/tick — 10%+ of the 2 s budget _just to detect "nothing
  changed"_: the saturation zone.
- **Apply is cheap relative to the read.** ~17 µs/row including the `__cdc_log` append
  → a 10k-row first pull ≈ 170 ms; a 10%-churn tick on a 10k slice ≈ 20 ms (read+diff)
    - 17 ms (apply 1k rows) ≈ 37 ms. Comfortable under the 10k cap.

**Derived defaults (the gate's output):**

1. **Full-pull row cap ≈ 10 000** (reuse the `GLOBAL_SHAPE_MAX_ROWS` guard pattern,
   `shard-do.ts:6427`). Above it, `.source()` requires `mode: "incremental"` +
   `reconcileEveryMs` (the advisor lint `external_source_incremental_no_delete_path`
   enforces the delete-visibility companion, §3.3/§4).
2. **Default cadence scales with slice size**, not a single floor: poll at the 2 s
   alarm floor for slices ≲ 1k rows (cost is noise); default larger slices slower
   (e.g. 10 s) since re-scanning a mostly-static 10k slice every 2 s is wasted CPU.
3. **Future lever (Phase 2+, not blocking):** the read-dominance says the highest-value
   optimization is _skipping the full re-scan when unchanged_ — a cheap source-side
   change-token (`MAX(updated_at)` / a count+hash probe) gates the full pull, collapsing
   the steady-state tick to one tiny query. Note it; do not build it in Phase 1.

**Verdict:** full-pull clears the gate for the target use case (per-agent working
sets, bounded slices). The design ships full-pull as the default with a ~10k cap and
incremental mode above it — exactly as §3.3 anticipated, now with numbers behind the
cutoff rather than a guess.

## 10. What this design deliberately does NOT do

- Does **not** add a CDC/replication dependency to the core (Phase 3 only, gated).
- Does **not** write back to Postgres (ingest is read-only; writes stay the user's
  `ctx.sql` action concern).
- Does **not** add any client-facing API — clients `subscribeShape` an ordinary table.
- Does **not** loosen `ctx.sql` (still action-only; the ingest read is a separate,
  system-owned path).
- Does **not** introduce a per-socket snapshot for the polled path — the local table is
  the baseline (Fact A); only the incremental cursor is server-local state.

## 11. Sign-off checklist (maintainer)

- [ ] `.source()` grammar + orthogonality to `shardMode` + `externallyManaged`
      implication approved (§2).
- [ ] System-owned read via `applyCdcChanges`-only ingress accepted as the determinism
      boundary; `ctx.sql` stays action-only (§1 Fact B, §3.2).
- [ ] Mandatory `tenantBy` + `external_source_unscoped` lint accepted as the
      non-negotiable tenant boundary (§4).
- [ ] full-pull (default, sees deletes) vs incremental (cheap, needs delete-visibility)
      fork accepted; STOP condition on incremental-without-delete-path agreed (§3.3).
- [ ] Phase 3 (live CDC) split into its own plan; Phase 4 (DO-consumes-DO) deferred with
      the seam preserved (§8.5, §8.6).
- [ ] Phase 0 benchmark scope accepted as the gate for the default cadence/cap (§9).
