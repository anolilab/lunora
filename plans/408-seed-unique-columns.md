# Plan 408: Teach the seeder about `.unique()` columns so bounded generators stop colliding

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/seed/src/introspect.ts packages/seed/src/plan.ts packages/seed/src/generate-value.ts`
> On any change, compare the "Current state" excerpts against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`@lunora/seed` generates each row's cells independently and never reads the `unique` flag that `@lunora/values` puts on column metadata (`.unique()` "synthesizes a unique index", `packages/values/src/v.ts:200-202`, created for real by `packages/shard-engine/src/ctx-db-migrations.ts`). Seeding a table with a unique enum column at the default count of 10 is guaranteed to collide (`copycat.oneOf` over the enum domain); a unique plain-string column at the studio's `MAX_GENERATE_ROWS = 200` (`packages/studio/src/lib/seed-data.ts:28`) near-certainly collides against faker's lorem pool (`copycat.word`). The failure is a raw SQLite UNIQUE-constraint error with no attribution to the column. Auth tables mark columns unique (`packages/auth/src/schema.ts:78-80`), so this bites the standard stack.

## Current state

- `packages/seed/src/introspect.ts:18` — the meta type already declares the flag but nothing reads it:
    ```ts
    column?: { defaultFn?: unknown; defaultValue?: unknown; notNull?: boolean; unique?: boolean };
    ```
- `packages/seed/src/introspect.ts:36-50` — `FieldSpec` has no `unique` field; `describeField` (`:72-90`) builds specs from `meta.column?.notNull` etc. but never touches `unique`.
- `packages/seed/src/plan.ts:234-267` — rows are generated per-cell via `cellInput(seed, table, index, column)`; no cross-row uniqueness handling.
- `packages/seed/src/generate-value.ts:140-144` — enum-constrained columns go through `copycat.oneOf(input, constraints.enum)`; `:113-116` — unmatched string columns fall back to `copycat.word(input)`.

## Commands you will need

| Purpose    | Command                                        | Expected on success |
| ---------- | ---------------------------------------------- | ------------------- |
| Install    | `pnpm install`                                 | exit 0              |
| Build deps | `pnpm --filter "@lunora/seed..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/seed" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/seed" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/seed" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/seed/src/introspect.ts` (carry `unique` into `FieldSpec`)
- `packages/seed/src/generate-value.ts` and/or `packages/seed/src/plan.ts` (unique-aware generation)
- `packages/seed/__tests__/` (new cases in the existing test files)

**Out of scope**:

- `packages/values` — the metadata already exists; do not change it.
- `packages/studio/src/lib/seed-data.ts` — the studio's mirror generator is a separate surface; note parity in the commit body but do not edit it here.
- Golden/deterministic outputs for non-unique columns — existing generated values must not change.

## Git workflow

- Branch: `improve/wave22-seed`
- Commit: `fix(seed): generate collision-free values for unique columns`

## Steps

### Step 1: Carry `unique` into `FieldSpec`

In `introspect.ts`, add `unique: boolean` to `FieldSpec` and set it in `describeField` from `meta.column?.unique === true`. Mirror how `nullable` reads `meta.column?.notNull` (`:82-88`).

**Verify**: `pnpm --filter "@lunora/seed" run lint:types` → exit 0.

### Step 2: Unique-aware value generation

Where the cell value is produced (follow `cellInput` from `plan.ts:234-267` into `generate-value.ts`):

- For a **unique string-kind** column: make the value row-unique by deriving it from the absolute row index — e.g. suffix the generated value with `-${index}` (keep the heuristic prefix so `email`-style columns still look like emails: `local+3@domain`-style is fine), or use `copycat.uuid(input)` when no heuristic matched. Deterministic per (seed, table, index, column) like everything else.
- For a **unique bounded-domain** column (enum constraint, boolean kind): if the requested row count exceeds the domain size, fail fast _before generating_ with a named error identifying table, column, domain size, and requested count (use the package's existing error type — find it with `grep -rn "LunoraError\|SeedError" packages/seed/src | head`). If count ≤ domain size, deal values without replacement (index into a deterministic shuffle of the domain).
- Non-unique columns: completely untouched code path.

**Verify**: `pnpm --filter "@lunora/seed" run test` → existing tests all pass (proves non-unique outputs unchanged).

### Step 3: Tests

**Verify**: `pnpm --filter "@lunora/seed" run test` → all pass including new ones.

## Test plan

In the existing seed test files (find the generator tests: `ls packages/seed/__tests__/`):

1. Unique string column, count 200 → 200 distinct values, deterministic across two runs with the same seed.
2. Unique enum column with 3 members, count 3 → the 3 members, no duplicates.
3. Unique enum column with 3 members, count 10 → throws the named error mentioning the column and counts (assert on message fragments).
4. Non-unique column snapshot/equality: value for a fixed (seed, index) is byte-identical before/after this change (write the assertion against the current output first).

## Done criteria

- [ ] `pnpm --filter "@lunora/seed" run test` exits 0 with the 4 new tests
- [ ] `pnpm --filter "@lunora/seed" run lint:types` and `lint:eslint` exit 0
- [ ] Non-unique generation unchanged (test 4 passes without adjusting its expectation)
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The "Current state" excerpts don't match the live code.
- Making unique values deterministic requires threading new state through more than the introspect→plan→generate path (e.g. a global registry) — report the design instead of building it.
- `meta.column.unique` turns out not to be populated by `@lunora/values` at runtime (check with a quick unit: `defineTable({...}).x.unique()` → inspect `_meta`); if the flag never arrives, the fix belongs in `@lunora/values` and that is out of scope — STOP and report.

## Maintenance notes

- The studio's `seed-data.ts` generator has the same blindness; a follow-up should port this (deferred deliberately).
- Reviewer: check determinism — same seed must yield the same rows across runs and platforms.
