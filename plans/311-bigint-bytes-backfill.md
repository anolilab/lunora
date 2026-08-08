# Plan 311 — Rewrite the rows that `v.bigint()`/`v.bytes()` left unqueryable

**Baseline:** `e67cd58a9` (2026-08-08) — the head of `fix/265-wire-codec-query-parity` (#365)
**Status:** TODO
**Priority:** P1 · **Effort:** M · **Risk:** MED · **Category:** data/migration

> **Executor instructions**: this plan has no new mechanism to build. `runDataMigration`
> already does the hard parts; the work is a transform, a detector, and a way to
> invoke it. If you find yourself writing a batch runner, stop — you have missed §2.
>
> **Drift check (run first)**: confirm #365 has merged
> (`git log --oneline origin/alpha -- packages/shard-engine/src/sql-projection.ts`).
> **If it has not, this plan cannot run** — it rewrites rows into a projection that
> only exists on that branch. That is a STOP condition, not a "start early".

## 0. Headline finding

Between `ab0afaf00` (2026-08-03) and #365, the Durable Object row store wrote every
`v.bigint()` column as a **wire-tagged array left in place** at `$.field`. Those rows
read back correctly — `get()` returns a real `bigint` — but the stored text is an
array, so `json_extract` never matches:

| operation              | on a row from that window |
| ---------------------- | ------------------------- |
| `filter` / `withIndex` | never matches             |
| `ORDER BY`             | sorts as text             |
| `SUM`                  | contributes 0             |
| `count`                | 0                         |

#365 fixes every **new** write and heals a row on any `patch`/`replace`, because both
re-encode the whole document. It **migrates nothing on its own**.

**So the exposure is the rows nobody rewrites.** For `@lunora/payment`'s
`paymentSessions` — three `v.bigint()` money columns on a shard-local table — that is
precisely the completed sessions that are never touched again. A settled payment is
the row most likely to be queried by amount and least likely to be written to.

`v.bytes()` has the same shape: stored as a tagged array rather than the base64
projection, so a bytes column is likewise invisible to comparison and reaches the CDC
export un-projected.

## 1. Current state (audit)

- **The healing mechanism already exists and is pinned by test.**
  `packages/shard-engine/__tests__/ctx-db.bigint-bytes.test.ts` — "leaves a
  tagged-in-place row unqueryable until a write re-projects it" seeds a legacy row by
  raw SQL, asserts `findMany({ where: { amountMinor: 10n } })` returns `[]`, applies a
  single-field `patch`, and asserts the row comes back **and** that the stored text is
  now `serializeSqlValue(10n)`. That test is the specification for this plan: a write
  through the normal writer path is sufficient.
- **A legacy row still reads.** The sibling test ("a row whose bigint was stored
  tagged in place still decodes to a bigint") pins that `decodeDocJson` accepts all
  three formats this store has written — pre-codec plain JSON, tagged-in-place, and
  the current projection. So a backfill cannot corrupt a row it visits.
- **Window is bounded.** `ab0afaf00` landed 2026-08-03. Only rows written after it, on
  tables declaring a `v.bigint()` or `v.bytes()` column, are affected.

## 2. Existing seams (do not reinvent)

**`packages/shard-engine/src/data-migration.ts` — `runDataMigration`.** Read its
header comment before writing anything. It already provides:

- **Keyset batching** over `_creationTime ASC, id ASC`, rewriting through the normal
  `DatabaseWriterLike` so triggers fire and subscribers are notified.
- **Resumability** — cursor, counts and status persisted to the reserved
  `__lunora_migrations` table after every batch; a resumed run picks up from the
  stored cursor.
- **Idempotence on completion** — re-running a `completed` migration in the same
  direction is a no-op returning the recorded counts.
- **Cursor stability**, which is the linchpin: `replace` preserves `_id` and
  `_creationTime`, so rewriting a row never moves it relative to the cursor and each
  row is visited exactly once even as the batch ahead is rewritten. **This is exactly
  the property a re-projection backfill needs**, and it is why this plan is a
  transform rather than a runner.
- **`dryRun`** — counts from a fresh scan without touching data or state.

The cross-shard orchestrator that invokes it per shard already exists, as does
`packages/cli/src/commands/migrate/`.

## 3. The behavioural contract to preserve

- **A visited row's decoded value must be unchanged.** The transform is a re-encode,
  not an edit: `decode → encode` with the current projection. Assert equality of the
  decoded document before and after, not of the stored text.
- **Rows already in the current projection must be left alone** — visiting them is
  fine, rewriting them is waste and churns subscribers. Detect and skip.
- **A row with no bigint/bytes column is out of scope.** Do not rewrite a table that
  cannot be affected.
- **Interruption is safe.** Inherited from `runDataMigration`; do not add state.

## 4. Design decisions

1. **Detect on the stored text, not the decoded value.** A decoded document cannot
   tell you which format it came from — that is the whole problem. The signal is the
   `$lunora.wire$` sentinel sitting at a **top-level field that the current projection
   would have projected**. Prefer a SQL-side predicate so a shard with no affected
   rows costs one query rather than a full scan.
2. **Scope by schema, not by scanning every table.** The set of affected tables is
   derivable: any table whose shape declares a `bigint` or `bytes` field. Compute it
   once and skip the rest.
3. **Ship it as a first-party data migration, not a one-off script.** It has to run
   per-shard against deployed data, which is what `runDataMigration` and
   `lunora migrate` already do. A script would need its own transport, auth, resumability and
   cross-shard fan-out — all of which exist.
4. **`dryRun` first is the documented workflow**, since the operator needs the count
   before they need the rewrite.

## 5. Workstreams

| #   | Work                                                                                                                                                                                              | Size |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | Affected-table derivation from the schema (`bigint`/`bytes` in the shape) + the stored-text detector for a legacy row                                                                             | S    |
| 2   | The migration itself: identity transform that forces a re-encode, skipping rows already in the current projection                                                                                 | S    |
| 3   | Wire it to `lunora migrate` with `--dry-run` reporting per-table/per-shard counts                                                                                                                 | M    |
| 4   | Tests: a seeded legacy row becomes queryable; a current-projection row is not rewritten; a mixed table converges; a resumed run does not double-count; `v.bytes()` covered alongside `v.bigint()` | M    |
| 5   | Operator note in the payment docs — what the symptom looked like (amount queries silently missing settled sessions) and how to confirm the backfill is complete                                   | S    |

## 6. Platform parity

**Not applicable** — no `ctx.*` surface, binding, or deploy capability changes. This
rewrites rows through the existing writer path on whichever host is already serving
the shard. Recorded explicitly per the repo convention.

## 7. Phasing & ordering

| Phase | Work        | Gate                                                                                                                                                                          |
| ----- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | #365 merged | `sql-projection.ts` present on `alpha` — **STOP** if absent                                                                                                                   |
| 1     | WS 1–2      | A seeded tagged-in-place row is returned by `filter` after the migration, and its stored text equals `serializeSqlValue(v)` — the same assertion shape the existing test uses |
| 2     | WS 3        | `--dry-run` reports a non-zero count on a seeded shard and zero after the run                                                                                                 |
| 3     | WS 4–5      | Suite green; a second run reports zero rewritten                                                                                                                              |

## 8. Risks & STOP conditions

- **STOP if the detector cannot distinguish a legacy row from a current one.** A
  detector that returns everything turns this into a full-table rewrite of every
  shard — survivable but expensive, and it churns every subscriber. Get the predicate
  right before scaling it.
- **STOP if a rewritten row's decoded value differs from its pre-migration value** in
  any case, including `NaN`, `Infinity`, array-position `undefined`, `Date`, `Map`,
  `Set` and nested bigints. That is data loss, and it is the failure mode this whole
  plan family keeps producing.
- **Watch subscriber churn.** Rewrites go through the normal writer path, so every
  visited row pokes its subscribers. On a large shard that is a thundering herd; batch
  size is the lever.
- **Do not "optimise" with a raw SQL `UPDATE`** over `__doc__`. It would bypass
  triggers, CDC and subscriber notification, and it would re-implement the projection
  a third time — the duplication that caused the original defect.

## 9. Open questions (answer during execution)

- Should the migration be **automatic on deploy** for affected tables, or explicitly
  invoked? Automatic removes the "nobody ran it" failure, but a silent full-table
  rewrite on deploy is its own surprise.
- Is there a cheap **completeness check** an operator can run afterwards (a count of
  rows still matching the detector), and should `lunora doctor` surface it?
- Does the CDC log need the same treatment, or is re-export sufficient?
