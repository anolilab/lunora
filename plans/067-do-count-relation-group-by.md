# Plan 067: Batch the `_count` relation aggregate instead of one query per FK

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. This plan changes a cross-backend injected contract — read the
> "STOP conditions" carefully; if the grouped-count path can't be wired for
> BOTH backends cleanly, stop and report rather than half-doing it. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9f779358..HEAD -- packages/do/src/relations.ts`
> If it changed, compare the "Current state" excerpt against the live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (but landing 070's shape/resume tests first is unrelated;
  this touches the relation loader, not shapes)
- **Category**: perf
- **Planned at**: commit `9f779358`, 2026-06-29

## Why this matters

`resolveWith` (the relation loader shared by the DO and D1 backends) resolves
`with: { _count: { ... } }` by issuing **one aggregate query per distinct parent
FK value**, sequentially. A page of P parents with D distinct FK values does D
serialized count round-trips where a single `GROUP BY <fk> ... WHERE <fk> IN (...)`
would return every tally in one query. On a page with many distinct parents this
is the relation loader's worst fan-out — every other relation kind already
resolves as a single batched `IN (...)` read. The loader's own header docstring
calls this out as the one un-batched exception, tied to the injected `counter`
returning a scalar. Fixing it means giving the loader a grouped-count capability;
the payoff is collapsing D queries into 1 on the hottest aggregate path.

## Current state

- `packages/do/src/relations.ts` — `resolveWith`'s `resolveCounts` (around lines
  235–264). The N+1 loop:

    ```ts
    const resolveCounts = async (countInput: Record<string, true>): Promise<void> => {
        for (const name of Object.keys(countInput)) {
            const relation = requireRelation(name);
            const [whereField, parentField] = relation.kind === "many" ? [relation.field, relation.references] : [relation.references, relation.field];

            const countByValue = new Map<unknown, number>();

            // RLS: AND the child table's read policy into the count.
            const policyWhere = relationBaseWhere?.(relation.table);

            for (const value of distinctValues(parents, parentField)) {
                const countWhere: WhereInput = policyWhere ? { AND: [{ [whereField]: value }, policyWhere] } : { [whereField]: value };

                // eslint-disable-next-line no-await-in-loop -- one aggregate query per distinct FK value; sequential keeps the count fan-out bounded
                countByValue.set(value, await counter(relation.table, countWhere));
            }

            for (const parent of parents) {
                const counts = (parent["_count"] as Record<string, number> | undefined) ?? {};
                const parentValue = parent[parentField];

                counts[name] = parentValue === null || parentValue === undefined ? 0 : (countByValue.get(parentValue) ?? 0);
                parent["_count"] = counts;
            }
        }
    };
    ```

- `packages/do/src/relations.ts:1-33` — the header docstring states the design
  constraint explicitly: _"`_count` aggregation is the one exception: it issues
  one `count` per distinct parent FK value (no single GROUP BY yet), since the
  injected `counter` returns a scalar rather than grouped tallies."_ The
  `counter` (and `fetcher`) are **injected by each backend** — the DO passes its
  `writer.count`, D1 passes its async twin. That is the contract you must extend.

## Investigate before implementing (do this first)

This change is only worth doing if a grouped-count can be wired for **both**
backends. Before writing code, find and read:

1. Where the DO injects `counter` into `resolveWith` — grep for `resolveWith(`
   and `counter` in `packages/do/src/` (likely the shard ctx-db, `ctx-db.ts`).
   Confirm the DO writer can express `SELECT <fk>, COUNT(*) ... WHERE <fk> IN (...)
[AND <policy>] GROUP BY <fk>` (the JSON-blob/SQLite store).
2. Where the D1 backend injects its `counter` — grep in `packages/d1/src/`.
   Confirm the D1 adapter can express the same grouped query, including the
   cross-shard reverse direction noted in the header docstring (global parent →
   shard-local child counts via the Query Coordinator's `fanOut`).

If **either** backend cannot express a grouped count without a deep rewrite
(especially the cross-shard reverse direction), STOP and report — a partial fix
that only batches one backend is not in scope.

## Commands you will need

| Purpose          | Command                                     | Expected on success |
| ---------------- | ------------------------------------------- | ------------------- |
| Build deps first | `pnpm run build:packages`                   | exit 0 (run once)   |
| Typecheck (do)   | `pnpm --filter "@lunora/do" run lint:types` | exit 0              |
| Typecheck (d1)   | `pnpm --filter "@lunora/d1" run lint:types` | exit 0              |
| Tests (do)       | `pnpm --filter "@lunora/do" run test`       | all pass            |
| Tests (d1)       | `pnpm --filter "@lunora/d1" run test`       | all pass            |
| Lint             | `pnpm run lint:eslint`                      | exit 0              |

## Scope

**In scope**:

- `packages/do/src/relations.ts` — `resolveCounts` to use a grouped counter.
- The DO injection site (the file found in "Investigate", likely
  `packages/do/src/ctx-db.ts`) — provide the grouped counter.
- The D1 injection site (likely under `packages/d1/src/`) — provide the grouped
  counter.
- The relation-loader tests: `packages/do/__tests__/ctx-db.relations.test.ts`
  and `packages/do/__tests__/relation-fanout.test.ts`, plus any D1 relation test.

**Out of scope**:

- Other relation kinds (`many`/`one` row loading) — already batched; do not touch.
- The RLS `relationBaseWhere` policy composition — must be preserved exactly
  (the grouped query must still AND the child policy in).
- Changing the public `with`/`_count` API surface or response shape.

## Git workflow

- Branch: `advisor/067-do-count-relation-group-by`.
- Commit style: `perf(do): batch _count relation aggregate via grouped query`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add a grouped-count capability to the injected contract

Introduce an injected `groupedCounter(table, whereField, values, policyWhere?) =>
Promise<Map<unknown, number>>` (name/shape to match the existing injection
style) that runs a single `WHERE <whereField> IN (values) [AND policyWhere]
GROUP BY <whereField>` and returns tallies keyed by the FK value, defaulting
missing keys to 0. Keep the existing scalar `counter` if other code paths use it;
add the grouped one alongside.

**Verify**: typecheck both packages (`do`, `d1`) → exit 0.

### Step 2: Rewrite `resolveCounts` to use one grouped query per relation

Replace the per-value `await counter(...)` loop with a single
`await groupedCounter(relation.table, whereField, distinctValues(parents, parentField), policyWhere)`,
then attach `_count` to each parent from the returned map (preserving the
`null`/`undefined` parent-FK → 0 behavior).

**Verify**: `pnpm --filter "@lunora/do" run test` → relation tests pass.

### Step 3: Wire the DO and D1 grouped counters

Implement `groupedCounter` for each backend at its injection site, preserving the
RLS policy AND and the cross-shard reverse direction (route through the same
`fanOut`/coordinator path the scalar counter used; sum per-FK tallies across
shards).

**Verify**: `pnpm --filter "@lunora/d1" run test` and
`pnpm --filter "@lunora/do" run test` → all pass.

## Test plan

- New/extended cases in `ctx-db.relations.test.ts` (DO) and the D1 relation test:
    - a page of parents sharing FK values → each parent's `_count` matches the
      per-group tally, computed in a single grouped query (assert via a query-count
      spy on the injected counter if the harness supports it; otherwise assert the
      values and add a comment that batching is the intent);
    - a parent with a `null`/absent FK → `_count` is 0;
    - RLS: a child policy that hides some rows → the count excludes them (the
      grouped query ANDs the policy);
    - reverse cross-shard direction (in `relation-fanout.test.ts`) → tallies sum
      correctly across shards.
- Structural pattern: model after the existing relation tests in those files.
- Verification: both packages' test suites pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter "@lunora/do" run lint:types` and
      `pnpm --filter "@lunora/d1" run lint:types` exit 0.
- [ ] `pnpm --filter "@lunora/do" run test` and
      `pnpm --filter "@lunora/d1" run test` exit 0.
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] `resolveCounts` no longer contains a `for (... of distinctValues(...))`
      loop with an `await counter` inside it
      (`grep -n "no-await-in-loop" packages/do/src/relations.ts` no longer flags
      the count loop).
- [ ] The relation-loader header docstring is updated to drop the "no single
      GROUP BY yet" caveat.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- Either backend cannot express a grouped count without a deep rewrite —
  especially the cross-shard reverse direction (global parent → shard-local
  child). A one-backend-only fix is out of scope.
- The grouped query cannot AND the RLS `policyWhere` in (a count must never
  reveal rows the caller can't read — this is a correctness invariant, not just
  perf).
- `resolveCounts` no longer matches the "Current state" excerpt.

## Maintenance notes

- The RLS-AND in the grouped query is load-bearing for security — a reviewer must
  confirm the policy is composed into the grouped `WHERE`, not dropped.
- If a future change adds grouped tallies to other relation kinds, the injected
  `groupedCounter` shape introduced here is the pattern to extend.
- The cross-shard reverse-direction summation is the subtlest part; flag it for
  careful review.
