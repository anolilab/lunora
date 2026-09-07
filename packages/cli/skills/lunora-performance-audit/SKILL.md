---
name: lunora-performance-audit
description: Diagnoses and fixes Lunora performance problems — full-table scans, missing
    indexes, OCC write conflicts, oversized subscriptions, and sharding/`.global()`
    scaling. Use when queries are slow, mutations conflict, `lunora insights`
    reports a hot-spot, or `@lunora/advisor` flags a table.
---

# Lunora Performance Audit

Systematically diagnose Lunora performance issues, route to the right fix, and
apply it across sibling functions consistently.

## When to Use

- Queries feel slow or read far more rows than they return.
- Mutations conflict (409 `CONFLICT`) under load (OCC).
- Subscriptions fan out updates too broadly or re-run too often.
- The Lunora Studio **Advisors** tab or `@lunora/advisor` flags a table.

## When Not to Use

- Scale is small, traffic is modest, and there is no measured problem — prefer
  simpler code. Do not introduce sharding, digests, or splits on speculation.

## Core Workflow

1. **Scope** one concrete user flow with a clear entry and exit.
2. **Trace** every `ctx.db` read and write in that flow.
3. **Route** to the matching problem class below.
4. **Fix siblings** consistently — every function touching the same table should
   read it the same indexed way.
5. **Verify** behavior is unchanged and the advisor finding clears.

## Signal Gathering

### Runtime signal: `lunora insights`

When the worker is running and has served traffic, start here — it reports the
measured problem, not a suspected one:

```bash
lunora insights                      # against the local dev worker
lunora insights --shard channel:demo # scope to one shard
lunora insights --limit 25 --json    # machine-readable, more rows
lunora insights --prod --url https://app.example.com --token $LUNORA_ADMIN_TOKEN
```

It ranks per-function **write-conflict hot-spots** (OCC contention — the
sharding signal), **error rates**, and **latency outliers**. A function at the
top of the write-conflict list is the direct input to the OCC section below; a
latency outlier usually resolves to the read-amplification section.

The Studio **Issues** panel and `lunora logs` cover the error side in more
detail once `insights` tells you where to look.

### Static signal: the advisors

These need no traffic, so they also work on a cold codebase:

- **Lunora Studio → Advisors tab** surfaces `@lunora/advisor` findings live in
  dev.
- `@lunora/advisor` runs ~90 static lints over `defineSchema` + discovered query
  reads / insert writes (plus a few runtime lints). The performance/schema rules
  most relevant here:
    - `filter-without-index` — a query filters a table with no covering index.
    - `unindexed-foreign-key` — a relation/FK column has no index.
    - `duplicate-index` / `empty-index` — wasted or malformed indexes.
    - `index-references-unknown-field`, `relation-references-unknown-field`,
      `relation-references-unknown-table` — broken index/relation definitions.
    - `table-without-insert` — a table is read but never written (often a
      schema/typo signal).

## Problem Class: Read Amplification (the common one)

**Symptom:** a query reads the whole table to return a few rows;
`filter-without-index` fires.

**Fix:** read through an index, not `.filter()`. Declare the index on the table
and use `.withIndex()` with an equality/range on the leading columns.

```ts
// Bad — scans every row, then filters in memory.
const mine = (await ctx.db.query("documents").collect()).filter((d) => d.orgId === orgId);

// Good — declare the index…
documents: defineTable({ orgId: v.string(), createdAt: v.number() /* … */ }).index("by_org_created", ["orgId", "createdAt"]);

// …and read through it.
const mine = await ctx.db
    .query("documents")
    .withIndex("by_org_created", (q) => q.eq("orgId", orgId))
    .collect();
```

Index columns are ordered: put equality columns first, then the range/sort
column. Fix every sibling query on the table the same way.

## Problem Class: Write Conflicts (OCC)

**Symptom:** mutations on hot rows fail under concurrency, or the function tops
the write-conflict section of `lunora insights`. ShardDO uses optimistic
concurrency control — concurrent writes to the same DO that touch overlapping
state conflict. There is **no server-side retry loop**: the loser throws
`ConflictError` (code `CONFLICT`, HTTP 409) and the caller decides, so a client
that never handles it (`isConflictError` from `@lunora/client`) just surfaces
409s to the user.

**Fixes, in order of preference:**

1. **Narrow the write.** Patch only the fields that changed; avoid read-modify-
   write over rows another mutation also touches.
2. **Partition with `.shardBy(key)`.** Move per-user / per-tenant / per-room
   state into its own DO so writes for different keys never contend. This is the
   primary horizontal-scale lever — most write contention is a single-DO
   hotspot.
3. **Avoid unbounded counters/aggregates in the hot path.** Accumulate in a
   sharded/append shape and fold lazily rather than serializing every writer
   through one row.

## Problem Class: Subscription Cost

**Symptom:** a `useQuery` re-runs and re-pushes to many clients on unrelated
writes.

**Fixes:**

- **Scope query args tightly** so a subscription only depends on the rows it
  renders — a query keyed by `orgId` should not re-run for another org's write.
- **Read through indexes** (above) so the reactive dependency is the narrow
  index range, not the whole table.
- ShardDO subscriptions are **hibernated WebSockets** — idle connections cost
  nothing; the lever is _how many rows each live query depends on_, not raw
  connection count.

## Problem Class: Cross-Region Reads

**Symptom:** read-heavy, rarely-written data is slow for far-away users.

**Fix:** chain `.global()` on the table to replicate it to D1 for low-latency
cross-region reads (with read-your-writes via the Sessions API). Reserve it for
read-mostly tables — `.global()` adds the D1 migration flow (see the
`lunora-migration-helper` skill) and write-path cost.

If the dataset outgrows D1, `.global({ backend: "hyperdrive" })` serves the same
reactive `.global()` contract from Postgres/MySQL over Cloudflare Hyperdrive —
see the `lunora-setup-hyperdrive-global` skill (and `lunora migrate
d1-to-hyperdrive` to move an existing dataset).

### `.shardBy(key)` vs `.global()` — choose one per table

- `.shardBy(key)`: partitions a table across Durable Objects by key — scales
  _writes_ (e.g. messages per room). Reads are per-shard.
- `.global()`: replicates a table to D1 — scales _cross-region reads_ with
  read-your-writes (e.g. a mostly-read catalog).
- They are not combined on the same table; the default (neither) is a single
  root-scoped ShardDO.

## Guardrails

- Prefer simpler code when scale is small or the signal is weak.
- Do not recommend structural changes (digest tables, document splitting,
  sharding) without a measured signal or a known hot path.
- When you change how one function reads/writes a table, change its siblings to
  match — half-migrated access patterns are their own bug.

## Checklist

- [ ] Scoped one concrete flow; traced every `ctx.db` read/write.
- [ ] Ran `lunora insights` (if the worker has traffic) for the measured signal.
- [ ] Checked the Studio Advisors tab / `@lunora/advisor` findings.
- [ ] Read amplification: replaced `.filter()` with an indexed `.withIndex()`.
- [ ] Write conflicts: narrowed writes and/or partitioned with `.shardBy(key)`.
- [ ] Subscription cost: scoped query args so live queries depend on few rows.
- [ ] Cross-region: applied `.global()` only to read-mostly tables.
- [ ] Fixed sibling functions consistently; verified behavior unchanged.
