# Plan 130 — Phase 0 design: `ctx-db` twins shareability inventory

> Deliverable of the INVESTIGATE/DESIGN spike `plans/130-ctx-db-twins-spike.md`.
> This is a factual inventory + recommendation, produced without modifying any
> source file. Baseline: commit `b6eb48dcd`. Drift check re-run at time of
> writing confirmed neither target file has moved/split since that baseline.

**Targets**: `packages/do/src/ctx-db.ts` (3,366 lines — DO SQLite, JSON-blob
storage, sync `SqlExec`) vs `packages/sql-store/src/ctx-db.ts` (3,492 lines —
D1/Hyperdrive `.global()` tables, real column-per-field storage across
`sqlite | postgres | mysql`, async `SqlCtxExec`).

## Headline correction to the plan's own premise

Plan 130's "Current state" section frames these as two largely-independent
3,000+ line files. That undersells how much sharing **already exists**. Both
files import a common seam from `@lunora/do`'s satellite modules:

| Shared module              | LOC       | What it supplies                                                                                                                   |
| -------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `relation-predicates.ts`   | 577       | `resolveRelationPredicates`, `assertFlatPredicate` — relation-crossing `where` → EXISTS/semijoin                                   |
| `relations.ts`             | 474       | `applyOnDelete`, `fanOutScalarCounts`, `resolveWith`, `runRowValidators`                                                           |
| `rank.ts`                  | 383       | `RANK_TIEBREAK`, `rankTableName`, `sortColumnName`, `encodePartitionKey`, `resolveRankPartition`, `matchesRankStaticWhere`         |
| `aggregates.ts`            | 393       | `selectIndexForAggregate`/`Count`/`GroupBy`, `normalizeCountArgument`, `mergeWhere`, `softDeleteScope`, `CountRlsUnsupportedError` |
| `query-args.ts`            | 318       | `encodeCursor`/`decodeCursor`/`buildSeekWhere`/`normalizeOrderKeys` (keyset pagination)                                            |
| `where-sql.ts`             | 261       | `compileWhereSql` + the `WhereSqlStrategy` injection seam                                                                          |
| `aggregate-tally.ts`       | 162       | `foldAggregateTally`, tally-reducer math                                                                                           |
| `aggregate-sql.ts`         | 116       | `aggregateSqlFunction`, `aggregateTableName`, `encodeAggregateKey`, `readAggregateValue`, `coerceAggregateNumber`                  |
| `triggers.ts`              | 109       | `runTriggers`, `hasTrigger` — before/after insert/update/delete dispatch                                                           |
| `search-text.ts`           | 89        | `buildFtsMatch`, `ftsTableName`, `scoreDocument`, `stringifySearchText`, `tokenizeSearch`                                          |
| **Total shared footprint** | **2,882** | ~45 named symbols imported by both `ctx-db.ts` files                                                                               |

This is the concrete existing precedent for "inject a strategy object, share
the algorithm" (`WhereSqlStrategy`: `doWhereSqlStrategy = { fieldRef: jsonPathSql,
serialize: serializeSqlValue }` in do vs `whereSqlStrategy = { fieldRef:
columnRefSql, serialize: serializeColumnValue }` in sql-store). **It works,
it's shipped, and it already covers the where-compiler, cursor/keyset,
relation, rank-math, aggregate-math, trigger, and search-scoring cross-cutting
concerns.** The remaining duplication this spike is scoped to is narrower than
the plan assumed: it's concentrated in (a) the exec/codec plumbing repeated
inside every CRUD method body, and (b) two specific clusters where DO already
extracted a shared helper but coupled it to sync+JSON-blob so sql-store
couldn't reuse it (rank-page pagination, companion-index sync).

## Step 1 — Method-level parallelism map

Legend: **P** = parallel (both implement the same algorithm, differ only in
exec/codec) · **D** = dialect-specific or a genuine capability difference ·
**S** = already shared (imported, no local duplication) · line ranges are
`do/ctx-db.ts` : `sql-store/ctx-db.ts` (some ±3–5 lines — read in ~250–300
line chunks; method-boundary lines confirmed via `grep -n "^};" `/`^const `).

| Method / surface                                                                                  | do range (LOC)                                                                               | sql-store range (LOC)                                                                                                                                                         | Class                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| reader (`buildReader`: collect/first/paginate/take/unique/withIndex/withSearchIndex/order/filter) | 1172–1378 (207)                                                                              | folded into `query()` 3103–3222 (~120)                                                                                                                                        | **D**                                  | DO: full Convex-style fluent reader with index range scans over the JSON blob. sql-store: **restricted** — every terminal except `.withSearchIndex()` throws `LEGACY_READER_ERROR = "the legacy query()/withIndex() reader is not available on the D1 (global) backend; use findMany"`. This is a genuine capability gap, not a dialect swap — do not force parity as part of a refactor without a separate decision.                                                                                                                                                                                  |
| `query()` (dispatch)                                                                              | 2975–2994 (20)                                                                               | (same span as reader above)                                                                                                                                                   | D                                      | thin in both, but gates to a different feature surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `aggregate`                                                                                       | 2017–2107 (91)                                                                               | 2368–2444 (77)                                                                                                                                                                | **P**                                  | shares `selectIndexForAggregate` → `aggregateSqlFunction` → `readAggregateValue`; differs only in exec (sync vs async) and value ref (`jsonPathSql` vs `columnRefSql`)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `count`                                                                                           | 2109–2184 (76)                                                                               | 2446–2500 (55)                                                                                                                                                                | **P**                                  | shares `normalizeCountArgument`, `mergeWhere`, `softDeleteScope`, `CountRlsUnsupportedError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `delete`                                                                                          | 2186–2330 (145)                                                                              | 2502–2620 (119)                                                                                                                                                               | **P** (+small D)                       | shares `applyOnDelete`/`fanOutScalarCounts`/`runTriggers`; sql-store adds a genuine cross-backend shardBy-cascade guard absent from DO (real dialect concern, correctly not shared)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `deleteMany`                                                                                      | 2332–2348 (17)                                                                               | — (0)                                                                                                                                                                         | DO-only, optional                      | `DatabaseWriterLike` documents this as optional; `.global()` tables are batched per-row through the DO writer's loop instead. Not twin-tax.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `findFirst`                                                                                       | 2350–2355 (6)                                                                                | 2622–2627 (6)                                                                                                                                                                 | **S** (trivial)                        | one-line delegation to `findMany({...,take:1})` in both — near byte-identical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `findFirstOrThrow`                                                                                | 2357–2365 (9)                                                                                | 2629–2637 (9)                                                                                                                                                                 | **S** (trivial)                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `findMany`                                                                                        | 2368–2515 (148)                                                                              | 2639–2817 (179)                                                                                                                                                               | **P** (+D gap)                         | both compile through `compileWhereSql`/`WhereSqlStrategy` + `resolveRelationPredicates`; DO additionally has `relationExistsPushDown` (cost-based EXISTS escalation) which sql-store's `findMany` entirely lacks                                                                                                                                                                                                                                                                                                                                                                                       |
| `get`                                                                                             | 2517–2537 (21)                                                                               | 2817–2836 (20)                                                                                                                                                                | **P**                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lookupById`                                                                                      | 2540–2559 (20)                                                                               | — (0)                                                                                                                                                                         | DO-only, optional                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `groupBy`                                                                                         | 2562–~2700 (~140)                                                                            | 2837–2912 (~76)                                                                                                                                                               | **P**                                  | sql-store factors an async local helper `tryIndexedGroupBy` (~2256–2350) out of the method body, which is why its inline span reads shorter                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `insert`                                                                                          | 2702–2779 (78)                                                                               | 2925–3003 (79)                                                                                                                                                                | **P**                                  | shares `runTriggers`/`runRowValidators`; each side has its own default/on-update application (do inline, sql-store's local `applyInsertDefaults`/`applyOnUpdate`)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `insertManyUnsafe`                                                                                | 2781–2853 (73)                                                                               | — (0)                                                                                                                                                                         | DO-only, optional                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `insertMany`                                                                                      | 2855–2873 (19)                                                                               | — (0)                                                                                                                                                                         | DO-only, optional                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `normalizeId`                                                                                     | 2875–2877 (3)                                                                                | 3005–3007 (3)                                                                                                                                                                 | **S** (byte-identical one-liner)       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `patch`                                                                                           | 2879–2958 (80)                                                                               | 3009–3065 (57)                                                                                                                                                                | **P**                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `patchMany`                                                                                       | 2960–2973 (14)                                                                               | — (0)                                                                                                                                                                         | DO-only, optional                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `rank`                                                                                            | 2996–3094 (99)                                                                               | 3222–3313 (92)                                                                                                                                                                | **P** (algorithm) / D (exec)           | both use `RANK_TIEBREAK`/`sortColumnName`/`resolveRankPartition` from shared `rank.ts`; differ in how the ordered scan executes                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `rankBefore`                                                                                      | 3097–3148 (52)                                                                               | — (0)                                                                                                                                                                         | DO-only, optional                      | cross-shard "how many rank ahead of me" — no sql-store analog since .global() tables aren't sharded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `rankPage`                                                                                        | 3150–3172 (23, thin wrapper)                                                                 | 3315–3408 (~94, full reimpl)                                                                                                                                                  | **D — highest-value hidden-P cluster** | DO delegates to the shared-but-sync/JSON-coupled `computeRankPage` (`ctx-db-rank-page.ts`, 346 LOC, lives _outside_ `ctx-db.ts`). sql-store cannot reuse it (async + column-coupled), so it reimplements the entire keyset/cursor dance inline plus local helpers `buildRankBeforeBranches`, `buildRankCursorSeek`, `rankPageColumns`, `hydrateRankRows`, `encodeRankCursor` (~160 more lines, ~789–950). sql-store's total rank-page footprint (≈ 94 + 160 = **254 lines**) is close to DO's dedicated 346-line module — **the same algorithm, paid for twice, hidden behind the sync/async divide.** |
| `rankPageRows`                                                                                    | 3175–3189 (15)                                                                               | — (0)                                                                                                                                                                         | DO-only, optional                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `restore`                                                                                         | 3191–3234 (44)                                                                               | 3067–3101 (35)                                                                                                                                                                | **P**                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `replace`                                                                                         | 3234–3311 (78)                                                                               | 3410–3466 (57)                                                                                                                                                                | **P**                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `system` (structural reader escape hatch)                                                         | present                                                                                      | —                                                                                                                                                                             | DO-only, optional                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| companion-index sync (search/aggregate/rank fan-out on write)                                     | delegates to `createCompanionSync` (`ctx-db-companions.ts`, 615 LOC, sync+JSON-blob coupled) | reimplemented inline (async, column-coupled)                                                                                                                                  | **D (hidden-P, 2nd cluster)**          | same "prev + next delta" algorithm on both sides; not directly reusable due to the sync/async + codec coupling, same shape as the rankPage cluster                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| migrations/DDL                                                                                    | externalized entirely to `ctx-db-migrations.ts` (208 LOC), **not in `ctx-db.ts`**            | embedded inline: `runSqlGlobalTableMigrations`/`runSqlAggregateMigrations`/`runSqlRankMigrations`/`runSqlSearchMigrations`/`runSqlCdcMigration` (~300 LOC inline, ~1000–1300) | **D**                                  | genuinely different DDL per dialect (SQLite JSON1/expression index vs real column DDL across sqlite/postgres/mysql) — not shareable as logic; the _migration-gate call pattern_ ("ensure migrated before every method") is a shareable shape even if the DDL bodies aren't                                                                                                                                                                                                                                                                                                                             |
| trigger dispatch                                                                                  | imported (`triggers.ts`, 109 LOC)                                                            | imported (same)                                                                                                                                                               | **S**                                  | fully shared, no local reimplementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| cursor encode/decode + keyset seek                                                                | imported (`query-args.ts`, 318 LOC)                                                          | imported (same)                                                                                                                                                               | **S**                                  | fully shared, no local reimplementation (outside the rankPage cluster's own cursor, see above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| OCC guarded-write (`runGuardedWrite`/CAS)                                                         | present (sync throw on conflict)                                                             | present (async, same `ConflictError` contract)                                                                                                                                | **P**                                  | same CAS-on-read-snapshot pattern, same error type; not yet extracted to a shared function                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Parallel-LOC estimate

- **P-classified method bodies** (13 methods, both files implement the same
  algorithm shape): **do 1,015 LOC + sql-store 861 LOC = 1,876 combined
  lines.** This is the core "twin tax" inside the two files' own bodies.
- **Hidden-P clusters** blocked only by the sync/async divide: rank-page
  (~254 sql-store-inline + 346 do-external-but-still-JSON-coupled) and
  companion-sync (do: delegated to a 615-line sync-coupled module; sql-store:
  reimplemented inline, unquantified but bounded by the same shape) — real
  duplication, but **not safely mergeable without crossing the sync/async
  function-color boundary**, discussed in Step 2.
- **Already-shared infrastructure** (not part of either file's own line
  count, imported by both): **2,882 LOC** across 10 modules — proof the
  injection-seam pattern scales.
- **DO-only optional batch surface** (8 methods, ~210 LOC): not twin tax —
  `DatabaseWriterLike`'s own JSDoc documents these as optional, `.global()`
  backends cover the same semantics by looping the DO writer per row.

Of the two files' combined 6,858 lines, roughly **27% (1,876 lines) is
P-classified** duplication inside the method bodies, a further chunk is the
two hidden-P clusters (blocked by function color, see Step 2), or specific
non-mergeable D territory (restricted reader, migrations/DDL, DO-only
batch ops), and the remainder is structural interfaces/JSDoc, imports, local
codec/dialect glue, and the RLS-wrapper/export-barrel tail that both files
carry.

## Step 2 — Seam characterization

### What a shared core would need injected

1. **Row codec** — DO: `rowToDocument`/JSON-blob via `json_extract`
   (types preserved natively by JSON). sql-store: `decodeRow`/`decodeRows`/
   `physicalColumn` mapping (`_id`→`id`) + `serializeColumnValue`/`sqliteEncode`/
   `sqliteDecode` doing real type-affinity coercion (booleans, dates, arrays
   have no native column type). **These are not interchangeable one-liners —
   the column codec carries actual behavior** (affinity mapping), which is
   exactly the class of edge case Step 3's risk list flags (NaN/undefined).
2. **Exec/prepare interface** — DO's `SqlExec` is **synchronous**
   (`.exec(...).toArray()`/`.one()`, backed by DO's in-process SQLite).
   sql-store's `SqlCtxExec` is **asynchronous** (`queryAll`/`queryRun`
   awaiting real network I/O to D1/Postgres/MySQL). This is the single
   biggest seam problem: unifying the 13 P-classified method bodies into one
   shared function would force either (a) DO's synchronous hot path to
   become `async` — the do/ctx-db.ts header frames synchronous SQLite access
   as a **deliberate design property**, not an oversight — or (b) sql-store to
   fake synchronicity, which it structurally cannot (real network calls).
3. **Identifier/value quoting** — already solved once via the
   `WhereSqlStrategy` pattern (`fieldRef`/`serialize`); a shared core would
   reuse the same shape for the row-codec and column-ref concerns, not invent
   a new abstraction.
4. **Transaction/OCC hooks** — `runGuardedWrite`'s CAS-on-read-snapshot shape
   is identical in intent on both sides but not extracted; a shared core
   needs a hook point that can be sync-resolved-as-promise on DO and
   natively-async on sql-store.
5. **Trigger dispatch** — already fully shared (`triggers.ts`); no new seam
   needed here.

### Compared to the existing `WhereSqlStrategy` pattern

`WhereSqlStrategy` is a narrow, successful precedent: it injects exactly two
functions (`fieldRef`, `serialize`) into one pure compiler
(`compileWhereSql`) that has **no I/O of its own** — it only builds a SQL
fragment string. That's why it could be shared cleanly. The 13 P-classified
CRUD methods are a different shape: they **own the I/O** (they call `exec`
directly, not through an injected pure function), so extracting them requires
injecting the exec call itself, not just a value-formatting function. This is
a materially larger seam than `WhereSqlStrategy` — closer to "inject an async
executor and make every caller await it" than "inject two format functions."
That function-color change is the crux of the Step 4 recommendation.

### Dependency-direction / package-layout analysis

Today: `packages/sql-store` depends on `@lunora/do` (for `WhereSqlStrategy`,
cursor helpers, relation/aggregate/rank math, triggers) — a clean
`do → sql-store consumes do` direction, `sql-store` is the newer package
built atop `do`'s already-extracted primitives.

A shared query **core** (the 13 P methods + rank-page + companion-sync)
would need to be consumed by **both** packages symmetrically. Two options:

- **Invert (`sql-store` hosts the core, `do` depends on it)** — wrong
  direction: `do` is the older, larger, more heavily tested (1,005 tests)
  package; making it depend on the newer, thin-tested (13 tests) package
  inverts the trust gradient and risks regressing DO's synchronous hot path
  behind an abstraction sized for D1/Postgres/MySQL's async reality.
- **Third package** (e.g. `@lunora/ctx-db-core`) consumed by both — the
  structurally correct answer, but note the `shared/` folder (per
  AGENTS.md) is **not** a fit: `shared/` requires genuinely
  zero-dependency, bundler-inlined files (the documented example,
  `stable-key.ts`, has zero imports beyond relatives/builtins). A query core
  needs `@lunora/values`-adjacent validator types, the row/document shape,
  and (for the async variant) real `Promise`-based control flow threaded
  through triggers/RLS — that's a real runtime dependency surface, not an
  inlineable helper. **This must be a real published `@lunora/*` package**,
  not a `shared/` file, if pursued.

Given the sync/async function-color mismatch (previous section), a single
package hosting **all 13 P methods** is not achievable without either
forcing DO's sync path async (rejected as an architectural regression) or
maintaining two executor implementations behind one core — at which point
the "core" is mostly the injection-shape work already done by
`WhereSqlStrategy`, and the payoff shrinks to the pieces that are pure
computation regardless of exec model (see Step 4's narrow-extraction
candidate).

## Step 3 — Risk & payoff

### Payoff evidence (churn)

Of **8 total commits** touching either file since the initial scaffold
(`786b5735d`, chore: lunora start, +3,115/+3,274 both files at once), **3 of
the remaining 7** touched both files for one logical change (43%):

| Commit      | Subject                                                                   | do Δ     | sql-store Δ |
| ----------- | ------------------------------------------------------------------------- | -------- | ----------- |
| `6b77a1699` | feat: extending db (#32) — upsert/exists/select/skipDuplicates            | +199/-25 | +117/-11    |
| `8d94ca17e` | perf(do): grouped relation `_count`, resolve relation-predicate RLS (#61) | +83/-9   | +83/-6      |
| `5b3ef723f` | feat(errors): unified error layer (#101)                                  | +51/-45  | +43/-37     |

The other 4 touched exactly one file: `71e425d1f` (sql-store only, #95 decode
memo/count cache), `1246948c9` (sql-store only, #90 RLS/security
remediation), `f018251eb` (do only, #37 Zero-class sync engine), `be57ecaf4`
(do only, dead-code removal).

`8d94ca17e` is the strongest single piece of evidence: its own commit message
documents **finding and partially fixing byte-identical duplication as a
side effect of a bug fix** — `"Extract fanOutScalarCounts(...) into
relations.ts ... and call it from both backends' cross-backend branches —
eliminates the byte-identical Promise.all(values.map(...)) duplication."`
This is exactly the failure mode plan 130 is worried about (a fix landing in
one file, the twin silently drifting) **and** evidence the team already
self-corrects incrementally rather than needing a big-bang refactor to catch
it. Verdict: churn is real but moderate (43% of post-scaffold commits, not
80–100%), and the team's own remediation pattern is "extract the specific
duplicate found," not "unify the files."

### Risk list (behavior cliffs)

1. **Cursor format stability** — the base keyset cursor (`encodeCursor`/
   `decodeCursor`) is already shared and low-risk. The **rank cursor**
   (`encodeRankCursor`, sql-store-local vs DO's `computeRankPage`-internal
   equivalent) is _not_ unified — any refactor touching the rank-page
   cluster must preserve byte-identical wire cursors across DO/D1/Postgres/
   MySQL or break in-flight client pagination tokens across a deploy.
2. **OCC/trigger ordering** — both files fire: before-trigger → defaults/
   validation → guarded write (CAS) → companion sync → after-trigger, in that
   exact sequence. A shared core must preserve this interleaving exactly;
   getting it subtly wrong (e.g. companion sync before the CAS check
   commits) changes transaction semantics silently.
3. **NaN/undefined encode edges** — the row-codec boundary
   (`value-codec.ts`: `sqliteEncode`/`sqliteDecode`, 117 lines) does real
   type-affinity coercion that the DO side never needs (JSON preserves
   types). This is the narrowest, highest-density-of-edge-cases file in
   scope, and it has only **15 direct tests** (`value-codec.test.ts`).
4. **Reader capability parity** — sql-store's restricted `query()` throws
   `LEGACY_READER_ERROR` for every terminal but `.withSearchIndex()`. None of
   sql-store's 13 `ctx-db.test.ts` tests currently exercise those throwing
   paths (confirmed: only 13 tests total in that file, none targeting the
   reader's rejection branches). A shared core must not silently grant
   sql-store the full DO reader surface (real column range scans) as an
   unplanned side effect — that's a feature expansion disguised as a
   refactor.
5. **Cross-shard/global routing indirection** — DO's `globalWriterFor`/
   fallback plumbing has no sql-store analog (sql-store tables _are_ the
   global backend). A shared core must make this hook a clean no-op on the
   sql-store side, not assume it always exists.

### Test-coverage gap (quantified)

| Suite                                                                   | Files | Tests |
| ----------------------------------------------------------------------- | ----- | ----- |
| `packages/do/__tests__`                                                 | 89    | 1,005 |
| `packages/sql-store/__tests__/ctx-db.test.ts`                           | 1     | 13    |
| `packages/sql-store/__tests__/value-codec.test.ts`                      | 1     | 15    |
| `packages/d1/__tests__` (e2e, sqlite dialect, exercises this ctx-db.ts) | 26    | 193   |
| `packages/hyperdrive/__tests__` (e2e, postgres/mysql dialects)          | 7     | 42    |

sql-store's **direct** unit coverage (28 tests) is roughly **1/36th** of
DO's (1,005). The e2e suites (d1 + hyperdrive, 235 tests) partially backstop
it by exercising the same `ctx-db.ts` code paths through real dialect wiring
— but any core-touching refactor still needs re-validation across **three**
SQL dialects (sqlite via D1, postgres, mysql) where DO only ever needs one
(DO's own SQLite). **Before any P-classified method or the rank-page/
companion-sync clusters are touched, characterization tests are a hard
prerequisite** — estimate **15–25 new sql-store tests**: one happy-path +
one edge case (null/NaN/undefined round-trip) per P method not already
covered by the existing 13, plus 4–6 tests pinning the rank cursor wire
format across a rankPage → next-page round trip on each of the three
dialects.

## Step 4 — Recommendation

**REJECT the big-bang merge; STATUS-QUO+ (tandem-edit checklist) for the 13
P-classified CRUD method bodies; ship ONE narrow, low-risk extraction (the
rank "strictly-before" comparator) as the only concrete P3 follow-up.**

Reasoning:

- The large, valuable extraction (cross-cutting where/cursor/relation/
  aggregate/rank-math/trigger logic, 2,882 lines) **already happened** and is
  proven at scale — there is no comparable low-hanging fruit left of that
  size.
- The remaining 1,876 P-classified lines are blocked from safe unification
  by a genuine, deliberate architectural fact: DO's synchronous SQLite access
  vs sql-store's necessarily-async D1/Postgres/MySQL access. Crossing that
  function-color boundary to build one shared core is high-risk (Step 3's 5
  risk items), high-effort (a real new `@lunora/*` package, not `shared/`,
  per Step 2), and has a thin safety net today (13 direct tests vs 1,005).
- The two "hidden-P" clusters (rank-page, companion-sync) look like the
  biggest win on paper (DO's dedicated 346-line + 615-line modules vs
  sql-store's ~254 inline lines) but are hidden behind the _same_ sync/async
  divide — extracting them has the same prerequisite (characterization
  tests across 3 dialects) and the same risk (cursor-format and
  companion-sync-ordering cliffs) as the main CRUD cluster, for a smaller
  absolute LOC payoff than it first appears.
- Churn is real (43% of post-scaffold commits touched both files) but the
  team's own demonstrated remediation pattern (commit `8d94ca17e`) is
  "extract the one duplicate found during a fix," not "unify the files" —
  this spike's evidence supports continuing that incremental pattern, not
  overriding it with a phased big-bang plan.
- **One exception**: the rank "strictly-before" comparator (do's
  `countRankBefore`, local ~1500s / sql-store's `buildRankBeforeBranches`,
  local ~789) is pure tuple-comparison logic with **no I/O of its own** — the
  same shape as `WhereSqlStrategy` (inject a `fieldRef`/`serialize`-like pair,
  compile a comparison expression). This is genuinely low-risk, sync/async
  agnostic, and small (~50–100 lines each side). It is the one candidate
  worth a real P3 follow-up plan, gated on adding rank-cursor
  characterization tests first (Step 3 estimate: 4–6 tests) so the
  extraction can be verified byte-identical before and after.

### If a future maintainer decides to proceed anyway

A phased plan, in priority order, each gated on the previous phase's tests
passing:

1. **Characterization tests first** (prerequisite for any of the below):
   15–25 sql-store tests per Step 3, focused on the row-codec edge cases and
   the rank cursor wire format across all 3 dialects. Effort: **S–M**.
2. **Extract the rank-before comparator** into a pure function taking an
   injected `fieldRef`/`serialize` pair (mirroring `WhereSqlStrategy`),
   consumed by both `countRankBefore` (do) and `buildRankBeforeBranches`
   (sql-store). Effort: **S**.
3. **(Optional, higher risk) Formalize a migration-gate helper** — not the
   DDL bodies themselves (genuinely dialect-specific), just the "ensure
   migrated" call-site pattern repeated before every method. Low payoff,
   include only if phase 2 lands cleanly and appetite remains. Effort: **S**.
4. **Do not** attempt to unify the 13 P-classified CRUD method bodies or the
   rank-page/companion-sync clusters into one shared core inside this
   spike's scope — that requires a separate, dedicated design decision on
   the sync-vs-async function-color question and a new `@lunora/*` package,
   which is out of proportion to the measured payoff here.

### Tandem-edit checklist (recommended regardless of the above)

Add an identical header-comment block to both files' JSDoc header, listing
the 13 P-classified methods and the two hidden-P clusters, with the
instruction: _"When editing one of [`aggregate`, `count`, `delete`,
`findFirst`, `findFirstOrThrow`, `findMany`, `get`, `groupBy`, `insert`,
`patch`, `rank`, `restore`, `replace`, rank-page, companion-sync] here, check
the twin file's same-named method — these implement the same algorithm over
different storage."_ This directly targets the actual failure mode surfaced
by `8d94ca17e` (a fix landing in one file, the twin silently drifting) at
near-zero cost and risk, which is the appropriate response given the
measured payoff/risk balance above.
