# Plan 626: `insertManyUnsafe` leaves no committed row without its companions when a later chunk fails

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/shard-engine/src/ctx-db.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE, pushed: `fix/shard-engine-insert-many-unsafe-companions` (workerd: all 23); PR #1639

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`ctx.db.insertManyUnsafe` writes its rows in chunks, one multi-row `INSERT` per chunk, and only after **all** chunks are written does it update the companions (aggregates, rank index, search index, CDC) and notify subscriptions. In a mutation the Durable Object's storage transaction rolls everything back on a throw, so this is safe. In an **action** there is no surrounding transaction: each chunk is its own commit. If chunk 2 throws (for example a duplicate explicit `_id` under `allowExplicitId`), chunk 1's rows are on disk with no aggregate, rank or search entries and no change notification, and nothing ever repairs that.

## Current state

`packages/shard-engine/src/ctx-db.ts`, shard-local branch of `insertManyUnsafe` (starts ~line 4569; the excerpt is ~4680-4718):

```ts
            // Multi-row INSERTs — the throughput win over `insertMany`'s N
            // single-row statements (and the skipped per-row JS pipeline).
            // Chunked at `INSERT_CHUNK_ROWS` because each row binds three
            // parameters and the batch cap is 500 rows: one statement over the
            // whole batch would bind 1,500, and Workerd allows 100.
            for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
                const valuesSql = dsql.join(
                    rows.slice(start, start + INSERT_CHUNK_ROWS).map((row) => dsql`(${row.id}, ${row.creationTime}, ${encodeDocJson(row.document)})`),
                    dsql`, `,
                );

                // The only write whose text genuinely varies: the `VALUES` list grows
                // with the chunk, so it is built and rendered per batch rather than
                // cached per table like the single-row statements.
                const batch = renderSql(
                    "sqlite",
                    dsql`INSERT INTO ${dsql.identifier(tableName)} (id, _creationTime, ${dsql.identifier(DOC_COLUMN)}) VALUES ${valuesSql}`,
                );

                runWrite(sql, tableName, batch.sql, batch.params);
            }

            // Companions + notifications ARE still maintained per row (shared with
            // the single `insert` via `syncCompanionsForInsert`), so search,
            // aggregates, ranks, CDC, the reactive cache and live subscriptions stay
            // correct — only the validator + trigger pipeline is skipped.
            for (const { document, id } of rows) {
                syncCompanionsForInsert(tableName, id, document);
                // The batch was already charged to the meter BEFORE the insert, so
                // notify through the raw hook — `onWrite` is the metering wrapper
                // and would charge every row a second time, halving the effective
                // ceiling for this path.
                // eslint-disable-next-line no-await-in-loop -- sequential write-hook fan-out, mirrors the single insert
                await reportWrite({ doc: document, id, op: "insert", table: tableName });
            }

            return rows.map((row) => row.id);
        },
```

Before this, the method backfills counters once (`ensureBackfilledForTable`, `ensureRankBackfilledForTable`), builds every row up front (ids, defaults, one `_commitSeq` per chunk) and charges the meter for the whole batch. The sibling `insertMany` documents the same hazard for its own path: "in an action (no span) prior inserts persist".

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

| Purpose                       | Command                                                                 | Expected on success |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                        | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/shard-engine..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/shard-engine" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/shard-engine" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/shard-engine" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/shard-engine" run lint:eslint`                  | exit 0, 0 warnings  |

## Design (decided, with one fork the executor resolves)

Goal: after `insertManyUnsafe` rejects, every row that is on disk has its companions and was reported; rows not on disk have neither.

1. **Preferred — all or nothing.** If the writer has a synchronous transaction/savepoint primitive available in this scope that also works outside a mutation span (look at how other multi-statement writes in this file get atomicity, e.g. `rg -n "transactionSync|savepoint|runGuardedWrite|inTransaction" packages/shard-engine/src`), wrap the chunk loop **and** the companion sync in it so a failing chunk undoes the earlier ones. Notifications (`reportWrite`) stay after the atomic part.
2. **Fallback — per chunk.** Otherwise move the companion sync and the `reportWrite` calls for a chunk's rows to directly after that chunk's `runWrite`, so a failure in chunk N leaves chunks 1..N-1 complete and consistent. Keep the "already metered, use the raw hook" comment with the moved code.

State which fork you took and why. Do not change the mutation-path behaviour (still fully rolled back).

## Steps

1. Find the existing `insertManyUnsafe` tests (`rg -ln "insertManyUnsafe" packages/shard-engine/__tests__ packages/*/__tests__`) and how they build a writer outside a transaction (the "action" shape).
2. Write the failing test first: a table with an aggregate (or count) and a rank or search index; more rows than one chunk (read `INSERT_CHUNK_ROWS`); `allowExplicitId: true` with a duplicate `_id` placed in the second chunk so its `INSERT` throws. Assert the call rejects, then assert **consistency**: the aggregate/count, the rank companion and the search companion each agree with the rows actually on disk (0 under fork 1, exactly the first chunk under fork 2). **Verify**: fails at baseline.
3. Implement the chosen fork. **Verify**: the test passes; the full package suite passes.
4. Build, test, types, eslint for `@lunora/shard-engine`.

## Scope

**In scope**: the shard-local branch of `insertManyUnsafe` in `packages/shard-engine/src/ctx-db.ts`; one test file in `packages/shard-engine/__tests__/`; the method's doc comment and any docs that describe its failure behaviour (`rg -n "insertManyUnsafe" packages/*/docs apps/docs`).

**Out of scope**: the `.global()` (D1) branch; `insertMany`; `packages/sql-store`; the metering order.

## Git workflow

- Branch: `fix/shard-engine-insert-many-unsafe-companions`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(shard-engine): keep companions with a failed unsafe batch`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## Done criteria

- [ ] New test passes and was seen red without the fix
- [ ] `pnpm --filter "@lunora/shard-engine" run test`, `lint:types`, `lint:eslint` exit 0

## STOP conditions

- You cannot make a later chunk throw after an earlier one committed (the path is already atomic outside a mutation): report NOT REPRODUCED with the evidence; commit nothing.
- Fork 1 needs a new method on a host contract (`ShardHost` and friends in `@lunora/platform`): do not add it — take fork 2.
- Fork 2 would put an `await` between two chunk writes inside a mutation and a test shows interleaving or ordering changes: STOP and report.

## Maintenance notes

- `packages/sql-store/src/ctx-db.ts` is the D1 twin of this writer; it has no `insertManyUnsafe` shard-local path, so no twin change is expected — confirm with `rg -n "insertManyUnsafe" packages/sql-store/src` and say what you found.
- Reviewer: run `pnpm run test:workerd` before merging.
