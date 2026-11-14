# Plan 565 — `lunora import` stops promising a duplicate-free re-run for rows without `_id`

**Baseline:** `79b0c5a6a` (2026-11-11)
**Status:** DONE (APPROVED after 1 revision; PR #1559, branch fix/improve-565-import-unkeyed-rows)

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 79b0c5a6a..HEAD -- packages/cli/src/commands/data-transfer/import.ts packages/cli/src/commands/data-transfer/import-plan.ts packages/cli/__tests__/commands/import-modes.test.ts packages/cli/__tests__/commands/import-plan.test.ts`
> Empty output expected; otherwise compare section 1 with the live code and STOP on a mismatch.

Finding row 23 of the 2026-11-11 audit (issue #1527). Plan 572 (row 31) is a second commit on the
same branch and depends on this one.

## 0. Headline finding

When an `append` or `upsert` import fails part-way, the CLI tells the operator to "re-run the same
command to resume (existing rows conflict rather than duplicate)". That is false for rows without an
`_id`: the target mints a fresh id for each, so the re-run inserts the already-written ones again
and reports them as `inserted`. Bare documents imported with `--table`, and NDJSON envelopes
without `_id`, are exactly such rows.

## 1. Current state (audit)

- `packages/cli/src/commands/data-transfer/import.ts`:
    - Lines 493-548, `drainIntoBatcher(stream, toWireRow, batcher, logger)` — its `catch` (lines
      533-547) prints:

        ```ts
        if (batcher.totals.received === 0) {
            logger.error(`import failed before any batch was acknowledged: ${message}`);
            logger.error("re-run the same command once the worker is reachable (existing rows conflict rather than duplicate)");
        } else {
            logger.error(`import failed part-way through: ${message}`);
            logger.error("the rows below had already been written — re-run the same command to resume (existing rows conflict rather than duplicate)");
        }
        ```

    - Lines 760-830, `runImportPass(options, source, storage, target, sourceIndex?)` — calls
      `drainIntoBatcher(stream, indexedToRow, batcher, options.logger)` at line 827; when
      `sourceIndex` is given, every emitted wire row is recorded with `recordSourceRow`.
    - Lines 1196-1358, `runImportCommand`: line 1246 builds `sourceIndex`, line 1247 runs the quiet
      check pass (`quietOptions(options)`, whose logger prints nothing) with it, line 1258 plans
      (`planUnlessAppend`), line 1292-1299 runs the write pass with a second index, `written`.
- `packages/cli/src/commands/data-transfer/import-plan.ts`:
    - Line 43: `type SourceIndex = Map<string, { duplicates: number; ids: Set<string>; rows: number; unkeyed: number }>;`
    - Lines 49-87, `recordSourceRow` counts `unkeyed` per table for rows whose `doc._id` is not a
      string.
    - Lines 112-125: only `--mode replace` refuses unkeyed rows, with the comment "A row with no `_id`
      is written under a fresh one".
- Tests: `packages/cli/__tests__/commands/import-modes.test.ts` drives `runImportCommand` against
  `fakeWorker` (an in-memory worker, lines 28-140) and captures log lines (see the test at line 225,
  which asserts on an error line with `toMatch`). `packages/cli/__tests__/commands/import-plan.test.ts`
  unit-tests `recordSourceRow` (line 79 records a row with no `_id`).

## 2. Existing seams (do not reinvent)

The check pass already counts `unkeyed` per table in `SourceIndex`; no new read of the file is
needed.

## 3. The behavioural contract to preserve

- When every row carries an `_id`, both failure messages are exactly as today and no new warning is
  printed.
- `--mode replace` still refuses unkeyed rows exactly as today.
- Exit codes and the JSON summary document are unchanged.

## 4. Design decisions

- **Warn before writing.** After the check pass (and its refusal check) and before any blob or row
  moves, when the mode is `append` or `upsert` and any table has `unkeyed > 0`, log ONE warning
  naming the total and the per-table counts, e.g.
  `"12 row(s) have no _id (events: 10, logs: 2): the target gives each a fresh id, so if this import stops part-way, re-running it writes the ones already imported a second time"`.
- **Truthful resume advice.** Pass the file's unkeyed total into `drainIntoBatcher` (new parameter,
  threaded through `runImportPass`; the check pass passes `0`). When it is `0`, print today's text.
  When it is non-zero, replace the parenthesis in both messages with the duplication warning, e.g.
  part-way: `"the rows below had already been written — re-running the same command duplicates the N row(s) without an _id that already landed; give every row an _id (or remove the imported ones) before re-running"`.
  The `received === 0` branch says the same thing conditionally ("any that did land"), because a
  committed batch whose response was lost still counts zero.
- Add a small exported helper in `import-plan.ts`, `unkeyedRows(index: SourceIndex): number`, that
  sums `unkeyed`, so the warning and the advice share one count.
- **Rejected:** refusing unkeyed rows under `append`/`upsert`. Appending keyless rows is a valid,
  documented use; the defect is only the advice.

## 5. Workstreams

One workstream, size S. One commit, type `fix`, scope `cli`.

### Commands you will need

| Purpose         | Command (worktree root)                                                                                                      | Expected |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| Install         | `pnpm install --frozen-lockfile`                                                                                             | exit 0   |
| Build deps once | `pnpm --filter "@lunora/cli..." run build`                                                                                   | exit 0   |
| Test files      | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/import-modes.test.ts __tests__/commands/import-plan.test.ts` | all pass |
| Package tests   | `pnpm --filter "@lunora/cli" run test`                                                                                       | all pass |
| Format          | `pnpm exec oxfmt <each changed .ts file>`                                                                                    | exit 0   |
| ESLint          | `pnpm --filter "@lunora/cli" run lint:eslint`                                                                                | exit 0   |
| Types           | `pnpm --filter "@lunora/cli" run lint:types`                                                                                 | exit 0   |

### Scope

**In scope:** `packages/cli/src/commands/data-transfer/import.ts`,
`packages/cli/src/commands/data-transfer/import-plan.ts`,
`packages/cli/__tests__/commands/import-modes.test.ts`,
`packages/cli/__tests__/commands/import-plan.test.ts`.

**Out of scope:** `import-rows.ts`, the batcher, every `sources/*` reader, the worker-side import
endpoint, `plans/README.md`.

### Git workflow

- Branch `fix/improve-565-import-unkeyed-rows`, from `origin/alpha`. Do not push.
- One commit: `fix(cli): stop promising a safe import re-run for rows without _id`; body ≤ 4 lines;
  last line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

- Work only inside your worktree; absolute paths or `cd <worktree> &&` in every shell call.
- Never run `pnpm run test:workerd`, `pnpm run build:packages`, `pnpm run build`, repo-root
  `pnpm run test`, or `pnpm -r …`. Never kill a process by pattern.
- oxfmt before ESLint. No `.js` import extensions. Named exports only. Comments say why.
- Tests await results, never timers. No `.skip`, `@ts-expect-error`, `as any`, or new
  `eslint-disable` without rule + `-- reason`.

### Step 1: Install and build

**Verify:** exit 0.

### Step 2: Write the failing tests

In `import-modes.test.ts`, using `fakeWorker` and the file's log-capturing pattern:

1. An `append` import of an NDJSON file (or `--table` bare documents, whichever the file's other
   tests already set up) where some rows have no `_id`, against a worker that fails part-way (make
   the second batch request throw, with `batchSize` small enough that there are at least two
   batches). Assert an error line matches `/duplicates|a second time/u` and NO line contains
   `conflict rather than duplicate`.
2. The same file, successful run: a warning line before the import mentions the unkeyed count.
3. A file where every row has an `_id`, failing part-way: the line still contains
   `conflict rather than duplicate`, and no unkeyed warning is printed.

In `import-plan.test.ts`: `unkeyedRows` sums `unkeyed` over tables.

**Verify:** test-files command → tests 1, 2 and the `unkeyedRows` test FAIL; test 3 passes.

### Step 3: Implement

Per section 4.

**Verify:** test-files command passes.

### Step 4: Gates, then commit

**Verify:** format, ESLint, types, package tests exit 0. Commit. `git status --short` empty.

### Step 5: Prove the tests need the fix (after the commit; no stash)

```bash
git show 79b0c5a6a:packages/cli/src/commands/data-transfer/import.ts > packages/cli/src/commands/data-transfer/import.ts
pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/import-modes.test.ts   # tests 1 and 2 FAIL
git checkout HEAD -- packages/cli/src/commands/data-transfer/import.ts
git status --short   # empty
```

(`import-plan.ts` is not reverted here: its new helper is imported by the new `import.ts`, and the
`unkeyedRows` test failing on the base is shown by step 2.)

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase | Work                        | Gate                                                   |
| ----- | --------------------------- | ------------------------------------------------------ |
| 0     | Steps 1-5                   | new tests red on base, green with fix; cli gates green |
| 1     | Plan 572 on the same branch | see plan 572                                           |

## 8. Risks & STOP conditions

- **STOP** if section 1 does not match the live code.
- **STOP** if you cannot make `fakeWorker` fail part-way without editing it beyond adding an
  option; report what you need.
- **STOP** if an existing test pins the old message for a file with unkeyed rows.

## 9. Open questions

1. None.

## Done criteria

- [ ] `pnpm --filter "@lunora/cli" run test`, `lint:eslint`, `lint:types` exit 0.
- [ ] New tests 1 and 2 fail against `79b0c5a6a`'s `import.ts`.
- [ ] `git diff --stat 79b0c5a6a..HEAD` lists only in-scope files.

## Maintenance notes

Any new resume or retry message in the import path must take the unkeyed count into account.
