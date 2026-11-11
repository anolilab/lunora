# Plan 572 — `append` imports stop building id sets nobody reads

**Baseline:** `79b0c5a6a` (2026-11-11), applied on top of plan 565's commit
**Status:** TODO

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**: this plan runs on branch `fix/improve-565-import-unkeyed-rows`
> AFTER plan 565 is committed. `git log --oneline -2` must show plan 565's commit on top of
> `origin/alpha`. `git diff --stat 79b0c5a6a..HEAD~1 -- packages/cli/src/commands/data-transfer/`
> must be empty (only plan 565 touched them).

Finding row 31 of the 2026-11-11 audit (issue #1527). Depends on plan 565.

## 0. Headline finding

Every import builds two per-table `Set`s of every `_id` in the file — one in the check pass, one
in the write pass — and parses each wire row again to fill them. Only two consumers read the sets:
the import plan (`planImport`, which `planUnlessAppend` skips for `append`, and for `upsert` with
`--yes`, unless `--dry-run`) and the `--mode replace` prune (`pruneMissingRows`). For a large
`append` import both sets are pure memory overhead. (Reported by the audit, unmeasured; this plan
makes a memory claim only, not a timing claim.)

## 1. Current state (audit)

- `packages/cli/src/commands/data-transfer/import-plan.ts` lines 49-87, `recordSourceRow(index,
wireRow)`: parses the wire row, then for a string `_id` adds it to `entry.ids` (and counts
  `duplicates`); otherwise increments `unkeyed`. Plan 565 needs `unkeyed` from the check pass.
- `packages/cli/src/commands/data-transfer/import.ts`:
    - Lines 1181-1192, `planUnlessAppend`:

        ```ts
        (mode === "append" || (mode === "upsert" && options.yes === true)) && options.dryRun !== true
            ? { plan: undefined }
            : planAndConfirm(options, request, sourceIndex, mode);
        ```

    - Line 1246-1247: check pass always records into `sourceIndex`.
    - Lines 1292-1299: the write pass always records into `written`, which only
      `pruneAfterWrite` → `pruneMissingRows` reads, and only for `--mode replace` with deletions.
    - `runImportPass` (line 760) records only when its `sourceIndex` argument is defined (lines
      813-823).
- Tests: `packages/cli/__tests__/commands/import-plan.test.ts` (unit tests for
  `recordSourceRow`, `planImport`), `import-modes.test.ts` (end to end, including replace, upsert
  `--yes` and `--dry-run`).

## 2. Existing seams (do not reinvent)

`runImportPass` already skips recording when its index argument is `undefined`.

## 3. The behavioural contract to preserve

- Every existing test in `import-modes.test.ts` and `import-plan.test.ts` passes unchanged:
  replace's plan and prune, upsert's confirmation, `--dry-run`'s plan output.
- Plan 565's unkeyed warning and resume advice still work for `append` (the check pass still counts
  `unkeyed`).

## 4. Design decisions

- **One predicate.** Add `const needsPlan = (options: ImportCommandOptions, mode: ImportMode): boolean`
  in `import.ts` that is true exactly when `planUnlessAppend` would call `planAndConfirm`, and make
  `planUnlessAppend` use it, so the two cannot drift.
- **Counting-only index.** Give `recordSourceRow` an options argument `{ keepIds: boolean }`
  (default `true`, so existing callers and tests are unchanged). With `keepIds: false` it still
  counts `rows` and `unkeyed` but never touches `ids` or `duplicates`.
- The check pass records with `keepIds: needsPlan(options, mode)`.
- The write pass records into `written` only when `mode === "replace"`; otherwise it passes
  `undefined` to `runImportPass` and hands `pruneAfterWrite` an empty `Map` (which it never reads for
  other modes).
- **Rejected:** removing the per-row parse in the check pass for `append`. `unkeyed` needs it.

## 5. Workstreams

One workstream, size S. Second commit on the plan-565 branch, type `perf`, scope `cli`.

### Commands you will need

Same as plan 565's table (install already done; rebuild not needed unless you changed a
dependency).

| Purpose       | Command (worktree root)                                                                                                      | Expected |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| Test files    | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/import-modes.test.ts __tests__/commands/import-plan.test.ts` | all pass |
| Package tests | `pnpm --filter "@lunora/cli" run test`                                                                                       | all pass |
| Format        | `pnpm exec oxfmt <each changed .ts file>`                                                                                    | exit 0   |
| ESLint        | `pnpm --filter "@lunora/cli" run lint:eslint`                                                                                | exit 0   |
| Types         | `pnpm --filter "@lunora/cli" run lint:types`                                                                                 | exit 0   |

### Scope

**In scope:** `packages/cli/src/commands/data-transfer/import.ts`,
`packages/cli/src/commands/data-transfer/import-plan.ts`,
`packages/cli/__tests__/commands/import-plan.test.ts`,
`packages/cli/__tests__/commands/import-modes.test.ts`.

**Out of scope:** everything else, `plans/README.md`.

### Git workflow

- Same branch as plan 565, a second commit:
  `perf(cli): skip import id sets when no plan or prune reads them`; body ≤ 3 lines; last line
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

Same as plan 565.

### Step 1: Write the failing tests

In `import-plan.test.ts`:

1. `recordSourceRow(index, row, { keepIds: false })` over rows with and without `_id`: `rows` and
   `unkeyed` are counted, `ids.size` is `0`, `duplicates` is `0`.
2. Without the third argument, behaviour is as today (existing tests cover it; keep them).

If you export `needsPlan` (export it from `import.ts` only if the tests need it, as a named export),
add a truth-table test: append → false; append + dryRun → true; upsert + yes → false; upsert → true;
replace → true; require-empty → true. Match the modes in `IMPORT_MODES`.

**Verify:** test-files command → the new tests FAIL (unknown option / missing export).

### Step 2: Implement

Per section 4.

**Verify:** test-files command passes; all existing tests in both files pass.

### Step 3: Gates, then commit

**Verify:** format, ESLint, types, package tests exit 0. Commit. `git status --short` empty.

### Step 4: Prove the tests need the fix (after the commit; no stash)

```bash
git show HEAD~1:packages/cli/src/commands/data-transfer/import-plan.ts > packages/cli/src/commands/data-transfer/import-plan.ts
pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/import-plan.test.ts   # keepIds test FAILS
git checkout HEAD -- packages/cli/src/commands/data-transfer/import-plan.ts
git status --short   # empty
```

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase | Work                      | Gate                                                                       |
| ----- | ------------------------- | -------------------------------------------------------------------------- |
| 1     | Steps 1-4, after plan 565 | new tests red on the plan-565 commit, green with this one; cli gates green |

## 8. Risks & STOP conditions

- **STOP** if plan 565's commit is not the branch tip's parent.
- **STOP** if any existing replace/upsert/dry-run test fails; the predicate is wrong.
- **Risk:** a future consumer of `written` for another mode. Mitigate: the doc comment on the
  write-pass call says which consumer needs it.

## 9. Open questions

1. None.

## Done criteria

- [ ] `pnpm --filter "@lunora/cli" run test`, `lint:eslint`, `lint:types` exit 0.
- [ ] `planUnlessAppend` calls `needsPlan` (grep).
- [ ] `git diff --stat HEAD~1..HEAD` lists only in-scope files.

## Maintenance notes

A new mode that plans or prunes must be added to `needsPlan`, nowhere else.
