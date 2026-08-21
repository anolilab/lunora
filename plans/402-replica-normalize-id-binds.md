# Plan 402: Normalize the row id in diff-applier binds like every other bound value

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/replica/src/diff-applier.ts`
> On any change, compare the "Current state" excerpts against the live code;
> on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (normalization is identity for the string/number ids that occur in practice)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`normalizeBindValue` exists (its docblock says so verbatim) because a value the driver rejects "previously took the ENTIRE diff's transaction down with it (including unrelated rows in the same batch)" — `better-sqlite3` throws `TypeError: can only bind numbers, strings, bigints, buffers, and null` on anything else. Every `SET` value goes through it; the row id — the one value present in *every* DELETE and UPDATE statement — does not. A diff whose `change.id` is a boolean, object, or `undefined` (untrusted server payload; no type guard rejects it) throws inside `database.transaction()` and rolls back the whole batch, exactly the blast radius the normalizer was written to contain.

## Current state

`packages/replica/src/diff-applier.ts` (inside `applySingleDiff`):

- `:90` (delete path):
  ```ts
  database.exec(`DELETE FROM ${table} WHERE ${pk} = ?`, [change.id]);
  ```
- `:113-114` (update path):
  ```ts
  const sql = `UPDATE ${table} SET ${setClause(keys)} WHERE ${pk} = ?`;
  const values = [...keys.map((k) => normalizeBindValue(data[k])), change.id];
  ```
- `:22-28` — the `normalizeBindValue` docblock quoted above; the insert path (`:101`) already normalizes everything including the pk (it rides in `data`).
- `:139-142` — `applyDiffToDatabase` wraps `applySingleDiff` in `database.transaction`.

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
- `packages/replica/src/diff-applier.ts` (the two bind sites)
- The existing diff-applier test file (find it: `ls packages/replica/__tests__/ | grep -i diff`)

**Out of scope**:
- `local-mirror.ts` — PK column *affinity* is plan 399; this plan is only about bind-time normalization.
- `normalizeBindValue` itself — its mapping is correct; only the two call sites change.

## Git workflow

- Branch: `improve/wave22-replica`
- Commit: `fix(replica): normalize row-id binds in diff applier`

## Steps

### Step 1: Wrap both id binds

```ts
database.exec(`DELETE FROM ${table} WHERE ${pk} = ?`, [normalizeBindValue(change.id)]);
...
const values = [...keys.map((k) => normalizeBindValue(data[k])), normalizeBindValue(change.id)];
```

**Verify**: `grep -n "change.id" packages/replica/src/diff-applier.ts` → every bind-position occurrence is wrapped in `normalizeBindValue(...)`.

### Step 2: Regression test

In the diff-applier test file, add a case: a batch containing one good insert plus a delete whose `id` is a boolean (cast through `as never` per shoehorn/test conventions in the file) must apply the good row and not throw — i.e. the transaction survives. Model the structure on the existing test that exercises `normalizeBindValue` for data values (search the test file for `normalize` or `boolean`).

**Verify**: `pnpm --filter "@lunora/replica" run test` → all pass including the new case.

## Test plan

- The Step 2 case (batch survives a weird id) plus existing suite green.

## Done criteria

- [ ] Both id binds route through `normalizeBindValue` (grep from Step 1)
- [ ] `pnpm --filter "@lunora/replica" run test` exits 0 with the new case
- [ ] `pnpm --filter "@lunora/replica" run lint:types` and `lint:eslint` exit 0
- [ ] `git status` shows only in-scope files modified

## STOP conditions

- The two excerpts don't match the live code.
- `normalizeBindValue`'s mapping of a boolean id (→ `1`/`0`) breaks an existing assertion about delete semantics — report; the choice between coercing and skipping the change is the reviewer's.

## Maintenance notes

- If a future change adds another statement shape here (upsert-by-id etc.), every bound parameter must route through `normalizeBindValue` — that invariant is now uniform, keep it that way.
