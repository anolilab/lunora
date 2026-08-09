# Plan 315 — Make the aggregate-companion backfill marker durable

**Baseline:** `92749915f` (2026-08-09)
**Status:** TODO
**Priority:** P2 · **Effort:** M · **Risk:** MED · **Category:** perf

> **Executor instructions**: this plan deletes code rather than adding it — four
> conditions in `ctx-db.ts` and the note explaining them become dead the moment
> the marker is durable. If your change grows that file, re-read §3.

## 0. Headline finding

**Every table with an `aggregateIndex` rebuilds its companion from a full table
scan on the first companion touch of every dispatch.**

`ensureBackfilledIndex` (`ctx-db-companions.ts`) is not "backfill if empty" — it
is an unconditional `SELECT` of every row, a `rowToDocument` (JSON parse + wire
decode) per row, `DELETE FROM <companion>`, then a chunked re-insert. Its only
idempotence is a `Set<string>` held in the closure of `createCompanionSync`,
which is constructed once per `createShardCtxDb` — and codegen's `buildCtx`
constructs one **per dispatch**, and again **per subscription re-run**
(`_generated/shard.ts`, the `buildCtx` call sites).

So the maintained companion — the mechanism whose entire purpose is to answer an
aggregate without scanning — pays a full scan plus a companion rewrite before it
answers, once per request. The incremental `-prev + next` deltas it maintains are
correct and cheap; they are simply discarded and recomputed on the next dispatch.

This is pre-existing on `alpha` and is not a regression from plan 312. It was
found while sizing 312's reader gate.

## 1. Current state (audit)

- `packages/shard-engine/src/ctx-db-companions.ts` — `ensureBackfilledIndex`, and
  the `backfilled` / `rankBackfilled` `Set`s in `createCompanionSync`'s closure.
  The docstring states the intent plainly: "the first touch (read or write) does
  a full rebuild from scratch — TRUNCATE then re-tally — so that an index
  declared after rows already existed heals on first use."
- `packages/shard-engine/src/ctx-db-backfill.ts` — `backfillAggregateIndex`, the
  explicit twin, which IS durable-idempotent (`hasRows` guard) but has no
  production caller; it exists for tests and for hosts that want to pay up front.
- `packages/shard-engine/src/ctx-db.ts` — the three readers call `ensureBackfilled`
  before reading a companion, which is what puts the rebuild on the read path.
- `packages/codegen/src/emit.ts` — `buildCtx`, constructing a ctx-db per dispatch.

## 2. Existing seams (do not reinvent)

- **`hasRows`** in `ctx-db-backfill.ts` already expresses durable idempotence for
  the explicit twin. It is not sufficient on its own — an empty table and a
  never-built companion are indistinguishable — but it is the shape to start from.
- **`__lunora_migrations`** and the search backfill's state table
  (`ctx-db-search-state.ts`) are both precedents for a reserved per-shard state
  table recording "this derived thing is built, at this format version". The
  search one is the closer analogue: it stores a cursor AND an analyzer profile,
  so a format change re-walks.
- **`runShardMigrations`** already creates the companion tables, so it is the
  natural place to seed the marker for a newly declared index.

## 3. What becomes dead when this lands

Plan 312 gated the companion behind "only when the SQL scan would refuse"
specifically because reaching it is expensive. With a durable marker the
companion is unconditionally cheaper than the scan, and these go away:

- `scanRefusesAny` in `ctx-db.ts` and the long note on it.
- The `!aggScope || …` / `!groupScope || …` halves of the aggregate and groupBy
  fast-path gates, and the paragraph on `count`'s `!countScope`.
- The asymmetry between the three readers, which is the maintenance hazard that
  note exists to explain.

`isProjectedField` stays — `assertReducibleBySql` still needs it.

## 4. Design decisions to make

1. **What the marker records.** A bare "built" boolean is not enough: the tally
   format has changed twice (reducer-awareness, then live-only rows in plan 312),
   and each time the correct behaviour was to rebuild. Record a format version
   alongside, as the search backfill records its analyzer profile, so a version
   bump re-walks exactly once per shard instead of once per dispatch.
2. **Where it lives.** A column on the companion table, a row in a shared
   reserved table, or the existing migration ledger. Weigh: the companion table
   is dropped and recreated by the rebuild itself, so a column on it must survive
   TRUNCATE (it would not) — that likely rules it out.
3. **What happens on a schema change that alters an index's `by`/`where`/`op`.**
   Today every dispatch rebuilds, so drift self-heals invisibly. With a durable
   marker, a changed index definition MUST invalidate it, or the companion
   answers with a stale grouping forever. This is the risk that makes the plan
   MED rather than LOW: the current design is wasteful but self-correcting, and
   the fix trades that for something that must be got right.

## 5. Workstreams

| #   | Work                                                                                                                    | Size |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | Measure first: instrument `ensureBackfilledIndex` and record rebuilds-per-request and rows-scanned on a seeded table    | S    |
| 2   | Marker + format version per (table, index), invalidated by an index-definition change (§4.3)                            | M    |
| 3   | Delete the plan-312 gate and its note; readers take the companion whenever an index matches                             | S    |
| 4   | Tests: a second ctx-db does NOT rebuild; a changed index definition DOES; a live-only format bump rebuilds exactly once | M    |

## 6. Platform parity

**Not applicable** — no `ctx.*` surface, binding, or deploy capability changes.
The companion is host-neutral engine state. `@lunora/sql-store` maintains its own
companions with a different (async, `counterReady`) lifecycle and is out of scope;
if this lands, check whether the same waste exists there.

## 7. Risks & STOP conditions

- **STOP if WS1 shows the rebuild is not actually per-dispatch** in a real worker
  — the reasoning here is from codegen's construction sites, not from a
  production trace. If a host reuses a ctx-db across dispatches, this plan is
  worth much less.
- **A stale companion is a wrong answer, silently.** The current design cannot
  produce one; this one can if §4.3 is got wrong. That is the whole risk, and it
  is why the invalidation test in WS4 is not optional.
- Do not fold this into a plan-312 follow-up branch. It touches the read path of
  every table with an aggregate index, not just soft-delete ones.
