# Plan 612: A write to a soft-deleted row never re-enters the shard rank companion

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 093c5e41f..HEAD -- packages/shard-engine/src/ctx-db-companions.ts packages/shard-engine/__tests__/_scenarios/ctx-db.soft-delete.companions.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `093c5e41f` (2026-11-20)
**Status:** TODO

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `093c5e41f`, 2026-11-20
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

A table with `.softDelete()` and a rank index (leaderboards: `ctx.db.rank()` / `rankPage()`) keeps a companion SQL table with one entry per _live_ row. A soft delete removes the entry. But if anything later patches the still-deleted row and changes a field the rank index reads (a `set null` cascade on a ranked foreign key, an `$onUpdateFn` sort column, an admin fix-up), the shard writer re-inserts the deleted row into the companion. `rank()` then counts a deleted row, and a later `restore()` fails with a duplicate primary key because it force-inserts an entry that already exists. The SQL/D1 twin of this code already has the guard; the Durable Object twin does not.

## Current state

- `packages/shard-engine/src/ctx-db-companions.ts` — companion maintenance for the DO writer.
    - `syncRankIndexEntry` (line 255) — the function missing the guard.
    - `createCompanionSync` (starts ~line 360) has `const softDeleteFieldFor = (tableName: string): string | undefined => schema.tables[tableName]?.softDeleteMode?.field;` at line 371.
    - `syncRanks` (line 733) calls `syncRankIndexEntry` per index.
    - `isLiveForCompanion` is already imported (line 57) from `./query-args`: `(document, field) => field === undefined || document[field] === null || document[field] === undefined`.
- `packages/sql-store/src/ctx-db.ts:2756-2797` — the twin that has the guard (read-only reference, do not edit).

`ctx-db-companions.ts:255-282` today:

```ts
const syncRankIndexEntry = (
    sql: SqlExec,
    tableName: string,
    index: RankIndexDefinitionLike,
    id: string,
    previous: Record<string, unknown> | undefined,
    next: Record<string, unknown> | undefined,
): void => {
    // Fast path: both sides exist and no field this index reads changed — the
    // companion entry is already correct, so skip the DELETE+INSERT pair.
    if (previous && next && rankIndexFieldsUnchanged(index, previous, next)) {
        return;
    }

    const rankTable = rankTableName(tableName, index.name);

    if (previous) {
        runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(rankTable)} WHERE ${dsql.identifier("__id__")} = ${id}`);
    }

    if (!next || (index.where && !matchesRankStaticWhere(next, index.where))) {
        return;
    }

    insertRankRow(sql, rankTable, index, rankColumnsSql(index), id, next);
};
```

`ctx-db-companions.ts:733-737`:

```ts
const syncRanks = (tableName: string, id: string, previous: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined): void => {
    for (const index of schema.tables[tableName]?.rankIndexes ?? []) {
        syncRankIndexEntry(sql, tableName, index, id, previous, next);
    }
};
```

How `restore()` depends on this (`packages/shard-engine/src/ctx-db.ts:5044-5087`, do not edit): it patches the marker to `null` (the patch's rank sync takes the "fields unchanged" fast path), then calls `syncRanks(tableName, id, undefined, located.row)` where `located.row` is the **pre-restore** image, which still carries the non-null marker. So the guard must NOT block that call. Solve this the way described in step 1 (strip the marker at the restore call site is out of scope; instead the guard lives in `syncRanks` and `restore`'s forced insert bypasses it through a dedicated entry).

Test scenario file: `packages/shard-engine/__tests__/_scenarios/ctx-db.soft-delete.companions.ts`. It exports `runSoftDeleteCompanionScenarios(factory)` and is run twice: on `node:sqlite` by `__tests__/ctx-db.soft-delete.companions.test.ts` and on workerd by a gated suite. Its first `describe("soft delete — rank companion")` (line 34) has the schema `scores` with `rankIndexes: [{ name: "by_score", on: "scores", sortBy: [{ direction: "desc", field: "score" }] }]`, `softDeleteMode: { field: "deletedAt" }`, a `setup()` inserting `s1/s2/s3` with scores 10/20/30, and an existing test "excludes a soft-deleted row from rankPage, and restore re-adds it" (line 68) — read it and copy its style and the reader calls it uses.

### Repo conventions that apply (from the repo's AGENTS.md — you have not read it, so they are inlined)

- TypeScript, ESM, `"moduleResolution": "bundler"`: relative imports have **no** file extension (`from "./foo"`, never `"./foo.js"`).
- Never mix a default export with named exports in one file. More than one export ⇒ named only.
- This is a pre-release (`1.0.0-alpha.*`) line: do **not** keep backward-compat shims or deprecated aliases; change the behaviour and update every call site.
- Comments say _why_ (a constraint or invariant), never restate the code or record history.
- An `eslint-disable` must be line-scoped, name the rule, and give a reason after `--`. Never add a file-level disable. Never skip or silence a test, type error or lint rule to get green.
- Tests are Vitest, live in the package's `__tests__/`, and **wait on a milestone, never on a clock** (no `sleep`, no real `setTimeout` waits). Existing tests start with `expect.assertions(n)`; match that.
- **A test must fail without the fix.** After writing a test, temporarily revert your fix, run the test, confirm it goes red, then restore the fix. Report that you did this.
- If you fix by hand: run Prettier before ESLint.
- Never run `pnpm -r run test`, never `pnpm run test:workerd`, never `pnpm run build:packages` (other sessions share this machine; those have crashed it). Use the single-package commands below.
- Never kill a process by name/pattern. Never `git add -A` / `git commit -a` / `git stash`; stage explicit paths.

## Commands you will need

Run everything from the repo (worktree) root. `dist/` is not committed, so build the package and its workspace dependencies once before testing or type-checking.

| Purpose                       | Command                                                                                                | Expected on success |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                                                       | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/shard-engine..." run build`                                                    | exit 0              |
| One test file                 | `pnpm --filter "@lunora/shard-engine" exec vitest run __tests__/ctx-db.soft-delete.companions.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/shard-engine" run test`                                                        | all pass            |
| Types                         | `pnpm --filter "@lunora/shard-engine" run lint:types`                                                  | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/shard-engine" run lint:eslint`                                                 | exit 0, 0 warnings  |

## Scope

**In scope**:

- `packages/shard-engine/src/ctx-db-companions.ts`
- `packages/shard-engine/src/ctx-db.ts` — **only** the single `syncRanks(located.tableName, id, undefined, located.row)` call inside `restore` (~line 5085), if step 1 option B is needed
- `packages/shard-engine/__tests__/_scenarios/ctx-db.soft-delete.companions.ts`

**Out of scope**:

- `packages/sql-store/**` — already correct.
- The rank rebuild path (`rebuildRankCompanion`) — already filters live rows.
- Any other method in `ctx-db.ts`.

## Git workflow

- Branch: `fix/537-rank-companion-soft-delete` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Example from this repo: `fix(auth): address API key review comments`. Use: `fix(shard-engine): keep deleted rows out of rank companion`.
- Never use `--no-verify`. Do NOT push or open a PR.

## Steps

### Step 1: guard the insert

In `syncRanks` (inside `createCompanionSync`), compute the soft-delete field once and pass liveness down:

1. Add a parameter to `syncRankIndexEntry`: `softField: string | undefined` (place it after `index`). Update its doc comment: INSERT only when the new row qualifies against the static `where` **and is live** — a soft-deleted row's entry was dropped by the delete and a later write into the still-deleted row must not resurrect it.
2. Change the "nothing to insert" condition to:
   `if (!next || !isLiveForCompanion(next, softField) || (index.where && !matchesRankStaticWhere(next, index.where))) { return; }`
   The `DELETE` above it stays unconditional on `previous`.
3. In `syncRanks`, pass `softDeleteFieldFor(tableName)`.
4. `restore()` in `ctx-db.ts` passes the pre-restore row (marker still set) as `next`, which the new guard would now skip — breaking restore. Fix at that one call site: pass the row with the marker cleared, i.e. `syncRanks(located.tableName, id, undefined, { ...located.row, [field]: null })` with a line-scoped `// eslint-disable-next-line unicorn/no-null -- the restored image carries a SQL NULL marker` if ESLint asks for it. (`field` is already in scope there.) Update the adjacent comment only if it becomes inaccurate.
5. Check every other caller: `rg -n "syncRankIndexEntry\\(|syncRanks\\(" packages/shard-engine/src`. `syncCompanionsForInsert` (line ~816) passes a fresh document — fine. Any caller that passes a soft-deleted `next` on purpose is a STOP.

**Verify**: `pnpm --filter "@lunora/shard-engine" run lint:types` → exit 0; `pnpm --filter "@lunora/shard-engine" exec vitest run __tests__/ctx-db.soft-delete.companions.test.ts __tests__/ctx-db.rank.test.ts` → all pass (existing restore test still green).

### Step 2: add the regression tests

In the scenario file's `describe("soft delete — rank companion")`, add:

1. **"a write to a soft-deleted row does not re-enter the rank companion"** — `setup()`, soft-delete `s2` (`writer.delete("scores", "s2")`), then `writer.patch("scores", "s2", { score: 99 })`. Assert the rank reads used by the existing test at line 68 return only `s3, s1` and a total of 2. Also assert directly on the companion table: `harness.sql` count of rows in the rank table for `scores`/`by_score` is 2 (import `rankTableName` from the same module the source uses — find it with `rg -n "rankTableName" packages/shard-engine/src | head -3`; mirror how the aggregate test in this file queries `aggregateTableName`).
2. **"restore after such a write re-adds the row exactly once, at its new position"** — continue from case 1 (fresh setup): `await writer.restore("scores", "s2")` must resolve (no duplicate-key throw); rank order is `s2(99), s3, s1`; companion row count 3.

If `writer.patch` refuses a soft-deleted row by design in this writer, use the path that does reach it (the existing tests in `ctx-db.soft-delete.test.ts` show which writes can target a deleted row); if none can, STOP.

**Verify**: the scenario test file passes. **Verify red**: revert step 1's condition change (keep the signature), rerun → both new tests fail. Restore.

## Test plan

Steps 2. Then `pnpm --filter "@lunora/shard-engine" run test` → all pass. The workerd twin of this scenario runs in CI only; do not run it.

## Done criteria

- [ ] `pnpm --filter "@lunora/shard-engine" run lint:types` and `run lint:eslint` exit 0
- [ ] `pnpm --filter "@lunora/shard-engine" run test` exits 0 with 2 new tests
- [ ] `rg -n "isLiveForCompanion\\(next" packages/shard-engine/src/ctx-db-companions.ts` has one match
- [ ] `git status --short` lists only in-scope files

## STOP conditions

- Excerpts do not match.
- A caller other than `restore` passes a soft-deleted `next` intentionally.
- No write path can reach a soft-deleted row in a test.
- An existing rank/soft-delete/trigger test fails after step 1 and the cause is not the restore call site.

## Maintenance notes

- This brings the DO twin in line with `packages/sql-store/src/ctx-db.ts:2756-2797`. Plan 623 (dialect seam) exists because these two drift; this test is one of its characterization tests.
- Reviewer: confirm `restore` still re-adds exactly once, and that the reviewer runs `pnpm run test:workerd` before merge (SQL path).
