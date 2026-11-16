# Plan 573 — Auth jurisdiction copy finishes with 17 or more tables

**Baseline:** `79b0c5a6a` (2026-11-11)
**Status:** DONE (APPROVED; PR #1554, branch fix/improve-573-auth-move-budget)

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`; the reviewer
> maintains the index.
>
> **Drift check (run first)**:
> `git diff --stat 79b0c5a6a..HEAD -- packages/auth/src/jurisdiction-move.ts packages/auth/__tests__/jurisdiction-move.behaviour.test.ts packages/auth/__tests__/workerd/jurisdiction-move.workerd.test.ts`
> Empty output expected. If any file changed, compare the excerpts in section 1 with the live code;
> on a mismatch, STOP.

Finding row 32 of the 2026-11-11 audit (issue #1527).

## 0. Headline finding

`copy()` in `packages/auth/src/jurisdiction-move.ts` spends one page of its 16-page per-call budget
re-probing every table that is already `done`. Once an auth object has 17 or more tables, every call
runs out of budget before reaching table 17, returns `done: false`, never reaches the fingerprint
step, and `purge` refuses forever. With exactly 16 tables the last one advances one page per call.

## 1. Current state (audit)

- `packages/auth/src/jurisdiction-move.ts` — the move. Worker-side driver `createAuthJurisdictionMove`
  (line 805) and the object-side `dispatch` (line 700).
- Budget, lines 77-82:

    ```ts
    /**
     * Pages one call copies before it returns `done: false`. A page is two Durable Object
     * fetches and a call adds five, so a call stays under the 50-subrequest limit of a
     * Workers Free plan; the next call resumes.
     */
    const MAX_PAGES_PER_CALL = 16;
    ```

- Driver loop, lines 838-878 (abridged):

    ```ts
    let pages = 0;

    for (const table of sortTables(tables, before.order)) {
        const report = emptyReport(table, begun.targetRows[table.name] ?? 0);
        let after = begun.cursors[table.name] ?? 0;

        reports.push(report);

        for (;;) {
            if (pages >= MAX_PAGES_PER_CALL) {
                return { done: false, tables: reports };
            }

            pages += 1;

            // eslint-disable-next-line no-await-in-loop -- each page starts at the previous page's cursor
            const page = await call<{ last?: number; rows: unknown }>("source", { after, op: "page", table: table.name });
            const rows = decodeWire(page.rows) as Row[];
            const final = rows.length < PAGE_ROWS;

            if (rows.length === 0 && begun.done[table.name] === true) {
                break;
            }
            // ... write the page to the target, advance `after`, break on `final`
        }
    }
    ```

    A finished table (`begun.done[name] === true`) still costs one `page` call and one unit of `pages`
    before the `break`.

- The table set is every non-reserved table (`tableNames`, lines 187-190), which includes the audit
  and rate-limit tables and every plugin's tables, so 17+ is reachable.
- Object-side ops: `dispatch` (lines 700-747) switches on `body["op"]`: `begin`, `fingerprints`,
  `manifest`, `page`, `purge`, `rescan`, `status`, `write`. `SOURCE_OPS` (line 645) is
  `new Set(["fingerprints", "manifest", "page", "purge"])`; source ops are refused on a purged object
  (`assertNotPurged`).
- `readPage` (lines 265-274) reads `WHERE rowid > ? ORDER BY rowid LIMIT ?`; `assertKnownTable`
  (lines 257-263) validates a table name against `tableNames`.
- After the loop, lines 880-892: one `fingerprints` call (source), one `status` call (target), and a
  `rescan` call (target) when a table changed. A rescan resets a table to `after = 0, done = 0,
pass = pass + 1` (line 672), i.e. a full re-copy of that table.
- Tests: `packages/auth/__tests__/jurisdiction-move.behaviour.test.ts` (node:sqlite, default run) —
  no case has more than 16 tables. `packages/auth/__tests__/workerd/jurisdiction-move.workerd.test.ts`
  is the real-Durable-Object twin (workerd project, run only by the reviewer).

## 2. Existing seams (do not reinvent)

- `dispatch` + `SOURCE_OPS`: add the new op there, exactly like `page`.
- `assertKnownTable` for every table name the worker sends.
- `all(storage, query, ...bindings)` for SQL reads; `quoteIdentifier` from `shared/quote-identifier`
  for table names.
- The behaviour test's `harness()` (lines 27-73): two `LunoraAuthDO`s over in-memory
  `DatabaseSync`s; the namespace double's `fetch` is where calls can be counted.

## 3. The behavioural contract to preserve

- Every existing test in both move test files still passes unchanged.
- A row appended to a table after that table was marked `done` is still copied by the next
  `copy()` call (today the probe catches it; after this change the new op must).
- `done: true` still means the fingerprint check ran and matched.
- One `copy()` call stays under 50 Durable Object fetches.
- No change to the exported types `AuthMoveResult`, `AuthMoveTableReport`, `AuthJurisdictionMove`
  (they are in `api-snapshots/auth.api.md`).

## 4. Design decisions

- **Chosen:** one new source op, `pending`, that answers for all `done` tables in a single fetch
  which of them hold rows past the target's cursor. The driver skips a `done` table with no pending
  rows without a `page` call and without charging `pages`. A `done` table with pending rows is paged
  as today (charged).
- **Rejected: skip `done` tables outright.** A row appended after `done` would then surface only as
  a fingerprint mismatch, which triggers a full `rescan` of that table. On the unbounded audit and
  rate-limit tables, which keep growing while the app runs, every call would restart those tables
  from zero and the copy might never converge.
- **Rejected: don't charge the budget for an empty probe but keep one probe per table.** The budget
  exists for the subrequest limit; 30 tables of probes alone would exceed 50 fetches.

## 5. Workstreams

One workstream, size S. Steps below. Commit type `fix`, scope `auth`.

### Commands you will need

| Purpose         | Command (run from the worktree root)                                                                                                                                                   | Expected on success |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Install         | `pnpm install --frozen-lockfile`                                                                                                                                                       | exit 0              |
| Build deps once | `pnpm --filter "@lunora/auth..." run build`                                                                                                                                            | exit 0              |
| One test file   | `pnpm --filter "@lunora/auth" exec vitest run __tests__/jurisdiction-move.behaviour.test.ts`                                                                                           | all pass            |
| Package tests   | `pnpm --filter "@lunora/auth" run test`                                                                                                                                                | all pass            |
| Format          | `pnpm exec oxfmt packages/auth/src/jurisdiction-move.ts packages/auth/__tests__/jurisdiction-move.behaviour.test.ts packages/auth/__tests__/workerd/jurisdiction-move.workerd.test.ts` | exit 0              |
| ESLint          | `pnpm --filter "@lunora/auth" run lint:eslint`                                                                                                                                         | exit 0, no warnings |
| Types           | `pnpm --filter "@lunora/auth" run lint:types`                                                                                                                                          | exit 0              |

### Scope

**In scope (the only files you may modify):**

- `packages/auth/src/jurisdiction-move.ts`
- `packages/auth/__tests__/jurisdiction-move.behaviour.test.ts`
- `packages/auth/__tests__/workerd/jurisdiction-move.workerd.test.ts` (add one case; you cannot run
  it, the reviewer does)

**Out of scope:** `packages/auth/src/auth-do.ts`, `packages/auth/src/do-wiring.ts`, the exported
types listed in section 3, `plans/README.md`, every other package.

### Git workflow

- You are on branch `fix/improve-573-auth-move-budget`, cut from `origin/alpha`. Do not push.
- One commit: `fix(auth): stop finished tables from spending the move's page budget`, body
  explaining the 17-table stall in at most four lines (lines ≤ 100 chars), ending with the line
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage explicit paths only (`git add <path> …`). Never `git add -A`, `git commit -a`, any
  `git stash`, or `--no-verify`.

### Executor rules

- Work only inside your worktree; absolute paths or `cd <worktree> &&` in every shell call.
- Never run `pnpm run test:workerd`, `pnpm run build:packages`, `pnpm run build`, `pnpm run test`
  at the repo root, or any `pnpm -r …`. Never kill a process by name or pattern.
- Format (oxfmt) before ESLint. Relative imports carry no extension. Named exports only.
- Comments say why (a constraint or an invariant), never narrate steps or history.
- Tests wait on returned promises, never on timers or sleeps.
- No new `eslint-disable` unless it names the rule, sits on one line and gives `-- reason`; copy
  the existing `no-await-in-loop` disables in this file if you need one. No `.skip`, no
  `@ts-expect-error`, no `as any`.

### Step 1: Install and build

Run the Install and Build rows of the commands table.

**Verify:** both exit 0.

### Step 2: Write the failing tests first

In `packages/auth/__tests__/jurisdiction-move.behaviour.test.ts`, add a `describe` or `it`
block (model it on the existing `it("copies, re-runs as a no-op, …")` at line 109) that:

1. Builds the harness, warms it, and creates **20** extra plain tables in the SOURCE database
   (`context.source.exec('CREATE TABLE "extra_01" ("id" text NOT NULL PRIMARY KEY, "v" text)')`
   and so on), each with a few rows.
2. Wraps call counting: add an optional counter to `harness()` so every `object.fetch` through the
   namespace double increments a number the test can read (for example a `calls` field on the
   returned `Harness`, reset by the test before each `copy()`). Keep existing callers working.
3. Calls `copy()` in a loop until it returns `done: true`, at most 10 times, and asserts:
    - it reached `done: true` within those 10 calls;
    - no single `copy()` call made more than 50 fetches;
    - every extra table's row count in the TARGET equals the source's.
4. A second `it`: after a first run reaches `done: true`, insert one new row into one extra table in
   the source, reset the counter, call `copy()` once, and assert the target has the new row after
   that single call and the call made far fewer fetches than a full re-copy (assert `< 20`).

Run the one-file test command.

**Verify:** the new 20-table test FAILS (it never reaches `done: true`, or exceeds the call bound).
Copy the failing assertion line into your report. If it passes before any source change, STOP: the
fixture does not reproduce the bug.

### Step 3: Add the `pending` source op

In `packages/auth/src/jurisdiction-move.ts`:

- Add a source-side function, near `readPage`, that takes `cursors: Record<string, number>` and
  returns the names of the tables that hold a row with `rowid` greater than their cursor. Validate
  every name with `assertKnownTable`; query with
  `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(table)} WHERE rowid > ?) AS n` (or equivalent
  through `all`). Bind the cursor; never interpolate it.
- Add `case "pending":` to `dispatch`, returning `{ pending: [...] }`, reading
  `body["cursors"]` as `Record<string, number>`.
- Add `"pending"` to `SOURCE_OPS` so a purged source refuses it like the other source reads.

**Verify:** `pnpm --filter "@lunora/auth" run lint:types` exits 0.

### Step 4: Use it in the driver

In `createAuthJurisdictionMove(...).copy`:

- After `begin`, collect the tables with `begun.done[name] === true`. If there are any, make ONE
  `call("source", { cursors, op: "pending" })` with each such table's `begun.cursors[name] ?? 0`.
- In the table loop, when a table is `done` and not in the pending set, push its `emptyReport` and
  `continue` without a `page` call and without incrementing `pages`.
- Keep the existing `rows.length === 0 && begun.done[...]` break: a row deleted between `pending`
  and `page` must still not spin.
- Update the `MAX_PAGES_PER_CALL` doc comment so its arithmetic is true: count the fixed calls a
  `copy()` makes outside the page loop (`status`, `manifest`, `begin`, `pending`, `fingerprints`,
  `status`, `rescan`) and state that 16 pages × 2 + that number stays under 50. Do not change the
  value 16.

**Verify:** the one-file test command → all tests pass, including both new ones.

### Step 5: Workerd twin

Add one case to `packages/auth/__tests__/workerd/jurisdiction-move.workerd.test.ts` mirroring the
20-table test from step 2, using that file's own harness and helpers. Do not try to run it.

**Verify:** `pnpm --filter "@lunora/auth" run lint:types` exits 0.

### Step 6: Gates, then commit

Format, then ESLint, types and the package tests (commands table).

**Verify:** all exit 0. Then commit per "Git workflow". `git status --short` → clean.

### Step 7: Prove the test needs the fix (after the commit; no stash)

Put the base version of the source file back, run the test, then restore the committed version:

```bash
git show 79b0c5a6a:packages/auth/src/jurisdiction-move.ts > packages/auth/src/jurisdiction-move.ts
pnpm --filter "@lunora/auth" exec vitest run __tests__/jurisdiction-move.behaviour.test.ts   # expect the new tests to FAIL
git checkout HEAD -- packages/auth/src/jurisdiction-move.ts
git status --short   # must be empty
```

**Verify:** the new tests fail against the base file (copy the failing test names into your
report); after the restore `git status --short` is empty and the test file passes again.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding changes; this is an internal route between two auth
Durable Objects.

## 7. Phasing & ordering

| Phase        | Work               | Gate                                                                         |
| ------------ | ------------------ | ---------------------------------------------------------------------------- |
| 0            | Steps 1-7          | new node tests red on base, green with fix; package lint, types, tests green |
| 1 (reviewer) | workerd move suite | `pnpm run test:workerd auth` green                                           |

## 8. Risks & STOP conditions

- **STOP** if the code in section 1 does not match the live file.
- **STOP** if the 20-table test passes on the base file (step 2 or step 7).
- **STOP** if the fix appears to need changes to `auth-do.ts`, `do-wiring.ts` or an exported type.
- **STOP** if an existing move test fails after your change and the fix is not obvious after one
  attempt; report the failing assertion.
- **Risk:** a table whose rows are deleted but none added is reported as not pending and skipped.
  That is correct: deletions are caught by the fingerprint step, which runs whenever every table
  reached its end, and lead to a rescan as before.

## 9. Open questions

1. None for the executor. The reviewer runs the workerd suite.

## Done criteria

- [ ] New 20-table and append-after-done tests exist in `jurisdiction-move.behaviour.test.ts` and
      pass; both fail against `79b0c5a6a`'s `jurisdiction-move.ts`.
- [ ] `pnpm --filter "@lunora/auth" run test` exits 0.
- [ ] `pnpm --filter "@lunora/auth" run lint:eslint` and `lint:types` exit 0.
- [ ] `git diff --stat 79b0c5a6a..HEAD` lists only the three in-scope files.
- [ ] `grep -n '"pending"' packages/auth/src/jurisdiction-move.ts` shows the op in `SOURCE_OPS` and
      in `dispatch`.

## Maintenance notes

- Any new per-call fixed request in `copy()` must be added to the `MAX_PAGES_PER_CALL` arithmetic.
- Review focus: the skipped-table branch must not skip a table whose `begun.done` is false.
