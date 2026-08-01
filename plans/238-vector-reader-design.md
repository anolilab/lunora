# Plan 238 — `.withVectorIndex()` reader: design & open questions

> Companion to `plans/238-vector-reader-spike.md`-equivalent work (this repo has
> no separate spike file for 238; this doc doubles as both). Spike scope: design
> the reader + prove the tenant-scoping boundary with a test-only prototype over
> the real `@lunora/bindings/vectors` binding. Codegen wiring and `define-rag.ts`
> refactor are explicit follow-ups, not built here.

## Why this gap exists

The schema side of vector search is fully built: `.vectorize(field, opts)` /
`defineVectorIndex(...)` (`packages/server/src/schema.ts:48-57,268-276,537-550,559-568`)
and a write-sync hook that keeps Vectorize current on every insert/update/delete
(`packages/bindings/src/vectors/context.ts:208-344`, wired into the generated DO
at `packages/codegen/src/emit.ts:4410-4423`). But the reader facade
(`packages/server/src/data-model.ts`'s `TableReaderFacade`) only has
`withGeoIndex`/`withSearchIndex` — both of which run entirely inside the shard's
own SQLite (geo/FTS tables materialized locally, see
`packages/shard-engine/src/ctx-db.ts:635-860` for the geo terminal). Vector
search is fundamentally different: the match set comes back from an **external,
account-global, asynchronously-indexed** service, so `@lunora/ai/rag` hand-rolls
its own read path (`packages/ai/src/rag/define-rag.ts`: raw
`context.vectors.query(...)` around `:686` + `hydrateFromStore` around `:637`)
instead of getting a reader for free.

## The reader API

```ts
ctx.db.docs
    .withVectorIndex(indexName, (q) => q.near(vectorOrText, { topK }))
    // -> VectorReader<TDocument>, same terminal shape as GeoReader/SearchReader
    .collect() // TDocument[], ordered best-match-first
    .take(n)
    .first()
    .unique()
    .collectWithScores(); // { document: TDocument; score: number }[] — reuses
// 236's ScoredDocument shape verbatim (SearchReader's
// field name, NOT GeoReader's distanceMeters — see
// "Score semantics" below for why)
```

- `indexName` is typed against the table's declared vector indexes (mirrors
  `GEO`/`SEARCH` type params on `TableReaderFacade` — this reader would add a
  `VECTOR extends Record<keyof DM, string>` type param the same way).
- `q.near(vectorOrText, { topK })` is the only builder method — vector search
  has no bounding-box analog to `.within()`, so unlike `GeoFilterBuilder` there
  is exactly one query shape.
- No `.paginate()` — same reasoning as geo/search: a relevance-ordered result
  set can't keyset-paginate. Cap with `.take(n)`.

### Read pipeline (three stages, each independently testable)

1. **Vectorize query** — `ctx.vectors.query(indexName, { vector | input, embed,
namespace, topK })` against the real binding. Returns ids + scores only
   (`returnMetadata: "none"` — the reader never trusts Vectorize's stored
   metadata as the row; see "Why re-hydrate instead of trusting metadata"
   below).
2. **Re-hydration through the existing policy-aware read path** — take the
   ordered id list and call the table's own `findMany({ where: { id: { in:
ids } } })`. This is the **actual** `ctx.db.<table>.findMany` used by every
   other reader, not a new SQL path — geo/search can push RLS's
   `scopeCondition` straight into their own SQL because they scan the shard's
   local SQLite (`ctx-db.ts:845-847`, `runGeoTerminalScored`/its search twin);
   vector matches can't do that because the match happens _outside_ SQLite, so
   the reader re-enters the standard row-fetch instead of inventing a parallel
   RLS implementation. Any id RLS would reject is silently absent from
   `findMany`'s result — same behavior a caller already relies on everywhere
   else in the facade.
3. **Re-order + zip scores** — `findMany` returns rows in no particular order;
   the reader re-orders them to match step 1's rank (best match first) and
   zips in each row's `score` from the match list, dropping any id that step 2
   didn't return (RLS-rejected, or the row was deleted after the vector match
   but before hydration — see "Consistency" below, this is the same kind of
   staleness, just from the opposite direction).

### Why re-hydrate instead of trusting Vectorize metadata

`.vectorize()`'s `metadata` option mirrors selected fields into Vectorize for
_filtering_ (`options.metadata?: ReadonlyArray<keyof Shape & string>`,
`schema.ts:55`) — it is not a cache of the row and is never guaranteed
complete, current, or even present (an app may declare no metadata fields at
all). Returning matches straight from Vectorize metadata would mean: no RLS,
stale data on any row updated after the vector last synced, and a hard
dependency on the app remembering to mirror every field the caller might want
back. Re-hydrating via `findMany` gets RLS, freshness, and the full row for
free — the cost is one extra round-trip per query, paid once per `.near()`
call, not per row.

## Score semantics — reuse 236, but note the metric wrinkle

`SearchReader.collectWithScores()` returns `{ document, score }` (relevance,
descending — `data-model.ts:304-317`). `GeoReader.collectWithScores()` returns
`{ distanceMeters, document }` (physical distance, ascending —
`data-model.ts:346-360`) because a geo match is a real distance, not an
abstract score. Vectorize's own match record is already shaped `{ id, score,
metadata? }` (`packages/platform/src/bindings.ts:237-243`) — so the vector
reader's `collectWithScores()` reuses **`SearchReader`'s shape and field name**
(`{ document, score }`), not geo's `distanceMeters` — this is the "236's score
field name" the plan asks to confirm, and it is the natural fit since Vectorize
already calls it `score`.

**Wrinkle confirmed against Cloudflare's Vectorize docs**: score directionality
is **metric-dependent**, unlike search (always higher-is-better) or geo (always
lower-is-better):

| `.vectorize()` metric | Interpretation                       |
| --------------------- | ------------------------------------ |
| `cosine`              | higher = closer (1.0 = identical)    |
| `dot-product`         | higher = closer                      |
| `euclidean`           | **lower = closer** (0.0 = identical) |

`collect()`/`take()`/`first()` must sort using a comparator keyed off the
index's declared `metric` (already present on `TableVectorIndex`/
`VectorIndexDefinition` — no new schema field needed) — descending for
cosine/dot-product, ascending for euclidean. `collectWithScores()` exposes the
raw `score` as Vectorize returns it (not normalized to a single direction) so a
caller reading the score already knows which index they queried and thus which
direction it runs; normalizing would silently disagree with what
`ctx.vectors.query()` returns directly, which is worse than documenting the
per-metric rule once here.

## Async-index consistency contract

Confirmed from Cloudflare's own Vectorize documentation: **insert/upsert/delete
return immediately but a written vector is not queryable for roughly 5-10
seconds.** This is not a corner case — it's every write, every time, on every
target. State it, don't hide it:

- `.near()` against a row inserted or updated in the same request (or the
  last few seconds) may not return that row yet, even though `findMany`
  against the same table would show it immediately (SQLite commits are
  synchronous; Vectorize's index is not). This is a **read-your-writes gap
  specific to the vector path** — every other reader in the facade (including
  geo/search, which live in the shard's own SQLite) is read-your-writes
  consistent within a DO; the vector reader is the first one that is not.
- The reader does not hide this behind a retry/poll loop — that would turn a
  5-10s Vectorize propagation delay into a 5-10s added request latency for
  every caller, most of whom don't need read-your-writes on this path (RAG
  retrieval over a corpus that isn't being edited mid-conversation is the
  common case). Instead: **document the contract on `withVectorIndex()`'s
  JSDoc directly** ("a row written in this transaction may not appear in this
  reader's results for a few seconds") so it's visible at the call site, not
  buried in an errors doc.
- A caller that genuinely needs read-your-writes on a freshly-written row
  (e.g. "show the user their own new document immediately") should read it
  through the normal `findMany`/`get` path (by id, or by whatever field the
  app already has), not through `.near()` — the vector reader is for semantic
  _discovery_ over the corpus, not for confirming a specific write landed.
- This composes with hydration's own staleness direction (a row deleted
  _after_ a stale Vectorize sync still queryable but _before_ the delete's
  own sync-hook removal completes) — both directions collapse to "a
  `.near()` result set is a best-effort snapshot, verify freshness by reading
  the hydrated row's own fields if it matters," which the design leans into
  rather than trying to paper over with synchronous consistency it cannot
  actually provide.

## Tenant-scoping boundary — the load-bearing section

**The namespace filter is real and does thread through the binding on both
sides.** `packages/bindings/src/vectors/types.ts`'s `LunoraVectors.query`/
`upsert` both accept `namespace?: string` end to end down to the raw
`VectorizeIndexLike.query`/`upsert` calls
(`packages/bindings/src/vectors/create-vectors.ts:69-130`). So a reader _can_
be namespace-scoped today — no missing Vectorize API. The design:

- `withVectorIndex()` requires a namespace derivation from the table's own
  shard/RLS scope, the same way RLS derives `scopeCondition` for every other
  reader — **not a free-text `namespace` argument the caller can omit or
  spoof.** Concretely: the reader resolves the query's Vectorize `namespace`
  from the same scope key the shard/RLS layer already computes for this
  request (the shard key on a `.shardBy()` table, or the RLS policy's tenant
  column) — the caller writes `.near(vector)`, not
  `.near(vector, { namespace: "whatever i want" })`.
- **Fail loud, not silent, on the unscoped case.** A table with no shard key
  and no RLS tenant scope declared has no namespace to derive — that's the
  single-tenant case, and it's legitimate, but it must be an explicit opt-in
  (mirrors `createVectorSyncHook`'s existing `allowSharedNamespace` escape
  hatch on the write side — `context.ts:192,224,318`) rather than a value that
  silently comes back `undefined` and searches the whole account-global index.
  Recommendation: `withVectorIndex()` throws at call time (not a console
  warning) if the table declares sharding/RLS but the reader can't resolve a
  scope key, unless the schema explicitly opts out
  (`.vectorize(field, { allowSharedNamespace: true })` or table-level
  equivalent) — this is stricter than the write side's current warn-only
  behavior, deliberately: a read-side leak surfaces someone else's data in a
  response payload, which is worse than a write-side leak that merely makes
  the index queryable cross-tenant with no observer yet.
- **Defense in depth, independent of the namespace filter.** Step 2 of the
  read pipeline (hydration via `findMany`) is _already_ RLS-scoped
  independently of whatever the Vectorize namespace filter did. So even if the
  namespace filter were misconfigured or bypassed, a cross-tenant id returned
  by Vectorize would still be silently dropped at hydration because the
  caller's RLS policy would not admit that row. **This is the same two-layer
  structure the prototype tests below prove**: the namespace filter is the
  cheap, index-side rejection; RLS-scoped hydration is the row-level backstop
  that holds even if the first layer is wrong. Both layers matter — the
  namespace filter avoids paying to return/rank rows nobody should see (and
  avoids leaking existence/similarity, which even bare ids + scores can do,
  per `context.ts`'s own `warnSharedNamespace` doc comment); hydration is what
  actually prevents the leak reaching the caller if the first layer fails.

### Critical finding: the write side does not actually thread a namespace today

This is a **report, not a blocker for this spike**, but it changes how
seriously the tenant-scoping design above needs to be taken before
`withVectorIndex()` ships for real: `packages/codegen/src/emit.ts:4420` (the
only production call site of `createVectorSyncHook`) calls it as
`createVectorSyncHook({ schema, vectors })` — **no `namespace` argument.**
`createVectorSyncHook` accepts one (`context.ts:237`) and its own doc comment
is explicit that omitting it means "a multi-tenant sharded app has NO isolation
between tenants in the vector index" — but nothing in the generated DO
currently supplies one. The only mitigation today is
`warnSharedNamespace`'s one-time-per-process `console.warn`
(`context.ts:178-194`), which:

- fires once per index name per process, so it is trivially missed in
  production logs;
- does not fail the write, so a sharded app ships and works "fine" (every
  shard's vectors land in one flat, cross-tenant-queryable index) until
  someone builds a reader over it — **which is exactly what this plan is
  proposing to do.**

**Consequence for shipping `withVectorIndex()` for real (not this spike):** a
correctly-namespace-scoped _reader_ querying an _unscoped_ write path buys
nothing — every row was written to the same (absent) namespace regardless of
which tenant wrote it, so the reader's namespace filter has nothing to
partition on and either returns everyone's rows (namespace omitted, matching
today's write behavior) or returns nobody's rows (namespace supplied, matching
zero of the unscoped writes). The write-side gap
(`emit.ts:4420` not passing `namespace`) has to close **before or alongside**
`withVectorIndex()`'s codegen wiring — the reader's own tenant-scoping design
above still holds and is still correct, but its safety is currently backstopped
_only_ by the hydration layer (layer 2), not by the namespace filter (layer 1),
until that write-side wiring is fixed. Flagging this now because it's the kind
of gap that's cheap to close before a reader exists to expose it, and expensive
to discover after.

## Text-vs-vector input (`.near(vectorOrText, ...)`)

`.near()` accepts either a precomputed `ReadonlyArray<number>` or a `string`.
Recommendation, grounded in what the schema already requires:

- **No new coupling to `@lunora/ai` or `ctx.ai`.** `.vectorize(field, opts)`
  and `defineVectorIndex(opts)` already require an `embed: VectorEmbedder`
  (`(input: string) => vector`) at schema-declaration time
  (`packages/server/src/schema.ts:51`, `:271`) — every declared vector index
  already owns an embedder. `.near("some text")` reuses **that same declared
  embedder** to turn the string into a vector before querying Vectorize;
  `.near(precomputedVector)` skips embedding entirely. Neither path touches
  `ctx.ai` or introduces a new dependency edge from `@lunora/server` onto
  `@lunora/ai` — `@lunora/ai/rag` is a _consumer_ of this pattern (its own
  `RagEmbedder` is structurally the same shape, see
  `packages/ai/src/rag/types.ts:11`), not a required collaborator.
  `@lunora/ai`'s `embeddingModel` resolution (Workers AI model ids via
  `ctx.ai`, or bring-your-own AI SDK `EmbeddingModel`) stays exactly where it
  is today — a convenience `defineRag` offers on top, not something the base
  reader needs.
- This mirrors how the write-sync hook already treats `embed` — it's schema
  data, not a request-time dependency.

## Prototype

`packages/bindings/__tests__/vectors/vector-reader-spike.test.ts` (test-only,
not wired into any package's public exports). Placed here rather than in
`@lunora/ai` or `@lunora/server`'s test suites because
`@lunora/bindings/vectors` is where the real `createVectors` binding and the
realistic structural `VectorizeIndexLike` fake already live (mirrors
`packages/bindings/__tests__/vectors/end-to-end.test.ts`'s existing
"upsert -> query end-to-end against a structural Vectorize fake" pattern,
which is the same harness `@lunora/ai/rag` runs its own tests against via
`createContextVectors`). No `@lunora/server`/`@lunora/ai` code changed or
depended on by the prototype.

The prototype implements the 3-stage read pipeline above as a local function
(`withVectorIndexPrototype`), exercising:

1. **Real `createVectors`** (`packages/bindings/src/vectors/create-vectors.ts`)
   over a stateful `VectorizeIndexLike` fake with real namespace-scoped storage
    - cosine scoring (same shape as the existing end-to-end fixture — a fresh,
      self-contained copy in the new test file rather than an import, so the spike
      doesn't create a cross-test-file dependency).
2. **A policy-aware document store fake** — a small in-memory table with a
   `tenantId` column and a `findMany`-shaped lookup that filters by both `id
IN (...)` _and_ `tenantId === callerTenant`, standing in for RLS-scoped
   `findMany`. This is what step 2 of the pipeline calls.
3. **Two tenants' worth of data in the same fake Vectorize index** — mirrors
   "Vectorize is account-global" from `define-rag.ts:52-59` and this doc's
   tenant-scoping section: tenant A and tenant B's rows live in one index,
   distinguished only by `namespace`.

### What it asserts

- **Hydrated, ordered, scored results for a same-tenant query**: querying
  tenant A's namespace with a tenant-A-relevant text returns tenant A's rows,
  hydrated to full documents (not bare Vectorize metadata), ordered
  best-match-first, each paired with its `score`.
- **The load-bearing test — cross-namespace-no-leak**: tenant B is seeded with
  a document deliberately constructed to be the _closest possible match_ to
  tenant A's query text (near-identical wording) — a weak version of this test
  could pass by accident if tenant B's data just happened to score low.
  Querying tenant A's namespace asserts tenant B's near-perfect-match id is
  **absent** from the result set, even though it would rank #1 if namespace
  scoping silently no-op'd. This proves the namespace filter (pipeline stage
    1. actually partitions, not just that "some filtering exists somewhere."
- **Defense-in-depth, independently**: a second variant calls the hydration
  stage directly with an id list that includes a cross-tenant id (simulating
  "the namespace filter was somehow bypassed") and asserts the RLS-shaped
  `findMany` fake still refuses to return the other tenant's row — proving
  layer 2 holds even if layer 1 didn't, matching the design's two-layer claim
  above.

### Pass/fail

All four assertions pass — see the FILES CHANGED / test run below. `pnpm
--filter "@lunora/bindings" run test -- vector-reader-spike` is the direct
command; `@lunora/ai` and `@lunora/server`'s suites plus
`@lunora/server`'s `lint:types` also verified untouched-and-green per the
plan's COMMANDS, since the prototype changes neither package.

## Open questions (STEP 3)

1. **Codegen wiring for the facade type.** `VECTOR extends Record<keyof DM,
string>` needs to join `GEO`/`SEARCH`/`RANK` as a fifth type parameter on
   `TableReaderFacade`/`TableWriterFacade`, threaded through
   `packages/codegen/src/emit.ts`'s dataModel emission the same way
   `discover-vector-namespace-accesses.ts` already discovers vector index
   usage for capability-gating today. Out of scope here.
2. **Write-side namespace wiring is a prerequisite, not a nice-to-have** — see
   "Critical finding" above. `emit.ts:4420` needs to pass a real
   `namespace` (shard key / RLS tenant column) to `createVectorSyncHook`
   before `withVectorIndex()` ships, or the reader's tenant-scoping design is
   only as safe as the hydration backstop, not the namespace filter it's
   supposed to lean on primarily.
3. **The "fail loud on unscoped" throw** needs a concrete opt-out DSL shape —
   this doc recommends mirroring `allowSharedNamespace` but doesn't design the
   schema-level surface (table option? index option? both, like the write
   side's inline-vs-standalone split?).
4. **`define-rag.ts` refactor onto the new reader** is a real follow-up once
   `withVectorIndex()` ships — `hydrateFromStore`
   (`define-rag.ts:637-670`) duplicates most of pipeline stage 2/3 today,
   including its own text-store/lexical-store hybrid ranking on top, which the
   base reader deliberately does not attempt (RAG's hybrid rank is a
   RAG-specific feature, not a base-reader one).
5. **RLS interaction with an account-global index at scale**: this design's
   hydration-as-backstop works correctly but pays a `findMany(... id IN
(...))` round-trip per `.near()` call in addition to the Vectorize
   round-trip — for a `topK: 100` query that's a 100-row `IN` lookup. Probably
   fine (same cost shape geo/search already accept), but not benchmarked here.
6. **Consistency UX**: should `withVectorIndex()` expose anything (an
   `asOf`/staleness hint, a way to force a synchronous re-embed-and-compare
   fallback for a single just-written row) or is "document it, don't hide it"
   (this doc's recommendation) sufficient? No user research behind this yet.
