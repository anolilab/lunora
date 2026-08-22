# Convex primitives gap analysis — what the three "missing primitives" mean for Lunora

**Type:** reference (no plan number; not a wave item)
**Sources:** `get-convex/convex-backend` @ `ba336a6` (shallow clone, 2026-08-21) · `anolilab/lunora` @ `c7bb34c`
**Prompt:** a claim that Convex has shipped snapshot queries and commit-ordering
timestamps, and now "just lacks three primitives: server-side reactivity for actor
patterns, memory tables for ephemeral state that doesn't need to persist to disk,
and init mutations to recreate memory state when necessary."

This document verifies that claim against the Convex source, then asks the only
question that matters for us: **which of those five things does Lunora already
have, and which are worth building?**

---

## 1. The claim, verified

### 1.1 Shipped in Convex — snapshot queries

Real, and narrower than the name suggests. It is an escape hatch on
`ctx.runQuery`, not a general time-travel read:

```ts
// npm-packages/convex/src/server/registration.ts:1215-1227
export interface AdvancedRunQueryOptions {
    transactionLimits?: TransactionLimits;
    /**
     * Run a query on a recent snapshot of the database that is not guaranteed
     * to be up-to-date when this transaction commits.
     * ... generally discouraged except for specific use-cases where database
     * read conflicts are expected, e.g. reading from an append-only table with
     * immutable records where the only read conflicts are from concurrent appends.
     */
    useStaleSnapshot?: boolean;
}
```

It dispatches to a distinct UDF type — `runUdf("snapshotQuery", …)`
(`npm-packages/convex/src/server/impl/registration_impl.ts:65`, `:756`). The
purpose is **OCC relief**: the sub-query's reads are deliberately excluded from
the calling mutation's read set, so a hot append-only table stops manufacturing
write conflicts. Correctness is traded for throughput, explicitly and locally.

### 1.2 Shipped in Convex — commit-ordering timestamps

Also real, and it is a nicely-designed primitive:

```ts
// npm-packages/convex/src/server/database.ts:374-386
vars: {
    /**
     * The placeholder for the transaction's commit timestamp. Written into a
     * document field via `db.insert`, it resolves at commit to an int64
     * (`bigint`) ordered by commit order.
     */
    commitTs: CommitTsPlaceholder;
}
```

`CommitTsPlaceholder` (`npm-packages/convex/src/values/value.ts:98-127`) is a
nominal singleton that throws on `valueOf()`/`toJSON()` and only tolerates
string coercion so logging a read-back document doesn't explode. You write
`db.vars.commitTs` into a field; the committer substitutes a commit-ordered
int64. It gives you a **total order that matches durability order**, which
wall-clock `_creationTime` does not — two mutations can be stamped in one order
and commit in the other.

Both claims check out.

### 1.3 Missing in Convex — all three

| Primitive              | Verification                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-side reactivity | The subscription engine exists (`crates/database/src/subscription.rs` — read-set tokens over an `IntervalMap`) but has exactly one consumer: the client-facing WebSocket sync worker (`crates/sync/src/worker.rs:1204`). Nothing subscribes on behalf of _server_ code. Even triggers are userland — shipped as a component (`npm-packages/components/triggers`), not a database feature. |
| Memory tables          | No hits for `memory_table` / `ephemeral_table` / volatile tables anywhere in `crates/`. What exists is `BackendInMemoryIndexes` (`crates/indexing/src/in_memory_indexes.rs`, used from `snapshot_manager.rs:249`, `committer.rs:785`) — an in-memory **cache of durable indexes**, not non-durable storage. Every write still goes through the commit log.                                |
| Init mutations         | No `onInit` / bootstrap-mutation concept in `npm-packages/convex/src/server/`. Nothing to recreate, because nothing is volatile.                                                                                                                                                                                                                                                          |

Note the coupling: **(2) and (3) are one feature.** Init mutations only exist as
a concept because memory tables can vanish. Convex is missing neither
independently — it's missing the pair.

---

## 2. Why this reads differently from where Lunora sits

Convex is a shared multi-tenant Rust backend built around one global commit log.
Everything durable, everything ordered, subscriptions terminating at the client.
Memory tables there mean carving a non-durable region out of a system whose
entire identity is that log — genuinely hard, hence not shipped.

Lunora's substrate is the opposite. **A shard is a Durable Object: it already
_is_ an actor** — single-threaded, addressable, with a live JS heap and a
co-located SQLite file. The three "missing primitives" aren't hard for us to
reach; two of them are nearly free.

But we inherit the mirror-image hazard, and the codebase has already paid for it
twice. Hibernation evicts the heap without warning, and both times we kept state
there it was a shipped bug:

> "That baseline was originally an in-memory `WeakMap`, which a hibernation
> eviction silently cleared: on the next alarm wake the diff ran against an
> _empty_ baseline, so a row deleted from D1 while the DO slept produced no
> `delete` poke and lingered on the client forever (a phantom row)."
> — `packages/shard-engine/src/ctx-db-global-shape-snapshot.ts:6-14`

> "`shapeMemos` … was originally an in-memory-only `WeakMap`. A hibernation
> eviction … silently clears it, so the first write after every wake fell back
> to a literal `0` instead of the true baseline … a real, worsening-over-time
> cost cliff, not a one-time cold start."
> — `packages/shard-engine/src/ctx-db-shape-poke-cursor.ts:4-15`

Both were fixed by moving the state into SQLite. That is the empirical case for
why, if we ever expose memory tables to app authors, **the re-init story is not
a follow-up — it is the feature.** Convex's framing (memory tables + init
mutations as a pair) is exactly right, and we have the incident history to prove
it.

---

## 3. Scorecard: Lunora against all five

| #   | Primitive                     | Lunora today                                                                                                                                                                                                                                                                                                                                                                                                                                       | Verdict                 |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | Snapshot queries (OCC relief) | `ctx.runQuery` takes **no options at all** (`packages/server/src/types.ts:613-616`). No way to opt a sub-read out of the read set.                                                                                                                                                                                                                                                                                                                 | **Gap**                 |
| 2   | Commit-ordering timestamps    | `_creationTime` is wall-clock (`packages/server/src/schema.ts:861`). A commit-ordered counter exists — `__cdc_log.seq`, `INTEGER PRIMARY KEY AUTOINCREMENT`, "monotonic per-shard cursor, strictly increasing, never reused" (`packages/shard-engine/src/ctx-db-cdc.ts:25-36`) — but it is internal to CDC and not writable into a user document.                                                                                                  | **Gap, but half-built** |
| 3   | Server-side reactivity        | Row-level: **we already beat Convex.** `.triggers()` is native schema (`packages/server/src/schema.ts:225`, `:263-268`) with before/after × insert/update/delete, fired inline in the write path; Convex ships this as a userland component. Query-level: **no.** `refreshSubscriptions` iterates `this.runner.sockets()` (`packages/do/src/shard-do.ts:8259-8260`) — every subscriber is a WebSocket. There is no server-terminated subscription. | **Partial**             |
| 4   | Memory tables                 | Nothing queryable. The closest things: `whisper` — ephemeral topic broadcast with "NO SQLite/CDC write" (`packages/shard-engine/src/types.ts:142-146`), which is a _transport_, not state; and `ReactiveCache`, in-memory and deliberately volatile (`packages/shard-engine/src/reactive-cache.ts:14-22`), but framework-internal. `.ttl()` (`schema.ts:235`) is alarm-swept **persistent** rows — the durable answer to the same use case.        | **Gap**                 |
| 5   | Init mutations                | Nothing. Lifecycle hooks are per-socket (`onConnect`/`onDisconnect`, `packages/server/src/lifecycle.ts`), not per-shard-wake.                                                                                                                                                                                                                                                                                                                      | **Gap**                 |

Two of the five we're ahead on the parts that matter (native triggers,
range-precise invalidation via `read-write-set.ts` rather than table-granular).
Three are real holes.

---

## 4. What's actually worth building

Ordered by (value × how much of it we already have) ÷ risk.

### 4.1 `_commitSeq` — commit-ordering timestamps _(highest value, lowest cost)_

We already mint the number. `__cdc_log.seq` is an autoincrement primary key
assigned inside the same DO transaction as the row write
(`ctx-db-cdc.ts:38-56`), which is precisely commit order. The work is exposure,
not mechanism:

- A `db.vars.commitSeq`-style placeholder written into a document field, resolved
  at flush from the CDC sequence.
- Or, cheaper and more Lunora-shaped: a `.commitOrdered()` table modifier that
  adds a system column alongside `_creationTime`, indexable via
  `SYSTEM_INDEX_FIELDS`.

Why it earns its place: every ordering-sensitive feature we ship currently leans
on wall-clock. Feeds, outbox replay, `@lunora/replica`'s `EventSource`, agent
transcripts. Convex's nominal-placeholder design (throw on `valueOf`, allow
`toString`) is worth copying verbatim — it makes "I read back my own unresolved
timestamp and did arithmetic on it" a type error _and_ a runtime error, and that
is the entire failure mode.

**Caveat to settle first:** `seq` is per-shard. Convex's is global. For a
`.shardBy()` app, `_commitSeq` orders within a shard and says nothing across
shards, and `.global()` tables (D1) have no shard log at all. That must be in
the type and the docs from day one, not discovered later.

### 4.2 Server-side reactivity — query-level, for actors

The engine is there and is _better_ than table-granularity: `read-write-set.ts`
turns a query's index conditions into a half-open `[lo, hi)` slice and asks "did
this write land inside the slice that query read?", with an explicit safety rule
that any uncertainty degrades to whole-table invalidation
(`packages/shard-engine/src/read-write-set.ts:1-31`). What's missing is a
subscriber that isn't a socket.

Sketch — a subscription whose sink is a function reference rather than a
WebSocket:

```ts
// lunora/reactors.ts
export const rebalance = onQueryChange(internal.orders.pendingForDesk, { deskId: v.string() }, async (ctx, next, previous) => {
    /* runs in the shard, on commit */
});
```

Implementation notes from the current code:

- `refreshSubscriptions` (`shard-do.ts:8259`) would need its subscriber set to be
  `sockets ∪ serverReactors` rather than `[...this.runner.sockets()]`.
- Registration must be **durable**, in SQLite — a reactor registered in the heap
  is the `WeakMap` bug for the third time.
- Re-entrancy is the real design problem: a reactor that writes triggers another
  flush. Needs an explicit depth/fuel bound and a documented convergence contract,
  or it is a livelock generator.
- Overlaps `.triggers()`. The honest distinction is **granularity**: triggers fire
  on a row op; a reactor fires on a _query result_ changing. Ship it only if we
  can state that difference in one sentence to an app author — otherwise it's a
  second way to do the same thing, and the repo conventions are explicit about
  not adding those.

This is the one with genuine differentiation. Convex structurally can't do it
cheaply (their subscription tokens live in a separate service from UDF
execution); in a DO the query, the data, and the reactor are the same isolate.

### 4.3 Memory tables + init — build them together or not at all

`.memory()` as a table modifier: rows live in a heap-side store keyed like a
table, readable through the same `ctx.db` surface, invisible to CDC, never
touching SQLite. Natural fit for cursors, typing state, live counters,
in-flight actor scratch space, rate-limit buckets.

Paired with:

```ts
export const warm = onShardInit(async (ctx) => {
    // rebuild memory tables from durable state after eviction
});
```

fired on the first ctx-bearing entry into a cold DO instance.

Real objections, worth stating before anyone starts:

1. **It is a footgun by construction.** `.ttl()` already covers most of the use
   cases durably (`schema.ts:235`), and `whisper` covers the pure-fanout ones
   with no state at all (`types.ts:142`). The residual is narrow: state that is
   read-often, written-often, and genuinely reconstructible.
2. **`onShardInit` must be provably sufficient.** If a reactor or subscription
   can observe memory tables between eviction and re-init, we have shipped the
   phantom-row bug as an API. The ordering guarantee has to be airtight.
3. **Interaction with OCC.** Memory writes must not enter the read/write set or
   raise `ConflictError("occ")` (`packages/shard-engine/src/transaction.ts:12`),
   and must not bump the CDC cursor — otherwise every typing indicator
   invalidates every live query on the shard.
4. **Platform parity is mandatory here.** Per `CLAUDE.md`, a new `ctx.*`/schema
   surface states its rating per target in `PlatformCapabilities` in the same
   change. `.memory()` is plausibly `native` on Cloudflare (DO heap), `emulated`
   or `unsupported` on `@lunora/platform-node` depending on process model. That
   answer is owed up front — this is exactly the class of feature the parity rule
   was written for.

**Recommendation: defer.** Highest risk, most overlap with shipped primitives,
and the two prior heap-state incidents are a direct warning. Revisit if a
concrete app hits the wall that `.ttl()` + `whisper` can't clear.

### 4.4 Snapshot queries — smallest, and probably right

An options bag on `ctx.runQuery` mirroring `AdvancedRunQueryOptions`. In a
single-shard DO the OCC pressure Convex is relieving is lower (writes are
serialized by the DO), so the payoff is smaller — but it's also nearly free, and
it becomes real the moment `.shardBy()` fan-out or a hot append-only table shows
up in `lunora insights`. Worth doing alongside 4.1; not worth doing alone.

---

## 5. Summary

The claim is accurate on all five counts. The useful reframe is that Lunora is
**not** three primitives behind Convex — the ledger is mixed:

- **Ahead:** native `.triggers()` (Convex ships a component), range-precise
  reactive invalidation, `.ttl()`, `whisper`, socket lifecycle hooks.
- **Behind:** commit-ordered timestamps, stale-snapshot reads.
- **Neither has it, and we're better placed to build it:** server-side
  query-level reactivity — because a shard already is an actor.
- **Neither has it, and we should be slower than Convex to want it:** memory
  tables, because our runtime evicts the heap and we have two shipped bugs
  proving what that costs.

---

## 6. What shipped (2026-08-22)

All four gaps were closed on `claude/convex-primitives-analysis-ulk22g`. Two of
the four changed shape once the code was read; those changes are the interesting
record here.

| Gap                       | Shipped as                                     | Notes                                                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit-ordered timestamps | `.commitOrdered()` → `_commitSeq`              | Stored in the `__doc__` blob, so `documentPath`'s `json_extract` fallback makes it orderable/indexable with no `ALTER TABLE`. Counter allocated once per mutation from `__commit_seq`, inside the same DO storage transaction as the rows it stamps. |
| Snapshot queries          | `ctx.runQuery(ref, args, { untracked: true })` | **Re-derived, not ported** — see below.                                                                                                                                                                                                              |
| Server-side reactivity    | `onQueryChange(select, handler)`               | Footprint gate + result digest, both durable in `__reactor_state`; convergence bounded per refresh drain.                                                                                                                                            |
| Memory tables + init      | `.memory()` + `onShardInit`                    | Shipped as a pair; the ordering guarantee lives in the DO base.                                                                                                                                                                                      |

### 6.1 Where the analysis above was wrong

**Snapshot queries were mis-scoped.** §3 listed `ctx.runQuery`'s missing options
bag as a gap on the assumption that Convex's `useStaleSnapshot` would transfer.
It does not. Convex needs that flag because a mutation there validates its whole
read set at commit, so _reading_ a hot append-only table manufactures OCC
conflicts. Lunora's OCC is a compare-and-swap on the `__doc__` of each row a
mutation **writes** (`runGuardedWrite` in `ctx-db.ts`) — there is no read-set
conflict class, so a literal port would have relieved nothing.

What a read actually costs here is **reactivity**: every table a live query
touches enters its read footprint, and any write to those tables re-runs the
subscription. That is Lunora's version of the pressure Convex is relieving, and
`untracked` is what addresses it. The name matters: nothing is stale, so calling
it `useStaleSnapshot` would have been a lie about the semantics.

**Memory tables were half-right.** §4.3's recommendation to defer stands on the
reasoning but was overruled by scope. The implementation is honest about what it
could not deliver: workerd exposes one SQL handle and no memory-backed database,
so `.memory()` buys the _lifetime_ (and keeps writes out of the CDC changelog),
not the write. It is a real table that is wiped, not a heap store — which keeps
one storage model instead of two that drift, and is rated `emulated` on both
targets with that note attached.

### 6.2 Decisions worth re-reading before extending any of this

- **`onQueryChange` takes an inline read, not a query reference.** A reference
  would need static resolution of an imported identifier and would couple
  reactors to `_generated/api`. The callback keeps discovery trivial and lets the
  read and handler share one transaction and one footprint. The cost is a
  conservative footprint (the union of both), which can cost a redundant `select`
  and never a missed reaction.
- **The reactor baseline is the PRE-handler digest.** So a handler that changes
  its own read is invoked again on the new result, and again, until it settles.
  That cascade is the feature — it is how an actor advances a state machine — and
  `MAX_REACTOR_RUNS_PER_DRAIN` is the backstop for the case that never settles.
- **Reactors and `onShardInit` run system-trusted.** RLS scopes rows to a user
  and neither dispatch has one. Failing them closed would make both unusable
  under `.rls("required")`; inheriting the last writer's identity would be worse
  than running as nobody. Both docblocks say plainly that `select` sees every row
  and must scope itself.
- **Three ceilings are documented rather than fixed.** A hard delete is invisible
  to a `_commitSeq` feed (pair with `.softDelete()`); `_commitSeq` is per-shard,
  so `.global()` is rejected; and a `.memory()` table cannot carry a
  search/geo/aggregate/rank/vector companion, because clearing it is a `DELETE`
  on the base table.

### 6.3 Follow-ups, closed

All three items originally deferred out of the feature work have since shipped on
the same branch:

- **`commit_ordered_hard_delete`** — a `WARN`-level static lint flagging a
  `.commitOrdered()` table with no `.softDelete()`. Warn rather than error
  because an append-only table has no delete to express; the lint exists because
  the failure is silent and permanent, so it should be a decision.
- **Docs** — `concepts/commit-ordering`, `concepts/reactors`, and
  `concepts/memory-tables`, each leading with the problem rather than the API,
  and each stating its ceilings as prose rather than footnotes.
- **Reactor observability** — durable per-reactor counters in `__reactor_state`,
  the `listReactors` admin read, and a Studio **Reactors** panel under
  Observability. The panel leads with a three-way state (`idle` / `active` /
  `failing`) because "declared but never dispatched" is the state an operator is
  actually looking for, and it surfaces the suppressed:runs ratio because a
  suppressed dispatch is real work done to learn nothing changed.

Two bugs surfaced while building those, both worth remembering:

1. **The conformance reference host could not serve a `PRAGMA` read.** It
   buffered rows only for statements starting with `select`, so the engine's
   idempotent migrations — which pragma-check for a column before
   `ALTER TABLE … ADD COLUMN` — saw "column missing" for a column that was there
   and failed with "duplicate column name". The aggregate-companion migration had
   the identical exposure and simply was not exercised by the suite.
2. **A reactor's writes never flushed.** `ctx.db` only _stages_ touched tables via
   `recordChangedTable`; the request path is what flushes them, and a reactor has
   no request. Without an explicit flush its writes sat unflushed until an
   unrelated RPC — invisible to subscribers, and the cascade that lets an actor
   advance a state machine never happened. Caught because the convergence test
   measured one run instead of eight.
