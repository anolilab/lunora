# Plan 133: Live CDC ingest + DO-consumes-DO shape (external-source follow-ups)

> **Rehomed from plan 077.** Plan 077 (Hyperdrive → per-agent DO shape ingest)
> shipped Phases 0–2 — the `.source()` table modifier, the polled
> read→diff→`applyCdcChanges`→materialize loop, tenant-scope lints, and codegen
> emission (record in `plans/README.md` Wave 7 row + git history; the plan files
> were removed once shipped). Its design docs recommended spinning the two
> **deferred** phases into their own plan (077 §8.5, §8.6). This is that plan.
>
> - **Phase 3** — live CDC ingest (replace polling with pushed change frames).
> - **Phase 4** — DO-consumes-DO shape (one DO materializes another DO's shape).
>
> **Drift check (run first)**: confirm the shipped seams still exist at HEAD:
> `git grep -n "pollExternalSources\|readExternalSourceRows\|runExternalSourceTick" packages/do/src packages/codegen/src`
> and `git grep -n "applyCdcChanges" packages/do/src/ctx-db-cdc.ts`. On a mismatch,
> re-read the cited symbols before trusting this plan.

## Status

- **Priority**: P3 (deferred, demand-gated). **Neither phase is a needed feature.**
  The origin use case (multitenant Hyperdrive Postgres → per-agent DOs → live to
  clients) is **fully covered by the shipped Phase 2 polled path.** Both phases
  here are optimizations/stretch on top of a working capability, not unblockers.
- **Effort**: Phase 3 = L–XL. Phase 4 = XL (needs a DO↔DO transport that does not
  exist yet).
- **Risk**: HIGH — both touch the three places Lunora cannot afford a regression:
  the ingest boundary (non-deterministic external data entering the deterministic
  write path), the RLS/tenant boundary, and the shape/poke transport.
- **Category**: architecture / data-ingest
- **Rehomed at**: commit `HEAD` (alpha), 2026-07-04. Origin: plan 077 (Mats
  Erdkamp's external question).

## Recommendation — DO NOT build speculatively

Ship neither phase until a concrete driver exists. Both are demand-gated:

- **Phase 3 does not unlock a new capability** — it makes an already-working
  capability _fresher_. A Postgres write lands in the agent DO within the poll
  interval today (≈2 s floor, size-scaled up to ≈10 s for large slices; see 077
  §9). Phase 3 collapses that to "live." Build it only when a **real workload
  proves the poll latency is the bottleneck** — i.e. a source that both needs
  sub-poll-interval freshness _and_ has churn high enough that polling wastes CPU.
  The named use cases (RAG working sets, per-tenant caches, edge-local slices) all
  tolerate a polled refresh.
- **Phase 3 drags external infra into a path the core must not depend on** —
  Postgres triggers→queue or a replication-slot sidecar. That is _user-facing infra
  complexity_, which runs against the "scale invisibly" DX principle unless it can
  be made invisible (it currently cannot). Keep the polled path the default forever.
- **Phase 4 is a speculative new primitive** — no concrete demand exists (it was a
  "cherry on top / stretch" in the origin question). It requires designing a whole
  DO↔DO subscription transport with its own RLS/fan-out/hibernation correctness
  story. Build it when a user actually needs cross-DO materialization, not ahead of
  demand.

**The higher-value nearby work is the Phase 2 open follow-ups** (see §"Prefer
these first") — small, low-risk refinements to the feature people will actually
use. Do those before either phase here.

## Why the seams already exist (what makes these tractable when demanded)

Phase 2 was deliberately built transport-agnostic so both follow-ups reuse it by
**swapping only the read hook** — the diff, the sink, and the materialize loop are
already proven and unit-tested:

- **The single legitimate ingress is `applyCdcChanges`** (`packages/do/src/ctx-db-cdc.ts`,
  ≈256). Every upsert/delete — polled, pushed, or peer-DO-sourced — must enter the
  deterministic write path _only_ through it. That keeps non-deterministic external
  rows out of user query/mutation handlers and reuses index/companion/`__cdc_log`
  maintenance for free (so materialized rows are themselves live-pokeable to
  `defineShape` subscribers with zero extra work).
- **The pure diff is source-agnostic** — `diffExternalSource`
  (`packages/do/src/external-source-diff.ts`) takes _pulled rows + current local
  baseline_ → ordered `CdcChange[]`. It does not care whether the rows came from a
  Hyperdrive query, a queue frame, or a peer DO's shape stream.
- **The materialize tick is a seam** — `runExternalSourceTick` /
  `materializeExternalRows` / `readExternalSourceBaseline`
  (`packages/do/src/external-source-materialize.ts`, `external-source-pull.ts`) run
  inside the DO storage transaction (all-or-nothing) and are called from
  `ShardDO.pollExternalSources()` (base no-op; codegen override at
  `packages/codegen/src/emit.ts` ≈3408). The base read hook `readExternalSourceRows`
  returns `[]` and is overridden by the emitted subclass to run the declared
  Hyperdrive query. **Both phases here are new read hooks feeding the same tick.**
- **Tenant scoping is structural + enforced** — `resolveShard`
  (`packages/runtime/src/resolve-shard.ts:65-73`) gives one private SQLite per shard
  key; the `external_source_unscoped` / `external_source_on_global` advisor lints
  (shipped) make `tenantBy` mandatory under `.shardBy()`. Any new ingress must route
  a change frame to the **owning shard DO only** and reuse that boundary.

## Phase 3 — Live CDC ingest (trigger→queue push)

Replace the alarm poll with pushed per-tenant change frames for sources that opt
in. Per 077 Decision 5, the first live path is **Postgres triggers →
`@lunora/queue` → per-tenant fan-out**; a replication-slot sidecar is an advanced
opt-in. **Cloudflare Hyperdrive does not expose the Postgres WAL** — never tail the
log in-DO (STOP condition).

**Shape of the work (when demanded):**

1. **Producer (user-owned, documented recipe, not core):** a Postgres trigger (or
   a logical-replication sidecar) emits `{ tenant, table, op, id, row }` frames to a
   Lunora queue via `defineQueue` (`lunora/queues.ts`; typed `ctx.queues.<name>`
   producer + generated `queue()` consumer, per `@lunora/queue`).
2. **Ingest consumer → owning shard DO:** the queue consumer routes each frame to
   the owning shard DO (via the same namespace/`resolveShard` binding the source
   table shards by) and calls a new internal RPC that `applyCdcChanges`-es the
   frame. **Tenant of the frame must equal the target shard key** — validate, do not
   trust; a frame for tenant-B arriving at DO tenant-A is a hard drop + logged error.
3. **`.source({ refresh })` gains a live mode** — e.g. `refresh: { via: "queue",
queue: "docsCdc" }`. A live source arms **no** alarm poll (or a slow reconcile
   poll only, to GC missed deletes — mirror the incremental-mode delete-visibility
   requirement in 077 §3.3). Full-pull polling stays the default for non-opt-in
   sources.
4. **Codegen** wires the consumer→DO route and the RPC, gated on `hasLiveSources`
   (mirror the existing `hasSourcedTables` gate), so a non-live schema's output is
   byte-identical.

**Open decisions (resolve before building):**

- Frame ordering/dedup across queue retries (idempotency key = `(table, id, lsn)`?).
- Missed-frame recovery: does a live source keep a slow full-pull reconcile as a
  safety net, or rely on the producer's at-least-once + a resync RPC? (Recommend the
  reconcile net — silent divergence is the worst failure.)
- Where the producer recipe lives (docs-only vs a `@lunora/hyperdrive/cdc` helper).

**Verify:** an external Postgres write to tenant-A's row appears in agent DO
tenant-A's SQLite (and its shape clients) without a poll; tenant-B is untouched;
raw external data never enters a query/mutation handler (only via
`applyCdcChanges`); a dropped/duplicated queue frame does not drop or duplicate a
materialized row (idempotency test); killing the producer degrades to stale, never
to a wrong slice.

## Phase 4 — DO-consumes-DO shape (new transport)

A primitive for one DO to subscribe to another DO's `defineShape` and materialize
it locally via the **same `applyCdcChanges` sink + `diffExternalSource` helper** —
swapping the read hook from "Hyperdrive query" to "peer-DO shape stream." The sink
and diff are ready; **the missing piece is a DO↔DO subscription transport** (shapes
today terminate at the client over WS; the plan-075 relay tier is owner→relay
broadcast, not DO-side materialization).

**Shape of the work (when demanded):**

1. **Transport:** an internal DO→DO subscription channel (WebSocket hibernation
   between DOs, or a poke+pull RPC) carrying the same op-log frames a client shape
   receives. This is the genuinely new, XL surface.
2. **RLS across DOs:** the consuming DO subscribes under a **verified identity** —
   the peer shape must be evaluated with the consumer's RLS context, not
   forced-anonymous and not the peer's owner identity. (See the subscriptions-RLS
   fix precedent — live shapes must evaluate under the socket's verified identity.)
3. **Materialize:** frames land through `runExternalSourceTick` → `applyCdcChanges`
   into a local table, identical to Phases 2/3. Resume rides the existing CDC epoch
    - cursor model — no new client-facing resume surface.
4. **Loop/fan-out guards:** prevent A→B→A subscription cycles and bounded fan-out
   (reuse the relay-tier hysteresis thinking from plan 075).

**Open decisions:** transport choice (hibernated WS vs poke+pull); how a consuming
DO addresses a producing DO's shape (binding + shard key + shape name); whether this
is a `.source({ from: "do", ... })` mode or a distinct `defineDoShape` primitive.

**Verify:** DO-A materializes DO-B's shape slice; DO-B's RLS is enforced under
DO-A's identity (negative test: DO-A cannot see rows RLS would deny it); a
subscription cycle is rejected; hibernation of either DO resumes without dropping or
duplicating rows.

## Prefer these first — Phase 2 open follow-ups (low-risk, high-value)

These improve the **shipped** feature and should be done before either phase above:

- **Honor per-source `refresh.everyMs`** — today `pollExternalSources` runs every
  alarm tick regardless of the declared cadence; store each source's `nextDueAt` and
  skip sources not yet due (077 §3.1).
- **`"manual"`-mode pull-now RPC** — `ingest.pull(table)` runs one materialize tick
  on demand ("refresh this agent's working set before a run"), routed to the shard
  DO like any RPC (077 §5).
- **Studio freshness surface** — `lastPolledAt` / `lastError` / `rowCount` per
  sourced table; a sourced-table badge (last pull, staleness, row count, last
  error). A stale/failing pull must be visible, never a silently empty agent table
  (077 §5, §7).
- **Incremental-mode delete-visibility lint** —
  `external_source_incremental_no_delete_path`: an `incremental` source with neither
  a soft-delete column nor a declared `reconcileEveryMs` is a STOP condition (silent
  phantom rows) (077 §3.3, §4).

## Commands you will need

| Purpose          | Command                                                           | Expected                      |
| ---------------- | ----------------------------------------------------------------- | ----------------------------- |
| Build deps first | `pnpm run build:packages`                                         | exit 0 (run once)             |
| DO tests         | `pnpm --filter "@lunora/do" run test`                             | all pass                      |
| Hyperdrive tests | `pnpm --filter "@lunora/hyperdrive" run test`                     | all pass                      |
| Queue tests      | `pnpm --filter "@lunora/queue" run test`                          | all pass (Phase 3)            |
| Codegen golden   | `pnpm --filter "@lunora/codegen" run test`                        | golden fixtures updated+green |
| Typecheck        | `pnpm --filter "@lunora/do..." run lint:types`                    | exit 0                        |
| Lint             | `pnpm run lint:eslint`                                            | exit 0                        |
| workerd e2e      | `LUNORA_WORKERD_TESTS=1 pnpm --filter "@lunora/runtime" run test` | ingest e2e passes             |

## Done criteria (per phase; ALL must hold)

- [ ] No loosening of `ctx.sql`'s action-only contract — external data enters only
      via `applyCdcChanges` from a system-owned path.
- [ ] Explicit cross-tenant isolation test: a frame/stream for tenant-B never
      materializes into DO tenant-A.
- [ ] Codegen golden fixtures regenerated + committed; a non-opt-in schema's
      `shard.ts` is byte-identical (gated emission).
- [ ] `pnpm --filter "@lunora/do..." run lint:types`, `@lunora/do` +
      `@lunora/hyperdrive` (+ `@lunora/queue` for Phase 3) tests, and
      `pnpm run lint:eslint` all exit 0.
- [ ] Idempotency/resume test: a duplicated/dropped frame or a hibernation cycle
      does not drop or duplicate a materialized row.
- [ ] `plans/README.md` status updated.

## STOP conditions

- Phase 3 appears to require Cloudflare Hyperdrive to expose the Postgres WAL — it
  does not. Route via trigger→queue or a sidecar, never in-DO log tailing.
- A live frame or peer-DO stream would enter the deterministic query/mutation write
  path with raw external rows — it must only enter via `applyCdcChanges`.
- A sourced + `.shardBy()` ingress lacks tenant validation (frame tenant ≠ target
  shard) — this re-opens the cross-tenant leak the whole feature exists to prevent.
- Phase 4's DO↔DO transport would evaluate the peer shape's RLS as anyone other than
  the consumer's verified identity — fail-closed, do not ship.
- Resume/diff diverges from the shipped external-source oracle — do not ship a
  materialization that can drop or duplicate a row across a frame/poll/stream.
