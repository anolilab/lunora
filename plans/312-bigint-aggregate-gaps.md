# Plan 312 — Close the two gaps that leave a `v.bigint()` column unaggregatable

**Baseline:** `e67cd58a9` (2026-08-08) — the head of `fix/265-wire-codec-query-parity` (#365)
**Status:** EXECUTED (2026-08-09) — gap 1 fixed, gap 2 decided and kept loud, and a
**third, silent** defect found on the way. See §10.
**Priority:** P2 · **Effort:** M · **Risk:** MED · **Category:** bug/design

> **Executor instructions**: both gaps are **loud** today — they throw, they do not
> return wrong answers. That is deliberate and it is the bar to preserve: do not
> close either gap by making an aggregate return an approximate number. If the only
> way to support a case is to round, the honest answer is to keep throwing.

## 0. Headline finding

#365 made `v.bigint()` columns exactly comparable by storing them as a fixed-width
order-preserving decimal key. Padded text is not something SQLite can add up, so the
aggregate paths grew two guards. Each is correct in isolation; together they leave
two shapes with **no way to aggregate a bigint column at all**:

1. **A soft-delete table cannot use the aggregate companion, at any magnitude.**
   `ctx-db.ts`'s aggregate reader takes the maintained-companion fast path only when
   `definition.aggregateIndexes && !aggOptions.baseWhere && !hasRelation && !aggScope`.
   For a soft-delete table `aggScope` is _always_ truthy (it is `softDeleteScope(definition.softDeleteMode, undefined)`, computed unconditionally), so every aggregate falls
   to the SQL scan — which now refuses a `v.bigint()` field rather than coerce padded
   text into the ~1.5e40 that falls out of it. Net effect: **no aggregate over a
   bigint column on a soft-delete table**, even for values well inside 2^53.

2. **Declaring `aggregateIndex` on a bigint column caps that column's writes at
   2^53.** `aggregate-tally.ts`'s `coerceAggregateNumber` refuses a magnitude past `MAX_SAFE_BIGINT`, because
   the companion's `__value__` is a REAL column that cannot hold it exactly. The
   refusal fires on the **write**, not the read — so one index declaration makes the
   column unusable for large values, which is the opposite of the direction people
   reach for `v.bigint()` in.

Neither is a regression: before #365 the scan answer was garbage (`SUM` read 0) and
the write path threw for a different reason. Both are now correct-but-narrow, and the
combination is the gap.

## 1. Current state (audit)

> **Citations are by symbol, not line number.** An earlier draft of this plan
> cited `ctx-db.ts:2451`/`:2467` and `aggregate-tally.ts:62`; the plan-265
> round-two work inserted `assertReducibleBySql` above them and moved all three
> by ~26 lines within days. Grep for the symbol.

**Since this plan was written**, the scan-path refusal is no longer inline: it is
`assertReducibleBySql` (`ctx-db.ts`), applied at three entry points — the
aggregate reader plus **both** halves of `groupBy`, which previously had no guard
at all. That closed the "unguarded `groupBy`" hole but did **not** close either
gap below: a soft-delete table still cannot reach the companion, so it still
lands on the scan, which now refuses a bigint field loudly instead of returning
~1.5e40.

- `packages/shard-engine/src/ctx-db.ts` — `aggScope`, computed unconditionally from `softDeleteMode` in the aggregate reader.
- `packages/shard-engine/src/ctx-db.ts` — the `definition.aggregateIndexes && !baseWhere && !hasRelation && !aggScope` fast-path predicate that `aggScope` disqualifies.
- `packages/shard-engine/src/aggregate-tally.ts` — `MAX_SAFE_BIGINT`, documented
  as "the largest magnitude the companion's REAL `__value__` column holds exactly".
- `packages/shard-engine/src/aggregate-tally.ts` — `coerceAggregateNumber`'s write-side refusal, whose
  message already points at the two workarounds ("aggregate a narrower column, or read
  the rows and reduce them in the handler").

## 2. Existing seams (do not reinvent)

- The **companion table** and its backfill (`ctx-db-companions.ts`,
  `ensureBackfilled`) already maintain per-group tallies incrementally and rebuild on
  first write after a format change — so a `__value__` representation change does not
  need a migration plan of its own.
- **`softDeleteScope`** already expresses "live rows only" as a where-fragment; the
  question is whether the companion can be keyed to respect it, not whether the
  predicate exists.

## 3. The behavioural contract to preserve

- **An aggregate either returns the exact answer or throws.** No rounding, no
  silent approximation. This is the rule #365 was built on and the reason it is
  landable; a `SUM` that is quietly off by an ULP on a money column is the defect
  class this plan family exists to eliminate.
- **The error must stay actionable.** The current message names both workarounds; do
  not regress it to a bare type error.
- **Do not widen the write-side refusal into a read-side surprise**, or vice versa.
  Whichever side rejects, it should be the one the developer can act on.

## 4. Design decisions to make (not yet made)

1. **Gap 1**: can the companion be maintained per soft-delete state — e.g. keyed to
   include the live/deleted discriminator so `aggScope` becomes a companion lookup
   rather than a disqualifier? If yes this is the better fix, because it also speeds
   up every non-bigint aggregate on a soft-delete table, which is a pre-existing
   performance cliff nobody has measured. If no, the fallback is to teach the scan
   path to aggregate the padded key exactly (decode per row and reduce in JS), which
   is correct but O(rows).
2. **Gap 2**: store the companion's `__value__` as something exact for bigints — a
   decimal string tallied with `BigInt` arithmetic in JS, or a second column — rather
   than REAL. Weigh against: the companion is a hot write path, and every insert
   touches it.
3. Whether `defineTable` should **reject `aggregateIndex` on a bigint column** at
   schema time while the cap stands. A loud failure at build time beats a loud failure
   on the first large write in production, and `@lunora/advisor` is the natural home
   for the lint if a hard error is too strong.

## 5. Workstreams

| #   | Work                                                                                                                                                                          | Size |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | Decide (1) and (2) above with a measurement, not an opinion: how many aggregates in `examples/` + `apps/` hit a soft-delete table, and what the companion write cost is today | S    |
| 2   | Gap 1 fix per the decision                                                                                                                                                    | M    |
| 3   | Gap 2 fix per the decision                                                                                                                                                    | M    |
| 4   | Schema-time guard or advisor lint for `aggregateIndex` on a bigint column, if the cap survives                                                                                | S    |
| 5   | Tests: exact `SUM`/`MIN`/`MAX` over a bigint column above 2^53; the same on a soft-delete table; a soft-delete table's aggregate excluding deleted rows                       | M    |

## 6. Platform parity

**Not applicable** — no `ctx.*` surface, binding, or deploy capability changes. The
aggregate surface and its errors are unchanged in shape; only which inputs are
accepted changes. Recorded explicitly per the repo convention.

## 7. Phasing & ordering

| Phase | Work   | Gate                                                                                                        |
| ----- | ------ | ----------------------------------------------------------------------------------------------------------- |
| 0     | WS 1   | A written decision with the measurement behind it                                                           |
| 1     | WS 2   | An aggregate over a bigint column on a soft-delete table returns the exact answer and excludes deleted rows |
| 2     | WS 3   | `SUM` over values above 2^53 is exact — assert against a `BigInt`-reduced expected value, not a `Number`    |
| 3     | WS 4–5 | Suite green; the refusal, wherever it survives, still names a workaround                                    |

## 8. Risks & STOP conditions

- **STOP if the only way to make an aggregate work is to round it.** Keeping the
  throw is the correct outcome; record it and close the plan as REJECTED with the
  reasoning. That is a legitimate result here.
- **Watch the companion write path.** Both fixes touch what every insert maintains. A
  correctness win that halves insert throughput needs the number in the PR body —
  `packages/shard-engine` has benches.
- The soft-delete companion keying is the kind of change that looks small and
  reaches into backfill, invalidation and the poke protocol. If it does, split it out
  rather than growing this plan.

## 9. Open questions (answer during execution)

- Is `avg` consistent with `sum`/`max` after these changes? #365's review noted `avg`
  returning a value where `sum` threw; confirm the three agree.
- Does `groupBy` over a bigint `by` field share either gap?
- Should `aggregateIndex` on a bigint column simply be **unsupported** rather than
  capped — is anyone summing one, or is the real use case counting/ordering by a
  snowflake id?

## 10. Execution record (2026-08-09)

### WS 1 — the measurement, and what it changed

**No first-party schema declares `.softDelete()`.** `grep -rn "\.softDelete("`
across `examples/`, `apps/`, `templates/`, `registry/` and every package `src/`
returns nothing outside tests and generated output. So gap 1 had **no in-repo
consumer**, and §4.1's secondary argument — "it also speeds up every non-bigint
aggregate on a soft-delete table, a pre-existing performance cliff nobody has
measured" — has no instance to measure either. It is still true in principle;
it is not evidence. The fix landed because it is small and the correctness half
stands on its own, not because the cliff was observed.

### WS 2 — gap 1: the companion tallies live rows only (**done**)

Taken as §4.1's first option, and it turned out cheaper than the plan assumed:
no companion re-keying, no backfill/invalidation/poke reach-through, no
migration. A soft delete is mechanically a patch that stamps the marker column,
so it already arrives at `syncAggregates` as an ordinary `(previous, next)`
pair. Gating **both sides** on liveness decomposes it into "remove the live row,
add nothing" — and a restore into its mirror — with no second code path:

- `query-args.ts` — new `isLiveForCompanion(document, field)`, placed directly
  beside `softDeleteScope`, whose predicate it mirrors record-side. Adjacency is
  the point: a difference between the two is a maintained counter that silently
  disagrees with the scan it replaces.
- `ctx-db-companions.ts` — `applyAggregateDelta` gates `removes`/`adds` through
  it; the lazy `ensureBackfilledIndex` skips non-live rows; `recomputeExtreme`
  ANDs the marker into its group predicate.
- `ctx-db-backfill.ts` — the explicit backfill twin takes the marker column so
  both seeds agree.

**No migration is needed**, which the plan flagged as a risk: each ctx-db
instance already rebuilds a companion from source on first touch, so the format
change heals on the next read or write.

**The readers were then scoped back — see the review round in §11.** The first
version of this change let a soft-delete table take the companion for _every_
aggregate. That is correct but slower, because reaching the companion means
paying `ensureBackfilledIndex`'s full rebuild, per dispatch. The shipped gate
takes the companion only when the scan cannot answer at all.

### WS 3 — gap 2: kept loud, deliberately (**decided, not fixed**)

The cap stands. Lifting it needs **both** an exact tally — a decimal-string
column accumulated with `BigInt` on a read-modify-write, on the path every
insert takes — **and** `AggregateResult` widened from `null | number` to carry
a bigint through every adapter, the client, and the API snapshots. That prices
the whole hot write path for "sum a column of snowflake ids", which is not a
question anyone has asked. §8's STOP condition covers this: keeping the throw
is a legitimate result.

What shipped instead is the message. The throw fires on the **insert**, so
"cannot be aggregated exactly" read as a puzzle; it now names the
`aggregateIndex` as the thing that capped the column, and the docstring records
why the exact version was rejected so it is not re-litigated.

### WS 4 — the advisor lint: **not filed**

§4.3's lint would need `aggregateIndexes` in the advisor IR, which carries no
such kind today (`AdvisorIndex.kind` is `geo | index | rank | search | vector`)
— so it is a feeder change in both the runtime and codegen halves, not a lint.
Weighed against zero in-repo declarations of `aggregateIndex` on a bigint
column, and the now-explicit runtime message, it is not worth the surface.

### The third gap — silent, and the reason to keep writing tests first

The soft-delete max test failed on its first run with **`1e+39` where the
answer was `9`** — not from anything this plan changed. `recomputeExtreme`
answers "the row carrying the stored extreme just left, what is the new one?"
with `MIN`/`MAX(json_extract(__doc__, '$.field'))`. For a `v.bigint()` column
that reduces the **order-preserving padded key**, and SQLite coerces that text
to a REAL. So deleting the max row of a bigint `max` index wrote ~1e39 into the
companion and every later read returned it — a **wrong answer, silently**,
which is worse than either gap the plan was written for.

The reader's `assertReducibleBySql` cannot cover it: this is the write path, and
refusing there would break `delete`. Fixed by reducing that group in JS off the
decoded documents when the field is a projected kind (`reduceExtremeInJs`),
which sees exact values and keeps the same `coerceAggregateNumber` bound as
every other contribution. Regression test on a plain table in
`ctx-db.bigint-bytes.test.ts`, since the defect never needed soft delete.

### §9's open questions

- **`avg` vs `sum`/`max`:** consistent. All three route through the same reader,
  so all three now take the companion on a soft-delete table and all three hit
  `assertReducibleBySql` on the scan.
- **`groupBy` over a bigint `by` field:** shares neither gap. Its fast path is
  fixed by the same change, and both halves were already guarded.
- **Should `aggregateIndex` on a bigint be unsupported rather than capped?** No.
  Money in minor units is the real use case and sits far inside 2^53; the id
  case is `min`/`max`/`count`, which the cap does not reach until the id itself
  exceeds 2^53.

### Not in scope, and why

`@lunora/sql-store` has the same soft-delete disqualifier in its own reader.
Left alone deliberately: its `.global()` tables store real columns rather than a
JSON document, so there is no projected key there and no bigint gap — only the
performance cliff, which is the half with no measured instance.

### Gates

`@lunora/shard-engine` 1047/1047 · `@lunora/do` 524/524 · both `lint:types` and
`lint:eslint` clean · `api:check` green after `api:update` (one added export,
`isReprojectableColumnType`, which the plan-311 follow-up below needed).

## 11. Review round (2026-08-09)

Two adversarial reviews over the working tree. Both found real defects; one of
them found the change had introduced one.

### Introduced, now fixed — the companion is not free to reach

Letting a soft-delete table take the companion for every aggregate was a
pessimisation, not just a widening. Reaching the companion calls
`ensureBackfilled`, and `ensureBackfilledIndex` is an **unconditional TRUNCATE +
full rebuild** memoised per ctx-db instance — i.e. per dispatch, and again per
subscription re-run, since codegen's `buildCtx` constructs one each time
(`_generated/shard.ts:1064`, `:1113`). So a `count()` on a 100k-row soft-delete
table would have gone from one SQL `COUNT` to decoding 100k documents in JS and
rewriting the companion, **on a read, every request** — and a read-only query
dispatch would have started performing storage writes.

Shipped instead: the companion is taken on a soft-delete table only when the
field is projected, which is exactly when the scan refuses (`isProjectedField`,
shared with `assertReducibleBySql`). `count()` is never gated on a field, so it
keeps the scan unconditionally; `groupBy` qualifies on either half. Everything
else keeps the plan it always had, and the gap this plan exists to close is
still closed.

This also retires §4.1's secondary argument for good. It claimed the companion
would "speed up every non-bigint aggregate on a soft-delete table". With the
rebuild cost measured, the opposite is true.

### Widened — the recompute gate was keyed off the declared type

Fix B in §10 used `isProjectedKind` (declared `bigint`/`bytes`). But the
projection runs on the **runtime value type** — `sqlComparableProjection`
branches on `typeof value === "bigint"` — so a `v.any()` / `v.union()` /
`v.from()` column holding a bigint is stored as the same padded key, took the
SQL branch, and wrote ~1e39 into the companion. The same silent wrong number the
fix was for, one declaration away. Now gated on `mayHoldProjectedValue`;
over-including is safe here because the branch only reads documents, unlike the
reader's guard, which refuses. Regression test asserts the companion row's
stored `__value__` directly, and fails with `1e+39` when reverted.

### Found, NOT fixed — the reader's refusal is narrow in the same way

Surfaced by writing the test above. `assertReducibleBySql` also keys off
`isProjectedKind`, so an `aggregate({ op: "max", field })` over a `v.any()`
column holding bigints, with no matching `aggregateIndex`, is **neither refused
nor answered**: the scan returns the 40-character padded key as the result
(`SUM` returns ~1e39). Reproducible on a plain table; pre-existing, not
introduced here.

It is not fixed because the obvious fix is wrong. Widening the refusal to
`mayHoldProjectedValue` would refuse every aggregate over a `v.any()` /
`v.union()` / `v.from()` column, including the majority that hold plain numbers
and work correctly today. Doing it properly needs a decision — probe the stored
rows (`typeof(json_extract(…)) = 'text'`) and refuse only when a projected value
is actually present, or route those columns to the companion — and that decision
deserves its own plan rather than being made at the end of this one.

### Deleted — the plan-311 follow-up was redundant

The `legacyRows` count added to the `migrationStatus` admin RPC has been
reverted in full, along with its `isReprojectableColumnType` export and API
snapshot entry. The capability already existed: `buildReprojectionMigration`'s
transform returns `undefined` for a row already in the current projection, and
the runner counts `changed` only when a transform returns a document — so
`lunora migrate up __lunora_reproject__<table> --dry-run` already reports the
exact legacy-row count per shard.

The reverted version was also worse than the one that existed. Both reviews
independently found that it derived affected columns from codegen's column
metadata without reproducing `reprojectableFields`' `.global()` exclusion, so
`migrate status __lunora_reproject__<globalTable>` would have hit `no such
table` in the DO — an error where the old behaviour returned cleanly, on a
command the docs added in the same change told operators to run. Two further
finds fell out of the same seam: a live admin subscription to that id would
re-run the unindexed COUNT on every write flush, and `__lunora_reproject__constructor`
reached a prototype member and threw. All five defects were in code that did not
need to exist.

`concepts/migrations.mdx` documents the reserved migration and `--dry-run`
instead — the discovery gap was that the docs had never mentioned it at all.

## 12. Review round 2 (2026-08-09)

Both reviews re-run against the three commits. One HIGH, found independently by
the bug reviewer and by a probe written while acting on the quality review — the
same defect from two directions.

### Introduced and fixed — the liveness gate bypassed the 2^53 storage cap

`coerceAggregateNumber` is the only enforcement of "a bigint past
`Number.MAX_SAFE_INTEGER` cannot live under an `aggregateIndex`", and it is
reached only through the tally contribution. Gating that contribution on liveness
meant a row that is **dead on arrival** — inserted with the marker already
stamped, or patched while soft-deleted — was never coerced, so the cap silently
stopped applying. Measured on the real engine:

```
control (no softDeleteMode):  insert 2^70  → THREW
this branch (soft-delete):    insert 2^70 with deletedAt set → ACCEPTED
                              restore()    → THREW, permanently
```

The escalation is worse than the accepted write. The row is inert only while the
schema still declares the marker: drop `.softDelete()` (an ordinary edit) and
every row reads as live, so the next rebuild folds the out-of-range value and
**every write path throws — including the delete that would remove the row.**
Read-alive, write-dead, with no in-band repair.

Root cause: the cap is a **storage** constraint enforced from the **tally**
branch, where two conditions now disqualify a record (`isLiveForCompanion` and
`matchesStaticWhere`). Fixed by coercing the post-image whenever it matches the
index's static `where`, independently of liveness — restoring exactly the set the
bound applied to before. Pinned by a test that asserts both the dead-on-arrival
insert and the patch-while-dead path throw.

### Acted on from the quality review

- **The three reader gates were three shapes of one rule.** Collapsed onto
  `scanRefusesAny(definition, fields)`, derived from the same predicate
  `assertReducibleBySql` refuses on. `groupBy` now builds its SQL-field list once
  and uses it for **both** the gate and the refusal assertions, so a future
  SQL-reducing field cannot be added to one and forgotten in the other. `count`'s
  `!countScope` is that predicate over an empty field list.
- **`reduceExtremeInJs` was a second copy of `foldAggregateTally`'s min/max arm.**
  Deleted; the recompute now folds through the canonical reducer, so it cannot
  disagree with either backfill's seed.
- **A reconstruction artifact.** The soft-delete write path carried a comment
  block spliced mid-sentence (`// row to filter) and a`) that also claimed the
  aggregate companion is passed `undefined`, which it is not. Reverted to the
  pre-branch text with the aggregate case stated separately.
- The eager backfill twin's liveness filter had no coverage (the suite's fixture
  seeds after migration, so its loop never ran); tested, and verified to fail
  with `19` instead of `10` when the filter is removed. Two stale comments fixed,
  the `sql-console` memo cut to the decision plus a pointer, and the 312/313
  README cells cut from ~3,000 characters to the outcome plus a link.

### Spun out rather than absorbed

**Plan 315** — the gate added here is a workaround for `ensureBackfilledIndex`
being memoised per ctx-db instance rather than durably, so **every** table with an
`aggregateIndex` rescans on the first companion touch of every dispatch. Making
that marker durable retires `scanRefusesAny`, its note, and the asymmetry between
the three readers. Pre-existing on `alpha`, found while sizing this gate;
backreferenced from the rebuild it would fix.

### Correction to the docs

`migrations.mdx` claimed `changed: 0` proves a table is fully re-projected. It
does not: the transform also skips a row it cannot re-project at all — a bigint
wider than the 39-digit key, reachable for a uint256-shaped value — and counts it
processed, not changed. The only signal is a `console.warn`. Qualified.

### Cleared on re-audit

Reader-gate symmetry is exact — no input takes the companion that previously got
an answer, and none falls to a scan that now throws where it used to answer.
Companion and scan agree within one request across every op, including empty-group
`null` vs `0`. `reduceExtremeInJs`'s replacement is strictly better than the SQL
reducer for non-projected values (SQL ranked by storage class and could return a
string). No dropped or duplicated hunk from the mid-split reconstruction: all six
raw user-table write sites still pair with `syncAggregates`. Commit ordering
holds — the first stands alone, the second would be red without it.
