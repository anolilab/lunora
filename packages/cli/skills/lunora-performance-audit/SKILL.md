---
name: lunora-performance-audit
description: Diagnoses and fixes Lunora performance problems — full-table scans and missing indexes, expensive `ctx.db.related` traversals, OCC write conflicts (409 `CONFLICT`), live queries that re-run too often, hot shards, and choosing `.shardBy(key)` or `.global()` to scale. Starts from measured signal (`lunora insights`) and static signal (`lunora advisor`, `@lunora/advisor` lints such as `filter_without_index`, `unbounded_collect`, `unindexed_foreign_key`, `hot_shard`). Use when the user says a query or page is slow, mutations fail with conflicts under load, subscriptions are chatty, asks to "audit performance", "add the right index", or "should I shard this table", or when the Studio Advisors tab or `lunora advisor` flags something.
---

# Lunora Performance Audit

Find the measured problem, route it to the matching fix below, and apply the
fix to every function that touches the same table.

If traffic is modest and nothing is measured as slow, prefer simpler code. Don't
introduce sharding, digest tables or document splits on speculation.

## Workflow

1. **Scope** one concrete user flow with a clear entry and exit.
2. **Gather signal** with `lunora insights` (runtime) and `lunora advisor`
   (static).
3. **Trace** every `ctx.db` read and write in that flow.
4. **Route** to the problem class below and fix it.
5. **Fix siblings** so every function reads the table the same indexed way. A
   half-migrated access pattern is its own bug.
6. **Verify:** behaviour unchanged, the advisor finding cleared, and the
   `insights` row improved after the fix has served traffic.

## Signal

### Runtime: `lunora insights`

Needs a running worker that has served traffic. It reports measured problems:

```bash
lunora insights                       # local dev worker (http://localhost:8787)
lunora insights --shard channel:demo  # one shard instead of the root
lunora insights --limit 25 --format json
LUNORA_ADMIN_TOKEN=… lunora insights --prod --url https://app.example.com
```

It ranks per-function **write-conflict hot-spots** (go to Write conflicts),
**error rates**, and **latency outliers** (usually Read amplification). The
Studio Issues panel and `lunora logs` give error detail once you know where to
look.

### Static: `lunora advisor` and `@lunora/advisor`

No traffic needed. The Studio **Advisors** tab shows the same findings live in
dev.

```bash
lunora advisor                         # score + write lunora.advisor.map.json
lunora advisor --entry messages#send   # one procedure (file#exportName)
lunora advisor --baseline              # CI: fail on regression vs the committed map
```

Lint ids are snake_case. The performance-relevant ones:

| Lint                              | Meaning                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `filter_without_index`            | A query filters a table with no covering index.                              |
| `unbounded_collect`               | `.collect()` with no index or filter loads every row (and re-sends it live). |
| `filter_on_primary_key`           | Filtering on `_id` scans; use `ctx.db.get(id)`.                              |
| `unindexed_foreign_key`           | An FK column has no index.                                                   |
| `unindexed_relation_target`       | A `many` relation's target FK has no index, so `with:` reads scan.           |
| `duplicate_index` / `empty_index` | Wasted or malformed index.                                                   |
| `index_utilization` (runtime)     | A declared index nothing uses, or a hot table read with none.                |
| `hot_shard` (runtime)             | One shard takes a disproportionate share of a sharded function's load.       |
| `fan_out_breadth` (runtime)       | A shard set so wide a cross-shard read nears the subrequest limit.           |

## Read amplification (the common one)

**Symptom:** a query reads the whole table to return a few rows; a latency
outlier in `insights`, or `filter_without_index` / `unbounded_collect`.

**Fix:** declare an index and read through it with `.withIndex()`:

```ts
// (auth / org membership check on `orgId` elided — see lunora-functions)
// Scans every row, then filters in memory.
const mine = (await ctx.db.query("documents").collect()).filter((d) => d.orgId === orgId);

// schema.ts
documents: defineTable({ orgId: v.string(), createdAt: v.number() /* … */ }).index("by_org_created", ["orgId", "createdAt"]);

// Reads only the org's range.
const mine = await ctx.db
    .query("documents")
    .withIndex("by_org_created", (q) => q.eq("orgId", orgId))
    .collect();
```

Put equality columns first, then the range/sort column. For a large range,
paginate instead of `.collect()`.

## Relation traversal cost

**Symptom:** a query using `ctx.db.related` is slow, or one page reads far more
rows than it returns.

A traversal is one batched `findMany` per edge, per hop, and the frontier grows
multiplicatively. The options are bounded, and an out-of-range value is rejected
with `BAD_REQUEST` instead of being clamped, so a throwing traversal means the
request is too big, not that there's a bug to route around.

| Option        | Default | Cap      | Why                                                           |
| ------------- | ------- | -------- | ------------------------------------------------------------- |
| `depth`       | `1`     | `4`      | Past 4 hops, request time is the limit, not `limit`.          |
| `limit`       | `50`    | `200`    | Nodes per page.                                               |
| cursor offset | `0`     | `10 000` | The offset is re-walked: each hop reads `N + limit + 1` rows. |

Fixes, in order:

1. **Narrow `edges`** to the `"<table>.<column>"` edges the feature needs. One
   unrelated `v.id(...)` column can double the frontier per hop.
2. **Set `direction`** to `"in"` or `"out"` instead of the default `"both"`.
3. **Lower `depth` before raising `limit`.** Hops multiply; a page is linear.
4. **Index the foreign keys.** Every inward hop is a `WHERE fk IN (…)` read
   (`unindexed_foreign_key`).
5. **Stop deep-paging.** Needing an offset past 10 000 means the traversal is
   the wrong tool; narrow the walk.

## Write conflicts (OCC)

**Symptom:** mutations on hot rows fail under concurrency, or a function tops
the write-conflict list in `insights`.

ShardDO uses optimistic concurrency. When a concurrent write commits first, the
mutation throws `ConflictError` (`code: "CONFLICT"`, HTTP 409). The runtime does
not retry it; a mutation body runs at most once per call, and the caller
decides what to do. On the client, check with `isConflictError(error)` from
`@lunora/client` (also exported via `lunorash/client`).

Not every 409 is contention. On the server, `ConflictError.kind` is `"occ"` for
real write contention, and `"unique"`, `"restrict"` or `"trigger"` for
constraint and guard failures. The client only sees `code: "CONFLICT"` (`kind`
is not part of the error envelope), so it cannot tell them apart. `insights` counts only `occ` as a write conflict, so fix a `unique`
409 in the data or the insert logic, not by sharding.

Fixes, in order:

1. **Narrow the write.** Patch only changed fields; avoid read-modify-write over
   rows another mutation also writes.
2. **Partition with `.shardBy(key)`.** Per-user / per-tenant / per-room state
   in its own Durable Object never contends across keys. This is the main
   horizontal-scale lever, since most contention is one hot DO.
3. **Take counters and aggregates off the hot row.** Append and fold lazily
   instead of serializing every writer through one row.

If `hot_shard` fires on an already-sharded table, the key is skewed: re-shard on
a higher-cardinality key or split the hot entity's state.

## Subscription cost

**Symptom:** a `useQuery` re-runs and re-pushes to many clients on unrelated
writes.

- Scope query args tightly so a live query depends only on the rows it renders;
  a query keyed by `orgId` shouldn't re-run on another org's write.
- Read through indexes so the dependency is the index range, not the table.
- Idle WebSockets are hibernated and cost nothing. The lever is how many rows
  each live query depends on, not the connection count.

## Cross-region reads

**Symptom:** read-heavy, rarely-written data is slow for distant users.

**Fix:** `.global()` replicates the table to D1 for low-latency reads from the
edge, with read-your-writes via D1 sessions. Use it only for read-mostly tables:
it adds write-path cost and its own DDL flow (`lunora-migration-helper`). If the
dataset outgrows D1, `.global({ backend: "hyperdrive" })` serves the same
reactive contract from Postgres/MySQL (`lunora-setup-hyperdrive-global`).

`.shardBy(key)` scales writes (rows in one DO per key); `.global()` scales
cross-region reads. A table can't have both; the default is the single root
ShardDO. Switching an existing table's mode moves its rows, which is an
export/import, not a schema edit (see `lunora-migration-helper`).

## Checklist

- [ ] Scoped one flow; traced every `ctx.db` read/write.
- [ ] Checked `lunora insights` (if there's traffic) and `lunora advisor`.
- [ ] Scans replaced with `.withIndex()` reads; FKs indexed.
- [ ] Traversals narrowed with `edges` / `direction` before touching `depth`.
- [ ] Write conflicts confirmed as `occ`, then writes narrowed and/or `.shardBy(key)` applied.
- [ ] Live queries depend on few rows; `.global()` only on read-mostly tables.
- [ ] Siblings fixed consistently; behaviour unchanged; finding cleared.
