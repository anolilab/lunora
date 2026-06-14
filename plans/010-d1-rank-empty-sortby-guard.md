# Plan 010: Guard rank-index pagination against an empty `sortBy`

> **Executor instructions**: Follow step by step; verify; obey STOP conditions;
> update `plans/README.md` when done. Step 0 may convert this to a STOP.
>
> **Drift check**: `git diff --stat 151a3eca..HEAD -- packages/d1/src/d1-ctx-db.ts`
> Reconcile excerpts on change; mismatch ⇒ STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug (edge case)
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

Rank-companion pagination builds its cursor columns from
`[__partition__, ...sortBy, RANK_TIEBREAK]` and only seeks when the decoded
cursor's length matches the column count. If a rank index is ever defined with an
empty `sortBy`, the column set degenerates to `[__partition__, RANK_TIEBREAK]`
and the seek can silently mismatch — returning no results or the wrong page with
no error. The right fix depends on whether an empty-`sortBy` rank index is even
constructible; Step 0 determines that.

## Current state

`packages/d1/src/d1-ctx-db.ts`:

- `rankPageColumns` (`:775-785`):

    ```ts
    const rankPageColumns = (index, sortColumns) => {
        const columns = [{ column: "__partition__", direction: "asc" }];
        for (const [i, sortKey] of index.sortBy.entries()) {
            columns.push({ column: sortColumns[i] ?? sortColumnName(i), direction: sortKey.direction });
        }
        columns.push({ column: RANK_TIEBREAK, direction: "asc" });
        return columns;
    };
    ```

- `buildRankCursorSeek` (`:738-746`):

    ```ts
    const buildRankCursorSeek = (columns, decoded, params) => {
        if (decoded.length !== columns.length) {
            return undefined; // ← silent: a length mismatch produces no seek
        }
        // ...
    };
    ```

## Commands

| Purpose           | Command                                     | Expected |
| ----------------- | ------------------------------------------- | -------- |
| Build deps (once) | `pnpm run build:packages`                   | exit 0   |
| Typecheck         | `pnpm --filter "@cirrus/d1" run lint:types` | exit 0   |
| Tests             | `pnpm --filter "@cirrus/d1" run test`       | all pass |

## Scope

**In scope**: `packages/d1/src/d1-ctx-db.ts` (rank pagination helpers) and the d1
rank/pagination test file.
**Out of scope**: the `IN`-chunk hydration, FTS5 logic, non-rank queries.

## Steps

### Step 0 (discovery — may STOP): can a rank index have empty `sortBy`?

Find where rank indexes are defined/validated:
`grep -rn "rank\|sortBy" packages/server/src packages/values/src packages/codegen/src | grep -i "rank" | head`.
Determine whether the schema builder/validator already requires `sortBy` to be
non-empty for a rank index.

- If it is **already required** (empty `sortBy` is impossible) → the runtime
  mismatch is unreachable. Implement Step 1 as a cheap defensive assertion + a
  unit test, and note in the plan status that this is belt-and-suspenders.
- If empty `sortBy` **is constructible** → implement Step 1 as a real guard and
  add the validation at the definition layer too (but keep edits within
  `d1-ctx-db.ts` unless the definition layer is the only correct place — if it
  requires editing `@cirrus/server`/`@cirrus/values`, STOP and report so the
  operator can rescope).

### Step 1: Make the degenerate case explicit, not silent

In `rankPageColumns` (or its caller), if `index.sortBy.length === 0`, throw a
clear `CirrusError`-style error (match the error construction used elsewhere in
this file — grep for `code:` / `status:` to copy the shape) explaining that a
rank index requires at least one `sortBy` column for stable pagination, rather
than letting `buildRankCursorSeek` silently return `undefined`.

**Verify**: `pnpm --filter "@cirrus/d1" run lint:types` → exit 0.

### Step 2: Test

Add a test asserting that attempting rank pagination on an empty-`sortBy` index
throws the clear error (rather than returning a wrong/empty page). Model on the
existing d1 rank pagination tests.

**Verify**: `pnpm --filter "@cirrus/d1" run test` → all pass.

## Done criteria

- [ ] Empty-`sortBy` rank pagination produces a clear error, never a silent wrong page
- [ ] `pnpm --filter "@cirrus/d1" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/d1" run test` exits 0 with the new case
- [ ] `git status` shows only in-scope files
- [ ] `plans/README.md` updated (note Step-0 outcome in the row's status)

## STOP conditions

- The helpers no longer match the excerpts.
- A proper fix requires editing `@cirrus/server`/`@cirrus/values` schema
  validation (out of this plan's package scope) — report to rescope.

## Maintenance notes

- If rank indexes ever legitimately support zero sort columns, this guard must be
  replaced with correct degenerate-cursor handling.
