# Plan 535: Shard-engine and observability write-path fixes from the 2026-10-19 audit

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2376f8799..HEAD -- packages/shard-engine/src/ctx-db.ts packages/shard-engine/src/ctx-db-companions.ts packages/server/src/rls/middleware.ts packages/observability/src/request-log.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M (four S-sized perf fixes on the hot write path)
- **Risk**: MED (shard-engine is the data path; everything has tests)
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `2376f8799`, 2026-10-19
- **Issue**: https://github.com/anolilab/lunora/issues/1271
- **Platform parity**: not applicable (no surface change)

## Why this matters

Four pieces of avoidable work on the Durable Object's single-threaded write
path: `patchWhere`/`deleteWhere` read the whole matching set (up to 100k rows,
or everything from D1 for a `.global()` table) before refusing over the 500-row
batch cap; the rank-companion rebuild inserts one row at a time inside the
write gate; `rowIndexKeys` is computed twice per patch/delete; and the request
log issues a trim `DELETE` on every single dispatch when the sibling metrics
module already runs its trim once per window.

IMPORTANT: open PRs #1264 (`fix/schema-write-path-correctness`) and #1265
(`fix/server-realtime-limits`) also edit `packages/shard-engine/src/ctx-db.ts`.
Keep each hunk here minimal so the merge is trivial.

## Current state

Conventions from `CLAUDE.md`: relative imports WITHOUT `.js`; named exports
only; `eslint --max-warnings=0`; run `pnpm run test:workerd` is NOT possible in
a sandbox — the Node vitest suites are the gate here, and the reviewer runs
workerd. SQL goes through the drizzle helpers (`dsql`, `runDrizzle`,
`WORKERD_SQLITE_LIMITS`) in `packages/shard-engine/src/drizzle.ts`.

### A. `patchWhere` / `deleteWhere` read everything before the cap

`packages/shard-engine/src/ctx-db.ts:3427-3437`:

```ts
        async deleteWhere(tableName, where, batchOptions) {
            const source = globalWriterFor(tableName, "deleteWhere") ?? writer;
            const page = await source.findMany(tableName, { where });
            const ids = page.page.map((row) => String(row["_id"]));

            assertBatchLimit(ids.length, batchOptions?.limit, "deleteWhere");
```

`ctx-db.ts:4261-4273` (`patchWhere`) has the identical shape with
`findMany(tableName, { where: args.where })`. `DEFAULT_BATCH_LIMIT = 500` at
`:423`; `assertBatchLimit(count, limit, op)` at `:465`. The RLS wrapper
`packages/server/src/rls/middleware.ts:1434-1447` does the same for
`deleteWhere` via `route(tableName).findMany(...)`.

### B. Rank companion rebuild inserts per row

`packages/shard-engine/src/ctx-db-companions.ts:167-180`:

```ts
const records = companionSourceRows(sql, tableName, softField, (candidate) => !index.where || matchesRankStaticWhere(candidate, index.where));

runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(rankTable)}`);

for (const record of records) {
    insertRankRow(sql, rankTable, index, columnsSql, record["_id"] as string, record);
}
```

The aggregate twin at `:131-145` already chunks:
`const CHUNK_ROWS = Math.floor(WORKERD_SQLITE_LIMITS.boundParams / 3);` and
builds one multi-row `INSERT ... VALUES (...), (...)` per chunk.
`insertRankRow` is at `:75`; read it to see the per-row column list it binds
(`columnsSql`) so the chunked statement binds the same values in the same order.
Tests: `packages/shard-engine/__tests__/ctx-db.rank.test.ts`.

### C. `rowIndexKeys` computed twice

`ctx-db.ts:4172-4175` (patch), `:3306-3309` (soft delete), `:3338-3341` (hard delete), e.g.:

```ts
cache?.invalidate(tableName, id, rowIndexKeys(tableName, existing, merged));

recordCdc(tableName, id, "update", merged);
broadcast({ indexKeys: rowIndexKeys(tableName, existing, merged), key: id, op: "update", row: merged, table: tableName });
```

### D. Request-log trim runs on every append

`packages/observability/src/request-log.ts:472-476` (end of `appendRequestLogEntry`):

```ts
runSql(sql, `DELETE FROM "${REQUEST_LOG_TABLE}" WHERE seq <= (SELECT MAX(seq) - ? FROM "${REQUEST_LOG_TABLE}")`, retention);
```

`packages/observability/src/function-metrics.ts:529` shows the window pattern:
`if (shouldPrune(sql, bucket, input.path)) { runSql(... DELETE ...) }` using
`shouldPrune` from `./prune-marker` (`:31`, true once per `(handle, key, bucket)`).
`bucket` there is a time bucket in ms. Tests: `packages/observability/__tests__/request-log.test.ts`.

## Commands you will need

| Purpose        | Command                                                                                          | Expected |
| -------------- | ------------------------------------------------------------------------------------------------ | -------- |
| Install        | `pnpm install --frozen-lockfile`                                                                 | exit 0   |
| Build deps     | `pnpm --filter "@lunora/server..." --filter "@lunora/observability..." run build`                | exit 0   |
| Test           | `pnpm --filter "@lunora/shard-engine" run test` (also `@lunora/server`, `@lunora/observability`) | all pass |
| Typecheck/Lint | `run lint:types` / `run lint:eslint` per package                                                 | exit 0   |
| API            | `pnpm run api:check`                                                                             | exit 0   |

## Scope

**In scope**:

- `packages/shard-engine/src/ctx-db.ts` (three small hunks: `deleteWhere`, `patchWhere`, the three `rowIndexKeys` pairs)
- `packages/shard-engine/src/ctx-db-companions.ts` (`rebuildRankCompanion`)
- `packages/server/src/rls/middleware.ts` (`deleteWhere` only; and `patchWhere` if it has the same unbounded read)
- `packages/observability/src/request-log.ts`
- Tests: `packages/shard-engine/__tests__/ctx-db.rank.test.ts`, a batch-limit test file in `packages/shard-engine/__tests__/` (find with `grep -l assertBatchLimit\|BATCH_LIMIT packages/shard-engine/__tests__/*`), `packages/observability/__tests__/request-log.test.ts`

**Out of scope**: `packages/do/*` (metrics flush cadence and CDC retention are
separate decisions), `packages/sql-store/*`, `relations.ts` (cascade bounding
is a separate plan), any wire or public API change.

## Git workflow

- Branch: `perf/shard-engine-audit-2026-10-19` from `alpha`.
- One conventional commit per step, e.g. `perf(shard-engine): stop reading past the batch cap in patchWhere and deleteWhere`.
- Do NOT push or open a PR.

## Steps

### Step 1: Bound the where-resolution read

In `deleteWhere` and `patchWhere`: compute
`const cap = batchOptions?.limit ?? DEFAULT_BATCH_LIMIT;` and pass
`limit: cap + 1` to the `findMany` call. Keep `assertBatchLimit(ids.length, ...)`
as is — with `cap + 1` rows it still throws the same error when over the cap.
Check that `findMany`'s args type accepts `limit` on the global writer path
too (it does for the shard writer; if the global writer's `findMany` signature
differs, STOP). Apply the same `limit` to the RLS middleware's `deleteWhere`
read (and `patchWhere` if present). Add a test: a table with 600 rows,
`deleteWhere` with a match-all predicate → throws the batch-limit error AND a
spy/count on the underlying read shows at most 501 rows were fetched (use the
existing in-memory test harness in that test file; if row-count observation is
not possible there, assert the throw only and note it).

**Verify**: `pnpm --filter "@lunora/shard-engine" run test && pnpm --filter "@lunora/server" run test` → all pass.

### Step 2: Chunk the rank rebuild

In `rebuildRankCompanion`, replace the per-row loop with a chunked multi-row
insert mirroring `:131-145`: `CHUNK_ROWS = Math.floor(WORKERD_SQLITE_LIMITS.boundParams / <params per row>)`
where params per row = the number of values `insertRankRow` binds (read it).
Build each row's value tuple with the same encoding `insertRankRow` uses
(extract a `rankRowValues(index, id, record)` helper that both the single-row
and chunked paths call so they cannot diverge). Add a test in
`ctx-db.rank.test.ts`: a table with more rows than `CHUNK_ROWS` (e.g. 1,200)
→ after the rebuild the companion has exactly that many rows and ordering
queries return the same result as before (model on the existing rebuild case).

**Verify**: `pnpm --filter "@lunora/shard-engine" run test -- rank` → all pass.

### Step 3: Compute `rowIndexKeys` once

At each of the three sites, `const indexKeys = rowIndexKeys(...)` and pass it
to both `cache?.invalidate` and `broadcast`. No test needed.

**Verify**: `pnpm --filter "@lunora/shard-engine" run test` → all pass; `grep -c "rowIndexKeys(tableName, existing" packages/shard-engine/src/ctx-db.ts` → 3 (down from 6).

### Step 4: Window the request-log trim

In `appendRequestLogEntry`, wrap the trim in
`if (shouldPrune(sql, Math.floor(entry.ts / REQUEST_LOG_PRUNE_WINDOW_MS), "request-log"))`
with `const REQUEST_LOG_PRUNE_WINDOW_MS = 60_000;` (one trim per minute per
storage handle; bounded overshoot = one minute of appends). Import
`shouldPrune` from `./prune-marker`. Update the retention comment. Test in
`request-log.test.ts`: append 3 entries within the same minute with retention
1 → the table still holds up to 3 rows (trim ran once at the first append);
append one with `ts` in the next minute → the table is trimmed to `retention`.
If an existing test asserts exact trimming after every append, update it to
the windowed contract and say so in NOTES.

**Verify**: `pnpm --filter "@lunora/observability" run test -- request-log` → all pass.

## Done criteria

- [ ] `run test`, `run lint:types`, `run lint:eslint` exit 0 for shard-engine, server, observability
- [ ] `pnpm run api:check` exits 0
- [ ] `git status` shows no files outside scope
- [ ] New tests from Steps 1, 2, 4 exist and pass

## STOP conditions

- Drift against the excerpts (PRs #1264/#1265 may have merged — if the
  `deleteWhere`/`patchWhere` or rank code moved, report the new shape instead of adapting).
- The global writer's `findMany` cannot take `limit`.
- The rank chunked insert changes any existing rank test's expected ordering.
- A verification fails twice.

## Maintenance notes

- Reviewer must run `pnpm run test:workerd` for `@lunora/shard-engine` and `@lunora/do` before merge (SQLite differences; see `CLAUDE.md` gotchas).
- Deferred from this audit, tracked in `plans/README.md`: per-dispatch metrics flush default, CDC retention default, cascade bounding, subscription fan-out table index, `.global()` D1 batch writes, global delete local probe, companion-signature memo hoist.
