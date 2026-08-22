# Plan 438: Throttle the function- and auth-metrics bucket prunes to once per window

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/observability/src/function-metrics.ts packages/observability/src/auth-metrics.ts packages/observability/src/query-metrics.ts`
> On any in-scope change, compare the "Current state" excerpts; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`recordFunctionMetric` and the auth-metrics recorder each run a retention `DELETE` (a correlated-subquery `MAX` scan plus a range delete) on **every** RPC dispatch / auth attempt — the hottest write paths in the DO. Two sibling modules in the same package (`query-metrics.ts`, `metric-history.ts`) already established that this class of write is only needed once per minute-bucket, and implement a `WeakMap`-per-storage-handle marker with the rationale written down. The divergence is a straight inconsistency: same package, same write shape, throttled in two files and unthrottled in the other two. Retention semantics are identical either way; the per-dispatch cost is not.

## Current state

- `packages/observability/src/function-metrics.ts:471-482` — after the bucket upsert:
    ```ts
    // Bounded retention: keep only the most recent buckets for this path.
    runSql(
        sql,
        `DELETE FROM "${FUNCTION_METRICS_BUCKETS_TABLE}"
         WHERE path = ?
           AND bucket_ms <= (
            SELECT MAX(bucket_ms) - ? FROM "${FUNCTION_METRICS_BUCKETS_TABLE}" WHERE path = ?
           )`,
        ...
    ```
    Unconditional, every call.
- `packages/observability/src/auth-metrics.ts:176-184` — same shape (`DELETE … WHERE bucket_ms <= (SELECT MAX(bucket_ms) - ? …)`), every recorded attempt.
- The established pattern — `packages/observability/src/query-metrics.ts:162-173`:
    ```ts
    /**
     * The bucket most recently pruned PER SHARD, so the prune runs once per window
     * instead of once per statement.
     *
     * Keyed by the storage handle rather than a module-level scalar: workerd hosts
     * several Durable Object instances of the same class in one isolate ... A `WeakMap`
     * means an evicted DO's entry is collected with it.
     */
    const lastPrunedBucket = new WeakMap<object, number>();
    ```
    used at `:299-304`:
    ```ts
    if (lastPrunedBucket.get(sql) !== bucket) {
        lastPrunedBucket.set(sql, bucket);
        pruneQueryBuckets(sql, now);
    }
    ```
- `packages/observability/src/metric-history.ts` (~`:246`, `:304`) applies the same marker pattern.

## Commands you will need

| Purpose    | Command                                                 | Expected on success |
| ---------- | ------------------------------------------------------- | ------------------- |
| Install    | `pnpm install`                                          | exit 0              |
| Build deps | `pnpm --filter "@lunora/observability..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/observability" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/observability" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/observability" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/observability/src/function-metrics.ts`
- `packages/observability/src/auth-metrics.ts`
- The corresponding test files in `packages/observability/__tests__/`

**Out of scope**:

- `query-metrics.ts` / `metric-history.ts` — already correct; do not refactor them into a shared helper unless the copy is truly identical (a six-line local copy per file is acceptable and matches the existing two files' shape; a shared module is fine ONLY if it stays inside `src/` and changes no public export).
- Retention constants and bucket sizes.

## Git workflow

- Branch: shared wave branch `improve/wave22-observability`.
- Commit: `perf(observability): prune metric buckets once per window`

## Steps

### Step 1: Gate the function-metrics prune

In `function-metrics.ts`, add a module-level `const lastPrunedBucket = new WeakMap<object, number>();` with the same doc comment rationale as `query-metrics.ts:162-173` (copy it, adjusting names). Compute the current bucket (the file already computes `bucket` for the upsert) and wrap the retention `DELETE` in the `lastPrunedBucket.get(sql) !== bucket` guard, setting before pruning. NOTE: the function-metrics delete is per-`path` — pruning once per window per handle (not per path) slightly delays pruning for paths not written in the winning call. That is acceptable: the delete's `WHERE path = ?` only prunes the current path anyway, so key the marker by handle AND keep the per-path delete as is; a path's own next write in a later window prunes it. State this in the code comment.

**Verify**: `pnpm --filter "@lunora/observability" run test` → function-metrics tests pass.

### Step 2: Gate the auth-metrics prune

Same marker pattern in `auth-metrics.ts` (its delete is table-wide, so once-per-window-per-handle is exact).

**Verify**: `pnpm --filter "@lunora/observability" run test` → auth-metrics tests pass.

### Step 3: Tests

In the existing function-metrics and auth-metrics test files (find them: `ls packages/observability/__tests__/ | grep -i -e function -e auth`), add one test each asserting: two records in the same bucket issue the prune DELETE once; a record in a later bucket issues it again. Model on however the query-metrics tests assert prune behavior (`grep -rn "lastPruned\|prune" packages/observability/__tests__/`).

**Verify**: `pnpm --filter "@lunora/observability" run test` → all pass including 2 new tests.

## Test plan

- 2 new tests (one per file) covering the once-per-bucket gating; retention behavior itself is already covered by existing tests, which must stay green.

## Done criteria

- [ ] `pnpm --filter "@lunora/observability" run test` exits 0 with the new tests
- [ ] `pnpm --filter "@lunora/observability" run lint:types` exits 0
- [ ] Both retention DELETEs are inside a `lastPrunedBucket`-style guard (read the diff)

## STOP conditions

- The excerpts don't match the live code.
- The existing tests assert a prune happens on _every_ record (they would be encoding the old behavior) and rewriting them changes more than the prune-count expectation.

## Maintenance notes

- If a fourth metrics module gains a retention delete, it should copy this marker on day one — consider a shared helper at that point (three copies is the threshold the repo's duplication guidance uses).
