# Plan 365 — Rebuild the delta-sync read path: metadata scan first, hydrate last

**Baseline:** `d18ccd9` (2026-08-19)
**Status:** DONE (W1–W6 shipped; see the per-workstream notes in §5)

Prompted by [Linear's "Rebuilding Linear's delta sync read path"](https://linear.app/now/rebuilding-delta-sync-read-path)
and [turbopuffer's architecture](https://turbopuffer.com/docs/architecture), read
against our op-log/shape path. Neither is a product we should adopt; both describe
a **shape of read path** we do not have.

## 0. Headline finding

**Every delta-sync read we serve hydrates the full post-image JSON of every change
in the range before it decides which changes the caller may see.** The op-log
carries fat rows (`doc` = the whole document, `ctx-db-cdc.ts:62`), and every reader
`SELECT`s and `JSON.parse`s that column unconditionally (`ctx-db-cdc.ts:82`), even
when the question is metadata-only. Three consequences, all worsening with time
rather than with load:

1. **The subscription resume check decodes up to 10 000 documents to answer a
   set-membership question.** `shard-do.ts:2706` reads `CDC_RESUME_SCAN_LIMIT`
   (10 000) rows _with docs_ purely to evaluate `changes.some((c) => readSet.has(c.table))`.
   Past that cap it gives up and forces a **full snapshot** (`shard-do.ts:2711`) —
   so the client most in need of a cheap delta (offline a few hours) is precisely
   the one that gets the whole query re-sent.
2. **`__cdc_log` has no index and no retention.** `migrateCdcLog`
   (`ctx-db-cdc.ts:44`) creates `(seq PK, ts, table, id, op, doc)` and nothing
   else, while the shape path filters `table IN (…)` (`ctx-db-cdc.ts:82`) — a
   seq-ordered scan that reads and discards other tables' rows, which is verbatim
   the cost Linear describes Postgres paying. `trimCdcChanges` exists, is exported
   (`ctx-db-cdc.ts:118`), and **is never called by `ShardDO`** — the log grows for
   the lifetime of the shard, inside a 10 GB DO. `ctx-db-shape-poke-cursor.ts:10-18`
   already documents this as "a real, worsening-over-time cost cliff, not a
   one-time cold start" and fixes only the cursor half of it.
3. **A `.global()` shape re-downloads its entire membership from D1 every 2
   seconds, per socket.** `refreshGlobalShape` (`shard-do.ts:8981`) calls
   `readGlobalShapeRows`, whose generated body (`codegen/src/emit.ts:4660`) drains
   **every page** of `findMany` up to a 50 000-row cap (`shard-do.ts:962`), on a
   2 s alarm (`shard-do.ts:948`), once per socket per shape. There is no delta path
   at all — even though the global store **already writes a `__cdc_log`**
   (`sql-store/src/ctx-db.ts:871,1041`) with a reader (`readSqlCdcChanges`,
   `sql-store/src/ctx-db.ts:924`) that nothing on this path calls.

The fix is the one Linear landed: **a two-stage pipeline — a compact metadata scan,
then late enrichment** — plus the indexing and compaction that make the metadata
tier cheap. It is all local work; no new dependency, no external index.

## 1. Current state (audit)

### 1.1 The op-log

| Concern     | Today                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Row shape   | `seq INTEGER PK AUTOINCREMENT, ts, table, id, op, doc TEXT` — `doc` is the full post-image (`ctx-db-cdc.ts:44`)              |
| Indexes     | none beyond the `seq` PK (`ctx-db-cdc.ts:44`)                                                                                |
| Reader      | `readCdcChanges` always selects + `decodeDocJson`s `doc`; optional `table IN (…)` filter, page ≤ 10 000 (`ctx-db-cdc.ts:82`) |
| Retention   | `trimCdcChanges` never invoked from `ShardDO` — unbounded growth (grep: only tests + doc comments reference it)              |
| Epoch/floor | `readCdcEpoch` / `minCdcSeq` gate resumability (`ctx-db-cdc.ts:152`) — correct, and untouched by this plan                   |

### 1.2 Query-subscription resume (`shard-do.ts:~2640-2717`)

Resumable iff no table in the query's read-set changed since `sinceSeq`. Implemented
by materializing the changes and testing `.some()`. Cost is O(changes since the
client's cursor) in **rows and JSON parses**, for a boolean answer; the 10 000 cap
converts a long-offline client into a full re-snapshot.

### 1.3 Shape (partial-replication) diff

`buildShapeDiff` (`shard-do.ts:8874`) is already the right _algorithm_ — drain the
range, collapse to the latest op per row id, one membership probe over the changed
ids (`selectShapeMemberIds`, `ctx-db-shapes.ts:105`), upsert members / delete the
rest. Three costs sit on top of it:

- **Hydration happens first, filtering second.** `readShapeOpRange`
  (`shard-do.ts:8821`) drains pages of 1 000 rows _with docs_, decoding N documents
  to keep the M ≤ N that survive the membership probe; `projectColumns` then throws
  away most fields of the survivors anyway.
- **The membership probe is per socket.** `collectShapePokeParts`
  (`shard-do.ts:8766`) runs one `selectShapeMemberIds` per shape per socket. The
  flush-local `opRangeCache` (`shard-do.ts:8669`) collapses the _op read_ across
  sockets but deliberately not the probe — yet the probe's inputs are
  `(table, effectiveWhere, ids)`, and `effectiveWhere` is identical for every
  socket resolving the same shape with the same args and the same RLS outcome. 200
  sockets on one public shape run 200 byte-identical `SELECT id … WHERE id IN (…)`
  queries per flush.
- **The drain is unbounded above.** `readShapeOpRange` pages until `cursor >= upTo`
  but `readCdcChanges` takes no upper bound, so the final page reads past `upTo`
  and those rows enter the diff while the poke is stamped at `upTo`. Benign today
  (both callers pass the current head, and the diff is synchronous) but it is an
  invariant held by luck, not by SQL.

### 1.4 `.global()` shapes

Full membership re-read per socket per 2 s tick (§0.3), diffed in memory against a
per-socket JSON snapshot in `__global_shape_snapshot`
(`ctx-db-global-shape-snapshot.ts`). Cost per tick is
O(sockets × shapes × membership) **network rows from D1**, independent of how much
actually changed. The 50 000-row cap is what stands between this and an outage; a
shape that crosses it fails closed (`shard-do.ts:8952`).

## 2. Existing seams (do not reinvent)

- `readCdcChanges` / `minCdcSeq` / `readCdcEpoch` / `trimCdcChanges`
  (`shard-engine/src/ctx-db-cdc.ts`) — the op-log API. Add a metadata-only reader
  **beside** `readCdcChanges`; do not fork it.
- `readShapeCdcPage` (`shard-do.ts:8860`) — the existing protected seam over the
  changelog read that tests count. New readers go through it.
- `opRangeCache` (`shard-do.ts:8669`) — the per-flush memo. Widen its key; do not
  add a second cache.
- `__shape_poke_cursor` (`ctx-db-shape-poke-cursor.ts`) + `ownerFloor()`
  (`shard-do.ts:1663`) — the durable per-subscription baselines. These are exactly
  the "lowest durable consumer cursor" a retention sweep must not trim past.
- `readSqlCdcChanges` / `appendSqlCdcChange` (`sql-store/src/ctx-db.ts:924,1041`),
  re-exported through `@lunora/d1` — the global tier's changelog, already written,
  never read by the shape path.
- Retention precedent: `observability/src/request-log.ts:398` and
  `shard-engine/src/audit-log.ts:92` both trim a reserved log by `seq` against an
  env-configured cap. Copy that pattern, do not invent a third.
- `createIndexIfNotExists` (`sql-store/src/sql-exec.ts`, used at `sql-store/src/ctx-db.ts:860`) and the DO-side
  `CREATE INDEX` scaffold in `do-sql.ts` — index creation already has a home.
- `packages/do/__bench__/shared.ts` + `broadcast-delta.bench.ts` — the harness the
  new benches extend.

## 3. The behavioural contract to preserve

Stated so a test can assert each one:

1. **Wire format is unchanged.** `pokeStart`/`pokePart`/`pokeEnd`, `RowOp`,
   `cursor`/`epoch`/`baseCheckpoint` semantics stay byte-identical —
   `protocol/fixtures/ws-frames.json` and every SDK conformance suite must pass
   untouched (`bash sdks/run-all.sh`).
2. **Same row-ops, same order.** For any `(shape, sinceSeq, upTo)`, the new
   two-stage pipeline emits the same set of `RowOp`s as `buildShapeDiff` does
   today, with `insert`-that-never-matched still emitting nothing and any
   non-`insert` non-member still emitting a `delete` (`shard-do.ts:8905-8912`).
3. **Baselines only ever degrade downward.** The memo/cursor fallback chain
   (in-memory → `__shape_poke_cursor` → subscribe-time `sinceSeq` → 0) keeps its
   direction; a retention sweep may only make `canResume` _false_, never true.
4. **Resume is never widened.** `resumable` must stay false in every case it is
   false today except the one this plan deliberately fixes: an empty read-set is
   still non-resumable, an epoch mismatch is still non-resumable, a retention gap
   is still non-resumable. Only "more than 10 000 changes accumulated" flips.
5. **Hydration reads a value the caller may see.** Late enrichment must read the
   post-image through the same predicate the membership probe applied — no path
   may return a document for a row the probe excluded.
6. **`api:check` and `dist:check` stay green.** The new op-log reader is internal
   to `@lunora/shard-engine`; if it lands on the public barrel the snapshot moves
   and `pnpm run api:update` runs **after** a fresh build.

## 4. Design decisions

**D1 — Two-stage (metadata → enrich), not a wider index.**
Chosen over adding covering indexes so the existing one-stage scan gets cheaper.
The scan is expensive because of _what it carries_, not how it is found: a range
of 100 000 ops on a table with 2 KB documents is ~200 MB of JSON to answer "which
50 keys changed". Narrowing the payload is a bigger constant-factor win than any
index on the fat table, and it composes with D2.

**D2 — Index `(table, seq)`, not `(table)` or a partial index.**
The only shape of query the log serves is `WHERE table [IN …] AND seq > ? ORDER BY
seq`. `(table, seq)` covers both the filter and the ordering; `(table)` alone
leaves the sort. Rejected: a partial index per subscribed table (unbounded DDL
driven by client behaviour).

**D3 — Retention floor from durable cursors, not a fixed age.**
Trimming by wall-clock age can compact away a range a live subscription still
needs (correctness), while trimming only at the consumer floor can never advance
if one socket is stuck (liveness). Take `min(ownerFloor(), all __shape_poke_cursor
rows)` **and** an absolute cap (`LUNORA_CDC_LOG_RETENTION`, mirroring
`LUNORA_REQUEST_LOG_RETENTION`); when the cap wins, the honest outcome is that
those subscriptions lose resumability and re-seed — which `minCdcSeq` already
detects and `computeOpLogShapeSeed` already handles.

**D4 — Compact the doc, keep the key: a two-tier log, not two tables.**
Linear's head/tail split (small authoritative head in Postgres, long history in
turbopuffer, overlapping ranges deduped by id) has a single-store analogue: the
retention sweep **nulls `doc`** instead of deleting the row, keeping
`(seq, table, id, op)` for far longer than the payload. A client past payload
retention then still gets an exact key-level delta — "these ids changed, these
were deleted" — and the survivors hydrate from the **current table**, which is
where the shape path reads them from anyway after D1. That converts today's
all-or-nothing "full re-seed" into a graceful degrade, which is the actual user
win of Linear's post. Rejected: a separate `__cdc_meta_log` table (double writes on
the hot mutation path, two logs to keep in sync).

**D5 — Key the flush cache by the resolved predicate, not by the socket.**
`(table, serialized effectiveWhere, columns, idSet)` is the true identity of a
membership probe. Sockets whose resolve produces a byte-identical predicate share
one probe per flush. Requires a stable serialization of `effectiveWhere` —
`shared/stable-key.ts` already exists for exactly this and is already inlined by
`@lunora/do`. Rejected: caching across flushes (the id-set changes every flush;
a stale hit silently drops rows).

**D6 — Serve `.global()` shapes from the global `__cdc_log`; keep full re-read as
the fallback.** This is Linear's fallback discipline verbatim: when the secondary
path cannot cover the requested range (cursor below the global log's floor, CDC
disabled on the global store, an unavailable read) fall back to the full-membership
read that exists today. Overlap-and-dedupe by row id makes the switchover safe
under replication lag, which on D1 is real and on Hyperdrive/PlanetScale more so.
Rejected: making the global path poke-live off write notifications — `.global()`
tables are written from other shards and other regions; polling a durable log is
what makes it correct without a coordinator.

**D7 — No external search/index service.** turbopuffer earns its place at Linear's
scale because the candidate range is a cross-tenant, permission-filtered
intersection over 20 TB in one Postgres. Our equivalent range is already
partitioned to one Durable Object per shard — **we get namespace-per-tenant
isolation from sharding**, which is the property Linear buys with a namespace per
workspace. What we do not have is their _indexing and compaction discipline inside_
that namespace, and that is what this plan adds. Revisit only if `.global()` at the
50 000-row cap becomes the dominant topology; record it as an open question, not a
workstream.

## 5. Workstreams

Each is independently shippable and independently measurable. W1/W2 are the cheap
half of the win; W6 is the largest but touches the least-used tier.

**W1 (S) — Metadata-only resume probe. Done.**
Add `cdcTouchesTables(sql, sinceSeq, tables): boolean` to `ctx-db-cdc.ts`:
`SELECT 1 FROM __cdc_log WHERE seq > ? AND "table" IN (…) LIMIT 1`. Replace the
10 000-row scan at `shard-do.ts:2706` with it and **delete `CDC_RESUME_SCAN_LIMIT`**
along with the cap-hit branch. Read-set-empty and retention-gap branches are
untouched (contract §4). Net effect: an offline-for-hours client resumes instead of
re-snapshotting, and the check becomes an index probe (with W2) instead of a decode.

**W2 (S) — `CREATE INDEX IF NOT EXISTS __cdc_log_table_seq ON __cdc_log("table", seq)`**
in `migrateCdcLog`, plus the same on the `sql-store` twin in `runSqlCdcMigration`
(needed by W6). Verify with a query plan assertion in the DO tests, not by timing.
**Done.** Both indexes ship; the plan assertion is
`shard-do.delta-read-path.test.ts` → "plans the table-filtered changelog read
through the (table, seq) index", which asserts the index by name AND the absence
of a `SCAN __cdc_log`.

**W3 (M) — Two-stage shape diff.**
Split `readShapeOpRange` into:

- `readShapeOpKeys(sql, table, sinceSeq, upTo)` →
  `SELECT id, MAX(seq) AS seq, … FROM __cdc_log WHERE "table" = ? AND seq > ? AND seq <= ? GROUP BY id`
  — no `doc`, no JSON, one row per changed key, and the `seq <= upTo` bound that
  §1.3 says is missing today.
- membership probe over those ids (unchanged, `selectShapeMemberIds`).
- `hydrateShapeRows(sql, table, ids, columns)` — read post-images for survivors
  only, projecting in SQL where `columns` is set rather than decoding whole
  documents and calling `projectColumns` after.
  `buildShapeDiff` keeps its signature and its op-selection rules (contract §2).

**Done, and simpler than planned: stages two and three fused.** `selectShapeMemberIds`
(id-only) became `selectShapeMembers`, which returns each surviving row's document
from the same `SELECT` that tests its membership. Hydration is therefore not a
third read at all — and it settles a smaller inconsistency the plan had not
noticed: the old diff took a row's VALUE from the op-log post-image while taking
its MEMBERSHIP from the table, two sources for one row. Both now come from the
read the predicate filtered. `readShapeCdcPage` became `readShapeCdcKeys` (the
protected seam tests count), and the `seq <= upTo` bound §1.3 flagged as missing
is now in the SQL. Measured in `__bench__/shape-diff-catchup.bench.ts`: at a
constant 200-row key set, a 20x longer range costs ~5.4x rather than 20x, and the
selectivity axis (1% -> 100% of a fixed range in the shape) is now what dominates.

**W4 (S) — Share the membership probe across sockets. Done.**
The flush-local cache became `ShapeDiffCache` (`shard-engine/src/shape-diff-cache.ts`),
memoizing both the changed-key scan by `(table, sinceSeq, upTo)` and the probe by
`(table, stableWireKey(effectiveWhere), idSet)`; key parts are length-prefixed
rather than separator-joined so two different probes cannot collide. `getFanoutMetrics`
grew `shapeProbe: { run, served }`, mirrored in the Studio's admin types and
rendered on the fan-out panel. Five sockets on one predicate now run one query
(`run: 1, served: 4`, asserted); five on distinct predicates still run five.

**W5 (M) — Op-log retention + payload compaction. Done, with one decision the plan
left open (Q3) answered against its own preference.** The sweep runs at the end of
the coalesced flush drain (not the alarm — that is where every consumer has just
advanced its cursor, so the floor is highest), throttled to once a minute per warm
instance. `LUNORA_CDC_PAYLOAD_RETENTION` compacts payloads, `LUNORA_CDC_LOG_RETENTION`
deletes rows, and **both default to off**: the log's out-of-shard consumers hold
opaque cursors issued by the Worker (`runtime/src/connector-cdc.ts`), so a floor
computed only from what SQLite can see would silently drop rows a warehouse
connector had not read. Enabling either still never crosses the in-shard floor
(`minShapePokeCursor`). W3 removed the hydration dependency on post-images
entirely, so `minCdcDocSeq` ended up serving a different and more important
purpose: `runShardCdcSync` now refuses a range below the retained payload floor
with `CDC_PAYLOAD_COMPACTED` rather than serving doc-less rows a change feed would
read as deletes.

**W6 (L) — `.global()` shape delta path. Done, scoped to table granularity rather
than row granularity.** `DatabaseWriterLike` grew an optional
`cdcChangedTables(sinceSeq)`, implemented once in `@lunora/sql-store` (so D1 and
Hyperdrive/global both inherit it) and forwarded by a codegen-emitted
`readGlobalChangedTables` override. Each poll tick asks it once for the whole
shard; a shape whose table is absent from the answer skips its membership read
entirely, which is the steady state. What did NOT ship is per-row global deltas:
membership still comes from a full read when a table did move, because that keeps
`diffGlobalMembership` and the 50 000-row cap exactly as they were. Two guards the
plan did not anticipate:

- **A resync interval** (`GLOBAL_SHAPE_RESYNC_MS`, 30s). A `.global()` table can be
  written by something that is not this deployment, and such a write leaves no row
  in our changelog. Trusting it forever would freeze a shape silently, so the skip
  is bounded: worst case 30s of staleness for an invisible write, against a full
  re-read of every shape on every socket every 2s.
- **The per-tick read cache is keyed by identity as well as predicate.** This is
  the one place the op-log path's reasoning does NOT carry over, and it is a
  security property rather than a nicety: a `.global()` read goes through a writer
  the application builds per caller from `{ identity, userId }`, so equal
  predicates do not imply equal rows and sharing across identities would hand one
  user another's rows. Pinned by
  `shard-do.global-shape.test.ts` → "never shares one tick's global read between
  two identities". Sockets of the same user, and of anonymous/public shapes — where
  the fan-out actually is — still share.

## 6. Platform parity

**Not applicable.** No `ctx.*` surface, provider binding, or deploy/runtime
capability changes: this is engine-internal read-path work behind the existing
shape/subscription contracts. `PlatformCapabilities` is unchanged, and the
`@lunora/platform` contracts (`ShardHost`, `ShardDirectory`) are untouched — W1–W5
run entirely through `SqlExec`, and W6 through the existing global-backend seam, so
`@lunora/platform-node` inherits the same behaviour without a new host method.

## 7. Phasing & ordering

| Phase | Work    | Gate                                                                                                                                                                      |
| ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | W2      | Query-plan assertion shows the `(table, seq)` index used by the shape read; `pnpm --filter "@lunora/do" run test` green                                                   |
| 1     | W1      | New test: 20 000 changes since `sinceSeq` on an untouched read-set ⇒ `resumable: true` (today: `false`). `CDC_RESUME_SCAN_LIMIT` no longer exists                         |
| 2     | W3 + W4 | New `packages/do/__bench__/shape-diff-catchup.bench.ts` shows docs-decoded scaling with survivors, not with range size; poke frames byte-identical vs golden              |
| 3     | W5      | Sweep test: a live subscription's `__shape_poke_cursor` is never trimmed past; a client below the payload floor still gets a key-level delta, not a re-seed               |
| 4     | W6      | Global-shape test: N sockets on one shape ⇒ **one** global read per tick; a cursor below the global log floor falls back to full re-read and produces an identical rowset |
| 5     | all     | `pnpm run test`, `pnpm run lint:types`, `pnpm run api:check`, `bash sdks/run-all.sh` (wire unchanged), `pnpm run e2e`                                                     |

## 8. Risks & STOP conditions

- **STOP** if W3's hydration cannot read a post-image through the same predicate
  the probe applied (contract §5) — a two-stage pipeline that hydrates outside the
  filter is an RLS bypass, and that is a different, security-reviewed plan.
- **STOP** if W5's floor computation cannot see every durable consumer. Trimming
  past a live cursor silently drops rows; if a consumer's cursor is not
  discoverable from SQLite, do not trim at all — compact `doc` only (D4), which is
  safe because a missing payload degrades to re-hydration, never to a lost row.
- **Risk:** the `.global()` fallback (W6) masks a broken delta path — the two
  sources would agree and nobody notices the fast one never runs. Mitigate: count
  fallbacks in `getFanoutMetrics` and assert in tests that the delta path served the
  steady-state tick.
- **Risk:** replication lag on the global tier makes a cursor-driven read miss a
  row committed but not yet visible. Mitigate: overlap the requested range by a
  configurable margin and dedupe by row id (D6) — Linear's exact remedy.
- **Perf watch:** add `packages/do/__bench__/shape-diff-catchup.bench.ts` (range
  size × document size × survivor count) and `cdc-resume-probe.bench.ts` (changes
  since cursor). Both must show flat-in-range-size behaviour after W1/W3 —
  the "flat tail as the range grows" property Linear reports is the target, and
  a bench that only measures small ranges cannot show it.

## 9. Open questions (answer during execution)

1. Does any consumer outside the shape/subscription paths depend on `doc` surviving
   in old op-log rows? (Streaming export and PITR replay both read it —
   `applyCdcChanges`, `ctx-db-cdc.ts:254`. If PITR is enabled, W5's payload
   compaction must be gated off, and D4's degrade path must be the only tier that
   ships for those apps.)
2. What is the real distribution of `effectiveWhere` across sockets in a live app?
   W4's win is exactly the duplicate-predicate rate. Shipped rather than dropped,
   because the answer is now MEASURABLE in production instead of guessed:
   `getFanoutMetrics.shapeProbe` reports run-vs-served per deployment, and the
   Studio renders it. A deployment where `served` stays near zero has genuinely
   per-identity predicates — a real answer, not a misconfiguration.
3. ~~Should `LUNORA_CDC_LOG_RETENTION` default to unbounded or bounded?~~
   **Answered: unbounded (opt-in).** Not out of caution — because the log has
   consumers whose cursors provably cannot be seen from the shard (a warehouse
   connector's opaque token), so a default floor would be a guess with silent data
   loss as its failure mode. A deployment states the window it can afford.
4. ~~Is `MAX(seq) … GROUP BY id` (W3) actually cheaper than the collapse-in-JS?~~
   **Answered: yes, and for a reason the question understated.** The collapse
   itself is a wash; what the SQL form buys is never selecting `doc`, which is
   where the bytes and the JSON parsing were. `__bench__/shape-diff-catchup.bench.ts`
   holds the key set at 200 rows and grows the range 20x for ~5.4x the cost.
5. At what `.global()` membership size does W6 stop being enough — i.e. where does
   D7's "no external index" answer expire?

## 10. Defects this branch introduced, and the review that caught them

A review pass over this branch's own output found five issues, **three of them
defects the implementation introduced**. Each is fixed, with a regression test
where one applies.

- **The payload-compaction guard refused a log it should have served.** It gated
  on `minCdcDocSeq` (the oldest row carrying a post-image), but a `delete` stores
  a NULL post-image _by design_ — so a retained prefix opening with deletes read
  as "compacted" and permanently 409'd every change-feed consumer and the
  read-replica tier (`replicaOwnerHost.readChanges`), with nothing having been
  compacted at all. The retention sweep W5 added makes delete-boundary prefixes
  considerably more likely. The test is now "a row that SHOULD carry a post-image
  and doesn't", evaluated over the page already read — exact, and one query
  cheaper than the guard it replaced. Compaction only ever clears a prefix, so a
  compacted row in the requested range always surfaces in that page.
- **`readSqlCdcChangedTables` could lose a write.** It read `DISTINCT "table"`
  before `MAX(seq)` — two round-trips, so a write landing between them was absent
  from `tables` yet covered by the `cursor` the poll then adopted, freezing that
  shape until the next resync. The head is now read first and the table scan
  bounded by it, so an interleaved write lands _past_ the cursor and the next tick
  reports it.
- **`shapeProbeKey` joined ids with `","`** inside an otherwise length-prefixed
  key — reintroducing exactly the ambiguity `joinKeyParts` exists to prevent. Row
  ids are only UUIDs on the default insert path; `allowExplicitId` admits any
  string, comma included, so `["a,b"]` and `["a", "b"]` could share one cache
  entry and serve each other's member map.
- **The global changelog probe ran with no shape subscribers at all.**
  `pollGlobalShapes` opened the tick before checking whether any socket held a
  shape, and the alarm is shared with the TTL and external-source tiers — so a
  shard paid a `.global()` round-trip on every tick for nothing, which is the
  exact cost W6 exists to remove. It now resolves who it has work for first.
- A `compactCdcDocs` comment claimed a PITR gate in the sweep that does not
  exist; the real protection is the read-path refusal. Corrected.

## 10a. Second review pass: what a full audit of the branch found

A second, adversarial pass over the finished branch found eight further issues.
Six were real defects and are fixed here with regression tests; two are bounded
behaviours that are now stated rather than left implicit.

### Fixed

- **The retention floor was blind to every relayed subscriber, and said the
  opposite in its own docstring.** `retentionFloor` read only
  `__shape_poke_cursor`, which is written exclusively by the LOCAL-socket poke
  path. A relayed subscriber's resume position lives in memory on the owner (the
  cohort registry and the per-socket proxies in `relay-hub.ts`) and writes no row
  at all — so a fully relayed shard, which is the high-fan-out case an operator
  turns retention on FOR, looked like a shard with no subscribers. The sweep was
  then free to delete the rows the next relayed diff had to read. Nothing errors:
  the diff just finds fewer changed keys than there were, and every relayed
  client silently keeps rows that moved. `RelayLink.minShapeCursor()` now exposes
  the frontier and `retentionFloor` folds it in. The regression test uses a QUIET
  table, because a flush advances a cohort's frontier only for shapes whose table
  changed — a busy sibling table is what drives the head past a quiet shape.
- **Payload compaction permanently stalled the read-replica tier.** A replica's
  `ownerFloor` returned `minCdcSeq` (the KEY floor), which compaction never
  moves. So a replica below the payload cutoff got a thrown `CDC_PAYLOAD_COMPACTED`
  from `readChanges`, which reaches it as a bare non-2xx — indistinguishable from
  an unreachable owner. It never latched divergent, never bootstrapped, and
  re-issued the same doomed cross-region round trip on every read, forever.
  `ownerFloor` now reports the payload floor, and `servePull` checks it BEFORE
  reading the page so the follower is handed the floor instead of a refusal.
- **`runShardCdcSync` failed OPEN on row deletion.** The compaction guard was
  rigorous; there was no trim guard at all. A warehouse connector resuming below
  a trimmed floor was handed the surviving tail with an advanced cursor and no
  indication anything was skipped — permanent, silent, unreported data loss on
  the more destructive of the two knobs. New `CDC_LOG_TRIMMED` (409) refuses it.
  The asymmetry was exactly inverted: the harmless level failed loud, the
  destructive one failed silent.
- **The retention knobs bypassed the repo's own env parser.** They used
  `parsePositiveInt` from `admin-rpc-args.ts` — a bare `Number.parseInt` — so
  `LUNORA_CDC_LOG_RETENTION=10k` read as "keep 10 rows" and deleted the
  changelog. `env-int.ts` exists to prevent precisely this and argues the case in
  its own JSDoc. Both knobs now go through a new `envOptionalPositiveInt`, which
  requires the whole string to be an integer and treats anything else as unset,
  i.e. as OFF — the only safe direction for a knob whose effect is a `DELETE`.
- **The sweep could never make partial progress.** It ran a single unbounded
  `DELETE`/`UPDATE` over the whole prefix, synchronously, on a write path. The
  first sweep after an operator enables retention on an already-unbounded log is
  exactly the case that exceeds the DO's limits — and the `catch` swallowed it
  having already stamped `lastCdcSweepAt`, so it retried the identical unbounded
  statement every 60 s forever, with zero progress and no report. Both statements
  are now bounded to `CDC_SWEEP_MAX_ROWS` per pass. The `COUNT(*)` pre-check went
  with it: `cdcSeqLeavingRows` already answers "is anything past the window?" as
  an indexed seek, where `COUNT(*)` was a full b-tree walk every 60 s on the
  write path — on the multi-million-row logs this sweep exists to bound.
- **`shapeProbeKey` embedded every changed id, which the range key already
  determines.** The id set is `readCdcChangeKeys(table, sinceSeq, upTo)` mapped
  to ids, so `shapeRangeKey` identifies it exactly. Spelling the ids out built a
  multi-megabyte string per (shape, socket) on a long catch-up and RETAINED it as
  a `Map` key for the whole flush — on the per-identity predicates where this
  cache shares nothing, unbounded growth in a 128 MB isolate, and strictly worse
  than the transient set the un-memoized path allocated. Now keyed
  `(predicateKey, rangeKey)`.

### Stated, not changed

- **`.global()` deltas remain racy on sequence-allocating dialects.** Postgres
  and MySQL allocate `seq` before commit, so a transaction holding a lower `seq`
  can commit after one holding a higher one, and no single read can see it. The
  probe is now ONE statement whose cursor is the max `seq` it actually returned —
  which closes the two-round-trip window entirely — but the sequence-gap window
  is not closable by reading. It is bounded by `GLOBAL_SHAPE_RESYNC_MS`, the same
  bound already accepted for an out-of-band writer, and the docstring now says
  so instead of claiming the ordering fixed it. D1 is unaffected (single writer,
  and `withSession` puts both reads in one snapshot).
- **A time-varying `.global()` predicate now converges on the resync interval
  rather than the poll interval.** A shape whose membership moves without a write
  (`_creationTime > now - 1h`) used to be re-read every 2 s; it is now skipped
  while its table is unchanged, so it converges within 30 s instead. Bounded and
  intended, but it was not written down anywhere.

### Deliberately not addressed

- **A leaked `__shape_poke_cursor` row pins the floor indefinitely.** A
  connection that dies without `deleteShapePokeCursorsForConnection` leaves a row
  whose `MIN(cursor)` holds the floor at its position, so retention reclaims
  nothing and never says why. The direction is fail-SAFE (it retains data), and
  every staleness heuristic that would reclaim it trades a silent no-op for a
  silent deletion of rows a live-but-idle subscriber is owed. Left as is.
- **The `.global()` `__cdc_log` still has no retention.** `trimSqlCdcChanges`
  exists and has no caller; the shard-local twin gained a full sweep in this
  branch and the SQL twin gained only a read. The gap predates this work but this
  branch makes the log hotter (polled every 2 s), so it is worth naming: a
  `.global()` log is written from every shard and every region, and bounding it
  needs a floor computed across all of them — a genuinely different problem from
  the in-shard floor, and out of scope here.

## 11. Verification

`lint:types` clean repo-wide; `lint:eslint` clean on every touched package;
`lint:package-json` and `lint:registry:sync` clean; `dist:check` clean against a
production build; `api:check` clean after `api:update` on a fresh production
build.

The surface change is a net simplification. Removed: `countCdcChanges` (the
write-path `COUNT(*)`, now unused), `minCdcDocSeq` (dead, replaced by
`minCdcReplayableSeq`, which measures the floor its consumers actually need),
and `shapeProbeKey` / `shapeRangeKey` (now private to the cache that owns them).
Added: `buildShapeDiff` + `ReadShapeCdcKeys`, `GlobalPollTick`,
`envOptionalPositiveInt` / `envPositiveInt`, and `CDC_LOG_TRIMMED`. Signature
changes: `trimCdcChanges` / `compactCdcDocs` take a per-pass row bound;
`cdcChangedTables` / `readSqlCdcChangedTables` / `readGlobalChangedTables` take
`cursorOnly`; `ShapeDiffCache` is a class with two methods instead of a record
with four public mutable fields. Removals follow the pre-release `alpha`
convention: every call site migrated in the same change.

`pnpm run test` green across all 64 projects. Per-package: `shard-engine` 1153,
`do` 573, `sql-store` 112, `studio` 1075. Benches run clean:
`cdc-resume-probe`, `shape-diff-catchup`, `shape-poke-fanout`.

### Where the code now lives

The two-stage pipeline moved OUT of `shard-do.ts` and into
`@lunora/shard-engine`, which is where the repo's host-neutral/Cloudflare-host
seam puts it: `buildShapeDiff` reads through the `sql` handle and touched no
instance state, and three of the four methods that implemented it carried a
`class-methods-use-this` suppression saying exactly that. The consequences of
having it on the wrong side were concrete — the per-flush cache's internals had
to become cross-package public API for a foreign package to reach them, and
benchmarking a pure function needed a `ShardDO` subclass, a fake
`ShardDOState`, an `handleRpc` stub and a double cast through `unknown`. The DO
keeps a four-line `diffShape` that routes the changelog read through its own
`readShapeCdcKeys` seam. `GlobalPollTick` moved for the same reason. Net effect
on `shard-do.ts`: it shrinks rather than grows.

The bench fixtures collapsed with it. `__bench__/shared.ts` gained
`makeCdcShardFixture`, replacing five copies of the same
`as unknown as ShardDOState` block, three near-identical `ShardDO` subclasses,
and three copies of the schema cast.
