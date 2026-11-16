# Plan 589 — `index_utilization` stops calling vector, unique and global-rank indexes dead

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. A reviewer dispatched you and maintains
> `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 79b0c5a6a..HEAD -- packages/studio/src/features/advisors/derive-runtime-advisories.ts packages/shard-engine/src/ctx-db.ts packages/advisor/src/lints/runtime/index-utilization.ts`
> Expect no output.

**Baseline:** `79b0c5a6a` (2026-11-12)
**Status:** DONE — APPROVED; PR https://github.com/anolilab/lunora/pull/1576 (branch `fix/improve-589-index-utilization-unstampable`). Reviewer ran the shard-engine workerd project (235 passed).
**Source:** row 51 of the 2026-11-11 audit (advisor lints).

## Status

- **Priority**: P2 · **Effort**: M · **Risk**: LOW (removes false positives; one telemetry call moves) · **Depends on**: none · **Category**: bug (runtime-lint false positive)

## 0. Headline finding

The Studio's dead-index check (`index_utilization`, runtime) reconciles every declared index against
recorded index reads, but some indexes can never record a read, so they are always reported as
"dead overhead … drop it":

- **vector indexes**: the read stamp (`IndexUseHook`) has no `"vector"` kind and nothing stamps one;
- **`unique: true` indexes**: kept for the constraint; following "drop it" removes the constraint;
- **rank indexes on `.global()` tables**: `rank()`/`rankPage()` return through the global writer before the stamp.
  The Studio also feeds ONE shard's counters while the lint's docs say per-shard arrays are summed, so an
  index used only on other shards reads as dead.

## 1. Current state (audit)

- `packages/shard-engine/src/ctx-db.ts:189` — `type IndexUseHook = (table, indexName, kind: "geo" | "index" | "rank" | "search") => void;`
  Stamps at `:1640` (geo), `:1660` (index), `:1677` (search), and rank at `:4858`, `:5018`, `:5037`.
- `ctx-db.ts:4848-4858` (`rank`):

```ts
        async rank(tableName, indexName, rankOptions) {
            const global = globalWriterFor(tableName, "rank");

            if (global) {
                onRead(tableName, SCAN_DEP);

                return global.rank(tableName, indexName, rankOptions);
            }

            onIndexUse(tableName, indexName, "rank");
```

`rankPage` (~line 5003-5018) has the same shape (`globalWriterFor(tableName, "rankPage")` … `return global.rankPage(...)`, then `onIndexUse`).

- `packages/studio/src/features/advisors/derive-runtime-advisories.ts:125-128`:

```ts
const declaredIndexesFor = (table: string, indexes: ReadonlyArray<TableIndexInfo>): DeclaredIndex[] =>
    indexes.map((index) => {
        return { index: index.name, table };
    });
```

`TableIndexInfo` (`packages/studio/src/lib/admin.ts:433`) has `fields, name, type: "index" | "rank" | "search" | "vector", unique?`.
Callers: `insights-panel.tsx:255,314` (one shard at a time — `useAdminQuery(getMetrics, {}, { shardKey: queryShardKey })` at `:171`).

- `packages/advisor/src/lints/runtime/index-utilization.ts:13-27` (JSDoc) says "the studio sums the per-shard
  arrays"; the dead-index `detail` (~line 57) says "has recorded no reads since its counter was created";
  `remediation` says "Drop a dead index so writes stop maintaining it; …".

## 2. Design decisions

- **Exclude what cannot be stamped, in the Studio reconciliation** (`declaredIndexesFor`): skip
  `type === "vector"` and `unique === true`. Chosen over stamping vector reads: vector search does not run
  through `ctx-db`'s read paths, so there is no single place to stamp. A unique index is excluded even if it
  records reads, because the advice to drop it would remove the constraint.
- **Stamp the global rank paths** in `ctx-db.ts`: move `onIndexUse(tableName, indexName, "rank")` above the
  `if (global)` early return in `rank` and `rankPage` (the read named the index either way). Chosen over
  excluding rank indexes in Studio: the Studio does not know which tables are global, and the stamp is exact.
- **Say "on this shard"** instead of aggregating: the dead-index `detail` becomes
  "… has recorded no reads on the inspected shard since its counter was created …" and the remediation
  says to check every shard before dropping; the JSDoc stops claiming the Studio sums shards.
  Chosen over a cross-shard fan-out in the Studio, which is a feature, not a fix.

## 3. Steps

### Step 1: Studio exclusion

Change `declaredIndexesFor` to `indexes.filter((index) => index.type !== "vector" && index.unique !== true).map(...)`
and extend its JSDoc with one sentence on why (no read stamp for vector; unique is a constraint).
Test in `packages/studio/__tests__/features/advisors/derive-runtime-advisories.test.ts` (mirror the file's
existing `declaredIndexesFor` usage): given `[{ name: "by_owner", type: "index", fields: ["ownerId"] },
{ name: "by_embedding", type: "vector", fields: ["embedding"] }, { name: "by_email", type: "index", unique: true, fields: ["email"] }]`
→ only `by_owner` is returned.

**Verify**: `pnpm --filter "@lunora/studio" exec vitest run __tests__/features/advisors/derive-runtime-advisories.test.ts` → pass;
`pnpm --filter "@lunora/studio" run lint:types` → exit 0.
Commit: `fix(studio): skip vector and unique indexes in the dead-index check`.

### Step 2: stamp the global rank reads

In `ctx-db.ts` `rank` and `rankPage`, move the `onIndexUse(tableName, indexName, "rank")` line to directly
after the `const global = globalWriterFor(...)` line (before `if (global)`), and delete the now-duplicate
later call. Nothing else changes. Test: in the shard-engine test file that already exercises `rank`
(`packages/shard-engine/__tests__/ctx-db.triggers.aggregates-rank.test.ts` or the `_scenarios/ctx-db.rank.ts`
scenario — pick the one whose setup already builds a ctx db with a schema containing a rank index), add a
case: a `.global()` table with a rank index, `createShardCtxDb` (or the helper the file uses) given a fake
`globalDb` whose `rank`/`rankPage` resolve a fixed value and an `onIndexUse` `vi.fn<…>()`; calling `rank`
and `rankPage` stamps `(table, index, "rank")` once each. If no existing helper can pass `globalDb` and
`onIndexUse`, STOP and report.

**Verify**: `pnpm --filter "@lunora/shard-engine" exec vitest run <that file>` → pass; `pnpm --filter "@lunora/shard-engine" run lint:types` → exit 0.
Commit: `fix(shard-engine): stamp rank index use on the global read path`.

### Step 3: honest wording

In `index-utilization.ts`: JSDoc — replace "the studio sums the per-shard arrays into `context.indexHits`" with
"the studio passes the counters of the shard being inspected"; dead-index `detail` — "… has recorded no reads on the
inspected shard since its counter was created — every write maintains it and nothing on this shard reads through it.";
`remediation` — "Before dropping an index that reads as dead, check it is unused on every shard; then drop it so writes
stop maintaining it. Add an index covering the hot full-scanned table's read predicate so the read stops scanning every row."
Update any test in `packages/advisor/__tests__/runtime-lints.test.ts` that asserts the old detail text (match the new text; do
not weaken to a partial match).

**Verify**: `pnpm --filter "@lunora/advisor" run test` → pass.
Commit: `docs(advisor): say the dead-index check covers the inspected shard`.

### Step 4: red without the fix

`git show 79b0c5a6a:<path> > <path>` for `derive-runtime-advisories.ts` and `ctx-db.ts`; run the Step 1 and Step 2 tests; confirm the new
cases FAIL; `git checkout -- packages`; re-run → pass.

### Step 5: gates

`lint:eslint`, `lint:types`, `test` for `@lunora/studio`, `@lunora/shard-engine`, `@lunora/advisor` → exit 0.
Do NOT run `test:workerd`; the reviewer runs the shard-engine workerd project.

## Commands you will need

| Purpose    | Command (worktree root)                                                         | Expected |
| ---------- | ------------------------------------------------------------------------------- | -------- |
| Install    | `pnpm install --frozen-lockfile`                                                | exit 0   |
| Build deps | `pnpm --filter "@lunora/studio..." run build` (covers advisor and shard-engine) | exit 0   |
| Tests      | `pnpm --filter "@lunora/<pkg>" run test`                                        | pass     |

## Scope

In scope: `packages/studio/src/features/advisors/derive-runtime-advisories.ts`, its test,
`packages/shard-engine/src/ctx-db.ts` (`rank`/`rankPage` stamp lines only), one shard-engine rank test file,
`packages/advisor/src/lints/runtime/index-utilization.ts`, `packages/advisor/__tests__/runtime-lints.test.ts` (text assertions only).
Out of scope: `IndexUseHook`'s kind union, `insights-panel.tsx`, `codegen/src/emit/shard-metadata.ts`.

## Done criteria

- [ ] the three packages' `lint:eslint`, `lint:types`, `test` exit 0
- [ ] the new Studio and shard-engine cases fail on the baseline sources
- [ ] `grep -c 'onIndexUse(tableName, indexName, "rank")' packages/shard-engine/src/ctx-db.ts` → 3 (one each in rank, rankPage, rankPageRows)

## STOP conditions

- `rank`/`rankPage` no longer match the excerpt.
- No existing shard-engine test helper can pass a `globalDb` and an `onIndexUse`.
- A verification fails twice.

## 6. Platform parity

No `ctx.*` surface changes. The stamp is an internal telemetry hook on every target that runs `ctx-db`.

## Maintenance notes

- Rollout: runtime-only lint shown in Studio; it stops listing vector, unique and global-rank indexes as dead.
  No static finding changes, so no deploy is affected.
- If vector search ever routes through `ctx-db`, add a `"vector"` kind and drop the Studio exclusion for it.
