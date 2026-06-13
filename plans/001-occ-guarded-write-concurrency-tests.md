# Plan 001: Add dedicated concurrent-writer tests for the OCC guarded write

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c865cfa6..HEAD -- packages/do/src/ctx-db.ts packages/do/__tests__/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (additive tests only; no production code changes)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `c865cfa6`, 2026-06-13

## Why this matters

`runGuardedWrite` in `packages/do/src/ctx-db.ts` is the core optimistic-concurrency
primitive of the whole framework — every `patch`/`replace`/`delete` relies on its
CAS-with-snapshot semantics to turn concurrent-write races into `ConflictError`
(409) instead of silent lost updates. Today the only test that exercises it is
oblique: one trigger test in `ctx-db.triggers.aggregates-rank.test.ts` happens to
provoke a conflict as a side effect. A refactor of the snapshot comparison or the
`changes()` read could silently turn conflicts into lost updates — the exact
failure class OCC exists to prevent — and the suite would stay green.

## Current state

- `packages/do/src/ctx-db.ts` — the database adapter. The OCC primitive
  (around lines 1204–1233; locate by searching for `runGuardedWrite`):

```ts
/** Run a write, remapping a UNIQUE-index breach to a {@link ConflictError} (code `CONFLICT`, 409). */
const runWrite = (sql: SqlExec, table: string, query: string, ...params: unknown[]): void => { ... }

/**
 * Run an optimistic-concurrency-guarded write (a CAS whose `WHERE` includes
 * the row's read-time `__doc__` snapshot) and raise {@link ConflictError} when
 * it touches zero rows — meaning a concurrent write committed during the
 * intervening `await` (before-update trigger / onDelete cascade) and clobbered
 * the snapshot. `changes()` reports the row count of the most recent
 * INSERT/UPDATE/DELETE, available in both workerd SQLite and `node:sqlite`.
 */
const runGuardedWrite = (sql: SqlExec, table: string, query: string, ...params: unknown[]): void => {
    runWrite(sql, table, query, ...params);

    const changedRow = runSql<{ changed: number }>(sql, `SELECT changes() AS changed`).one();

    if (changedRow.changed === 0) {
        throw new ConflictError(`optimistic concurrency conflict on "${table}" — the row changed during this mutation; refetch and retry`);
    }
};
```

- `packages/do/src/transaction.ts:1-19` — `ConflictError` with own-property
  `code: "CONFLICT"` and `status: 409` (structural recognition, no `instanceof`
  needed across packages).
- `packages/do/__tests__/_helpers/node-sqlite.ts` — adapts Node's built-in
  `node:sqlite` to the `SqlExec` surface; this is the preferred test engine
  (25 of 29 ctx-db-adjacent test files use it). Note its header: never call
  `DatabaseSync#exec` (the repo's secret-scan tooling flags it); all statements
  go through `prepare(...).all(...)`.
- `packages/do/__tests__/data-migration.test.ts:254-300` — the exemplar
  interleaving pattern to copy: it gates a `findMany` on a promise so a second
  writer can act inside the first writer's read→decide window, then releases
  the gate and asserts the loser no-oped. Model the new tests on this file's
  structure (its `describe`/`it` style, its `setupWriter()`/`seed()` helpers).
- Existing oblique coverage (do NOT delete or modify):
  `packages/do/__tests__/ctx-db.triggers.aggregates-rank.test.ts:213-220` —
  a before-update trigger mutates the row so a `replace` against the stale
  snapshot conflicts.
- Conventions: TypeScript ESM, **no `.js` extensions on relative imports**,
  named exports only, Vitest. Tests live in `packages/do/__tests__/` and are
  named `<area>.test.ts`.

## Commands you will need

| Purpose   | Command                                          | Expected on success |
|-----------|--------------------------------------------------|---------------------|
| Install   | `pnpm install`                                   | exit 0              |
| Tests     | `pnpm --filter "@cirrus/do" run test`            | all pass            |
| One file  | `pnpm --filter "@cirrus/do" run test -- ctx-db.occ` | new file passes  |
| Typecheck | `pnpm --filter "@cirrus/do" run lint:types`      | exit 0              |
| Lint      | `pnpm --filter "@cirrus/do" run lint:eslint`     | exit 0              |

## Scope

**In scope** (the only files you should modify/create):
- `packages/do/__tests__/ctx-db.occ.test.ts` (create)
- `plans/README.md` (status row update)

**Out of scope** (do NOT touch, even though they look related):
- `packages/do/src/**` — this plan adds tests for existing behavior; if a test
  reveals a real bug, that is a STOP condition, not a license to fix it here.
- `packages/do/__tests__/_helpers/fake-sql.ts` — a separate backlog item covers
  migrating its consumers; don't extend it.
- The workerd integration suite (`packages/do/__tests__/workerd/`) — running
  these scenarios on real workerd SQLite is a separate backlog item.

## Git workflow

- Branch: `test/occ-guarded-write` off `alpha`.
- Conventional commit, e.g. `test(do): add concurrent-writer coverage for the occ guarded write` (imperative, lowercase, ≤50 chars subject).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Read the exemplars

Read `packages/do/__tests__/data-migration.test.ts` fully (especially the
"concurrent runners" describe block at lines 254+) and the top 120 lines of
`packages/do/__tests__/ctx-db.triggers.aggregates-rank.test.ts` to learn how a
writer + schema are set up against the `node-sqlite` helper in this repo.

**Verify**: you can name (a) the helper that creates the SQLite handle and
(b) the function that builds a `DatabaseWriterLike` over it. If after reading
both files you cannot construct a writer the same way, STOP.

### Step 2: Create `ctx-db.occ.test.ts` with a conflict-interleave harness

Create `packages/do/__tests__/ctx-db.occ.test.ts`. Set up a small schema (one
table, a couple of fields) exactly the way the exemplar files do. Write a
helper that starts a guarded mutation (e.g. `patch`) and parks it at an await
boundary (gate a read the same way `data-migration.test.ts:264-285` gates
`findMany`, or use a before-update trigger as in the aggregates-rank test),
commits a competing write to the same row while parked, then releases.

**Verify**: `pnpm --filter "@cirrus/do" run test -- ctx-db.occ` → file runs (even with only one test).

### Step 3: Cover the conflict matrix

Add tests asserting each of the following. For every conflict assertion, check
the thrown error structurally: `error.code === "CONFLICT"` and
`error.status === 409` (own properties — match how `transaction.test.ts`
asserts, if it does; otherwise assert the two properties directly).

1. **patch vs patch**: two writers patch the same row; the parked one throws
   `ConflictError`; the winner's fields are intact afterwards (re-read the row
   and assert its content).
2. **patch vs delete**: the row is deleted while a patch is parked; the patch
   throws `ConflictError`.
3. **delete vs patch**: the row is patched while a delete is parked; the
   delete throws `ConflictError` (the guarded-write doc comment says the
   conflict is raised on the delete path too).
4. **replace vs patch**: same shape as (1) for `replace`.
5. **No false positives**: two writers touching *different* rows of the same
   table both succeed, no `ConflictError`.
6. **State after conflict**: after each conflict, assert the surviving row
   matches the *winner's* write exactly (no partial merge, no lost update).

If `delete` turns out not to use the guarded path (read the `delete`
implementation in `ctx-db.ts` to confirm before writing tests 2/3), adjust to
whatever the code actually guards, and note the discrepancy in your report.

**Verify**: `pnpm --filter "@cirrus/do" run test -- ctx-db.occ` → all new tests pass.

### Step 4: Full package gates

**Verify**:
- `pnpm --filter "@cirrus/do" run test` → all pass (no existing test broken)
- `pnpm --filter "@cirrus/do" run lint:types` → exit 0
- `pnpm --filter "@cirrus/do" run lint:eslint` → exit 0

## Test plan

This plan IS the test plan; the cases are enumerated in Step 3. Structural
pattern: `packages/do/__tests__/data-migration.test.ts`. Engine:
`__tests__/_helpers/node-sqlite.ts` (never `fake-sql.ts` — the guarded write's
`changes()` semantics must run on a real SQLite build).

## Done criteria

- [ ] `packages/do/__tests__/ctx-db.occ.test.ts` exists with ≥6 tests covering the matrix in Step 3
- [ ] `pnpm --filter "@cirrus/do" run test` exits 0
- [ ] `pnpm --filter "@cirrus/do" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/do" run lint:eslint` exits 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `runGuardedWrite` in `ctx-db.ts` no longer matches the excerpt above.
- A test reveals an actual lost update (a conflict that should throw but
  doesn't) — that is a production bug; report it with the failing test, do not
  patch `src/`.
- You cannot find a way to park a mutation at an await boundary using the
  existing helpers after genuinely trying both the gated-read and the trigger
  approach.
- The `delete` path turns out to bypass guarded writes entirely AND you cannot
  tell from the code whether that is intentional.

## Maintenance notes

- These tests pin the CAS semantics; anyone changing the `__doc__` snapshot
  comparison or replacing `changes()` must update them deliberately.
- Follow-up explicitly deferred: running the same matrix on real workerd
  SQLite inside `packages/do/__tests__/workerd/` (backlog item in
  `plans/README.md`), and porting the 4 remaining `fake-sql.ts` consumers to
  the node-sqlite helper.
