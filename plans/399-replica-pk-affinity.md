# Plan 399: Infer the primary-key column's affinity in LocalMirror so numeric ids stop sorting lexicographically

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/replica/src/local-mirror.ts`
> On any change, compare the "Current state" excerpts against the live code;
> on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (schema-version bump = one-time full re-seed of existing mirrors; by design)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`MIRROR_SCHEMA_VERSION` was bumped to 2 specifically because "TEXT affinity coerces bound integers/reals to text, so `ORDER BY`/comparisons/`SUM`/`AVG` over a numeric column silently returned wrong results" — and the fix inferred affinity for "every **non-PK** column". The primary key was left hard-coded `TEXT PRIMARY KEY NOT NULL` and is structurally excluded from the inference path. So any mirrored table with a numeric primary key still sorts and range-filters lexicographically: `ORDER BY id` puts `10` before `9`, `WHERE id > 5` is a string comparison. Same bug class, same silence, on the one column every table has.

## Current state

`packages/replica/src/local-mirror.ts`:

- `:66-79` — the `MIRROR_SCHEMA_VERSION = 2` docblock quoted above; `#reconcileSchemaVersion` (`:365-371`) drops every mirrored table when the stored version mismatches, so bumping the constant is the supported migration mechanism.
- `:460-461` (inside `#ensureTableSchema`, the `existing.length === 0` create path):
  ```ts
  let columnDefs = `${escapeIdentifier_(pk)} TEXT PRIMARY KEY NOT NULL`;
  ```
- `:416-440` — `#inferColumnAffinities(diff, pk, columns)` skips `key === pk`; `#collectDiffColumns` (`:397-401`) excludes the pk from `requiredColumns`. So the pk never reaches `inferColumnAffinity`.
- The diff shape: `change.id` carries the row id for delete/update (`diff-applier.ts`), and insert/update `change.data` may carry the pk value under the pk key.
- `packages/replica/__tests__/adapters.test.ts:417-450` — the "column affinity" suite covers a non-PK `priority` column only; no numeric-id case.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/replica..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/replica" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/replica" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/replica" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/replica/src/local-mirror.ts`
- `packages/replica/__tests__/adapters.test.ts`

**Out of scope**:
- `packages/replica/src/diff-applier.ts` — id **binding** normalization is plan 402.
- Any change to `SqliteAdapter` implementations.

## Git workflow

- Branch: `improve/wave22-replica`
- Commit: `fix(replica): infer mirror primary-key column affinity`

## Steps

### Step 1: Infer the PK affinity at table creation

In `#ensureTableSchema`'s create path, derive the pk's affinity from the first observed id in the diff before building `columnDefs`: scan `diff.changes` for the first non-null `change.data[pk] ?? change.id` and run it through the existing `inferColumnAffinity`; fall back to `TEXT` when nothing is observed. Keep `PRIMARY KEY NOT NULL`.

```ts
const pkAffinity = LocalMirror.#inferPkAffinity(diff, pk); // "INTEGER" | "REAL" | "TEXT"
let columnDefs = `${escapeIdentifier_(pk)} ${pkAffinity} PRIMARY KEY NOT NULL`;
```

Note the SQLite nuance for the reviewer comment in code: a column declared exactly `INTEGER PRIMARY KEY` becomes the rowid alias — that is acceptable here (the mirror re-creates tables from scratch and only ever binds the server-provided id), but say so in a one-line comment, since it changes `PRAGMA table_info` output.

**Verify**: `pnpm --filter "@lunora/replica" run lint:types` → exit 0.

### Step 2: Bump the schema version

Change `MIRROR_SCHEMA_VERSION` to `3` and extend its docblock with a "Version 3:" paragraph in the same style as the existing "Version 2:" one (PK affinity now inferred; older mirrors re-seed).

**Verify**: `grep -n "MIRROR_SCHEMA_VERSION = 3" packages/replica/src/local-mirror.ts` → one match.

### Step 3: Regression tests

In the existing `describe("column affinity", ...)` block of `packages/replica/__tests__/adapters.test.ts` (model on the `priority` case at `:418-450`):

1. Apply a diff with numeric ids `1, 2, 9, 10` and assert `SELECT id FROM t ORDER BY id` returns `1, 2, 9, 10` (a version-2 mirror returned `1, 10, 2, 9`).
2. Assert a `WHERE id > 5` query returns `9, 10`.
3. Assert a string-id table still declares TEXT (existing behavior unchanged).

**Verify**: `pnpm --filter "@lunora/replica" run test` → all pass including the 3 new cases.

## Test plan

As Step 3; run against every adapter the existing affinity suite parameterizes over (keep whatever `makeAdapter` pattern the block already uses).

## Done criteria

- [ ] `pnpm --filter "@lunora/replica" run test` exits 0 with the new numeric-PK cases
- [ ] `MIRROR_SCHEMA_VERSION` is `3` with a Version-3 docblock paragraph
- [ ] `pnpm --filter "@lunora/replica" run lint:types` and `lint:eslint` exit 0
- [ ] `git status` shows only in-scope files modified

## STOP conditions

- The `columnDefs` excerpt doesn't match the live code.
- The rowid-alias behavior of `INTEGER PRIMARY KEY` breaks an existing test (e.g. an adapter test asserting `PRAGMA table_info` or rowid semantics) — report it; the fallback decision (e.g. quoting the type as `INT`) is the reviewer's call, not yours.
- Mixed id types within one diff (first id numeric, later ids strings) surface an existing test failure — report rather than adding coercion logic.

## Maintenance notes

- Inference is first-observed-value, same trade-off the non-PK path already accepted; a table whose first diff carries only deletes falls back to TEXT and re-seeds correctly later versions won't fix silently — acceptable, documented here.
- The version bump drops and re-seeds every existing mirror once on next open; release notes should mention it.
