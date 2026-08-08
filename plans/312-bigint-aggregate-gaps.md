# Plan 312 — Close the two gaps that leave a `v.bigint()` column unaggregatable

**Baseline:** `e67cd58a9` (2026-08-08) — the head of `fix/265-wire-codec-query-parity` (#365)
**Status:** TODO
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
   `ctx-db.ts:2467` takes the maintained-companion fast path only when
   `definition.aggregateIndexes && !aggOptions.baseWhere && !hasRelation && !aggScope`.
   For a soft-delete table `aggScope` is _always_ truthy (`:2451`
   `softDeleteScope(definition.softDeleteMode, undefined)`), so every aggregate falls
   to the SQL scan — which now refuses a `v.bigint()` field rather than coerce padded
   text into the ~1.5e40 that falls out of it. Net effect: **no aggregate over a
   bigint column on a soft-delete table**, even for values well inside 2^53.

2. **Declaring `aggregateIndex` on a bigint column caps that column's writes at
   2^53.** `aggregate-tally.ts:62` refuses a magnitude past `MAX_SAFE_BIGINT`, because
   the companion's `__value__` is a REAL column that cannot hold it exactly. The
   refusal fires on the **write**, not the read — so one index declaration makes the
   column unusable for large values, which is the opposite of the direction people
   reach for `v.bigint()` in.

Neither is a regression: before #365 the scan answer was garbage (`SUM` read 0) and
the write path threw for a different reason. Both are now correct-but-narrow, and the
combination is the gap.

## 1. Current state (audit)

- `packages/shard-engine/src/ctx-db.ts:2451` — `aggScope` computed unconditionally
  from `softDeleteMode`.
- `packages/shard-engine/src/ctx-db.ts:2467` — the fast-path predicate that `aggScope`
  disqualifies.
- `packages/shard-engine/src/aggregate-tally.ts:18-19` — `MAX_SAFE_BIGINT`, documented
  as "the largest magnitude the companion's REAL `__value__` column holds exactly".
- `packages/shard-engine/src/aggregate-tally.ts:62-65` — the write-side refusal, whose
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
