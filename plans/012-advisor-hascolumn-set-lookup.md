# Plan 012: Advisor lints use Set lookups instead of O(n) `Array.includes`

> **Executor instructions**: Follow step by step; verify; obey STOP conditions;
> update `plans/README.md` when done.
>
> **Drift check**: `git diff --stat 151a3eca..HEAD -- packages/advisor/src/lints/helpers.ts`
> Reconcile excerpt on change; mismatch ⇒ STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

`hasColumn` does `table.fields.includes(column)` — an O(n) scan — and it's called
inside nested loops (table → index → field, and table → relation → field). On a
large schema this is multiplicative (≈ tables × indexes × fields × tableFields).
Precomputing a `Set` of each table's columns once turns the inner check O(1) and
removes the quadratic factor, with zero behavior change.

## Current state

`packages/advisor/src/lints/helpers.ts:1-12`:

```ts
export const SYSTEM_FIELDS: ReadonlySet<string> = new Set(["_creationTime", "_id"]);

/** True when `column` is a declared or system column of `table`. */
export const hasColumn = (table: AdvisorTable, column: string): boolean => SYSTEM_FIELDS.has(column) || table.fields.includes(column);
```

Callers (for context — find them with `grep -rn "hasColumn(" packages/advisor/src`):
the index/relation "unknown field" lints call it per field within their loops.

## Commands

| Purpose           | Command                                          | Expected |
| ----------------- | ------------------------------------------------ | -------- |
| Build deps (once) | `pnpm run build:packages`                        | exit 0   |
| Typecheck         | `pnpm --filter "@cirrus/advisor" run lint:types` | exit 0   |
| Tests             | `pnpm --filter "@cirrus/advisor" run test`       | all pass |

## Scope

**In scope**: `packages/advisor/src/lints/helpers.ts` and, if you choose the
per-table-Set approach, the lint files that call `hasColumn` in hot loops.
**Out of scope**: lint _semantics_ — output must be byte-for-byte identical.

## Steps

### Step 1: Provide an O(1) column membership check

Pick the lower-churn of these two equivalent approaches:

**(a) Memoize inside the table object's lifetime** — add a helper that builds a
`Set<string>` of a table's columns (declared + system) once and reuse it:

```ts
export const tableColumnSet = (table: AdvisorTable): ReadonlySet<string> => new Set<string>([...SYSTEM_FIELDS, ...table.fields]);

export const hasColumnIn = (columns: ReadonlySet<string>, column: string): boolean => columns.has(column);
```

Then in each hot-loop lint, compute `const cols = tableColumnSet(table)` once
per table (outside the inner field loop) and use `cols.has(field)`.

**(b) Keep `hasColumn`'s signature** but have callers build the Set once per
table and pass it. Choose (a) or (b) to minimize edits.

Keep the existing `hasColumn` if other call sites are not in hot loops (so you
don't have to touch them).

**Verify**: `pnpm --filter "@cirrus/advisor" run lint:types` → exit 0.

### Step 2: Confirm identical lint output

The advisor's existing tests assert the produced findings. Run them — they must
pass unchanged (this is a pure perf refactor).

**Verify**: `pnpm --filter "@cirrus/advisor" run test` → all pass, no snapshot
changes.

## Done criteria

- [ ] Column membership in the index/relation field lints is O(1) per check
- [ ] No change to any lint's findings (existing tests pass unchanged)
- [ ] `pnpm --filter "@cirrus/advisor" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/advisor" run test` exits 0
- [ ] `git status` shows only in-scope files
- [ ] `plans/README.md` updated

## STOP conditions

- Helpers no longer match the excerpt.
- Any existing advisor test output changes — that means behavior drifted; STOP
  and reconcile (the refactor must be behavior-preserving).

## Maintenance notes

- New column-membership checks should use the Set helper inside loops.
