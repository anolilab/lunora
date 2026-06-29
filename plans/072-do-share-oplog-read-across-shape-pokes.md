# Plan 072: Share the op-log read across shape pokes in one flush

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report. When done, update the
> status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9f779358..HEAD -- packages/do/src/shard-do.ts`
> If it changed, compare the "Current state" excerpts against the live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plan 070 (the shape resume/diff matrix tests — land them first
  as the safety net for this change)
- **Category**: perf
- **Planned at**: commit `9f779358`, 2026-06-29

## Why this matters

On every write flush, `pokeShapeSubscribers` iterates each socket and each shape
on that socket, calling `buildShapeDiff(sql, resolved, memoCursor, checkpoint)`
per shape. `buildShapeDiff` drains the changelog over `(memoCursor, checkpoint]`
by repeatedly calling `readCdcChanges` and collapsing ops to the latest-per-row.
In steady state, every socket's shape memo sits at the **same** checkpoint (they
were all poked through the last flush), so this re-reads and re-parses the **same
op page** once per (socket, shape) — O(sockets × shapes × oplog) where the op-read
is really O(oplog) for the flush. Caching the op-range read + the collapsed
latest-op map, keyed by `(table, sinceSeq)` for the duration of one flush, lets
every shape resolving the same range reuse it; only the per-shape membership
probe (`selectShapeMemberIds`, which depends on each shape's `effectiveWhere`)
stays per-shape. This cuts the dominant repeated work on the poke hot path.

## Current state

- `packages/do/src/shard-do.ts` — `pokeShapeSubscribers` (starts ~6002). Inside
  `pokeOne(ws)`, per shape:

    ```ts
    const memoCursor = this.shapeMemos.get(ws)?.get(subId)?.cursor ?? 0;
    const rowsPatch = this.buildShapeDiff(sql, resolved, memoCursor, checkpoint);
    ```

- `buildShapeDiff` (lines 6111–6162) drains the op range, then probes membership:

    ```ts
    private buildShapeDiff(sql: SqlExec, resolved: ResolvedShape, sinceSeq: number, upTo: number): ShapeRowOp[] {
        const latest = new Map<string, CdcChange>();
        const tables = new Set([resolved.table]);
        let from = sinceSeq;

        for (;;) {
            const { changes, cursor } = readCdcChanges(sql, { sinceSeq: from, tables });
            for (const change of changes) {
                latest.set(change.id, change);
            }
            if (changes.length === 0 || cursor === from || cursor >= upTo) {
                break;
            }
            from = cursor;
        }

        if (latest.size === 0) {
            return [];
        }

        const ids = [...latest.keys()];
        const members = selectShapeMemberIds(sql, resolved.table, resolved.effectiveWhere, ids);
        // ... build ops from latest + members ...
    }
    ```

    The shareable part is the **`(table, sinceSeq, upTo)` → `latest` map** (the op
    drain + collapse). `selectShapeMemberIds(... resolved.effectiveWhere ...)` is
    inherently per-shape and stays per-shape.

## Commands you will need

| Purpose          | Command                                     | Expected on success |
| ---------------- | ------------------------------------------- | ------------------- |
| Build deps first | `pnpm run build:packages`                   | exit 0 (run once)   |
| Tests            | `pnpm --filter "@lunora/do" run test`       | all pass            |
| Typecheck        | `pnpm --filter "@lunora/do" run lint:types` | exit 0              |
| Lint             | `pnpm run lint:eslint`                      | exit 0              |

## Scope

**In scope**:

- `packages/do/src/shard-do.ts` — `pokeShapeSubscribers` and `buildShapeDiff`
  (introduce a per-flush op-range cache; split the op-drain from the membership
  probe).
- `packages/do/__tests__/shard-do.shape-poke.test.ts` — extend if needed to cover
  multiple shapes sharing a range in one flush.

**Out of scope**:

- The membership probe (`selectShapeMemberIds`) and `effectiveWhere` resolution —
  must stay per-shape and unchanged in behavior.
- The seed path (`buildShapeSeed`) and `seedSubscription` — not part of the
  per-flush fan-out.
- `readCdcChanges` itself — reuse it; don't change its contract.

## Git workflow

- Branch: `advisor/072-do-share-oplog-read-across-pokes`.
- Commit style: `perf(do): share op-log read across shape pokes in one flush`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Land plan 070's resume/diff tests first

Confirm `pnpm --filter "@lunora/do" run test` is green with plan 070's matrix in
place. These are the behavioral safety net — this optimization must not change
any observed poke output. If 070 isn't done, STOP and do it (or report).

### Step 2: Extract the op-drain from `buildShapeDiff`

Split `buildShapeDiff` into:

- a pure op-range drain `collapseOpRange(sql, table, sinceSeq, upTo) =>
Map<string, CdcChange>` (the loop that builds `latest`), and
- the membership-probe + ops-build step that takes a precomputed `latest`.

Keep `buildShapeDiff`'s external behavior identical (it can call both internally),
so the unit tests over it stay valid.

**Verify**: `pnpm --filter "@lunora/do" run test` → all pass (no behavior change yet).

### Step 3: Add a per-flush op-range cache in `pokeShapeSubscribers`

At the top of `pokeShapeSubscribers`, create a `Map<string, Map<string, CdcChange>>`
keyed by `${table}:${sinceSeq}` (the `upTo` is the flush `checkpoint`, constant
for the flush). When resolving a shape, look up the collapsed range for its
`(table, memoCursor)`; compute-and-cache on miss; then run the per-shape
membership probe against the cached `latest`. Memos at different cursors get
different cache keys (correctly), so sockets that lag share nothing with current
ones — which is fine and correct.

**Verify**: `pnpm --filter "@lunora/do" run test` → all pass. Add/confirm a test
where two shapes on two sockets resolve the same `(table, sinceSeq)` in one flush
and produce the same per-shape diffs as before.

## Test plan

- Behavioral invariant: the poke output for every shape is byte-identical to the
  pre-change output across the resume/diff matrix (plan 070) and the existing
  shape-poke test.
- New/extended case: two sockets each subscribed to a (differently-predicated)
  shape on the same table at the same memo cursor → both get correct diffs in one
  flush (proves cache sharing doesn't cross-contaminate membership).
- Structural pattern: `shard-do.shape-poke.test.ts`.
- Verification: `pnpm --filter "@lunora/do" run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter "@lunora/do" run lint:types` exits 0.
- [ ] `pnpm --filter "@lunora/do" run test` exits 0 (incl. plan 070's matrix and
      the new shared-range case).
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] The op-drain loop appears once (in the extracted helper), not duplicated —
      `buildShapeDiff` delegates to it.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- `pokeShapeSubscribers` / `buildShapeDiff` no longer match the "Current state"
  excerpts.
- Plan 070's resume/diff tests are not in place (no safety net).
- The cache key can't be made correct because `upTo`/`checkpoint` is NOT constant
  across the flush (re-read the flush setup — `checkpoint` is computed once at the
  top of `pokeShapeSubscribers`; if that changed, the keying premise is invalid).
- Sharing the collapsed range changes any poke's output in a test.

## Maintenance notes

- The cache is per-flush (a local Map), never persisted — it must be created
  fresh each `pokeShapeSubscribers` call so a later flush can't reuse a stale
  range.
- The membership probe staying per-shape is the correctness boundary: never cache
  across different `effectiveWhere`. A reviewer should confirm only the op-drain
  is shared.
- Plan 074 (worker-pool dedup) also touches this method; coordinate ordering
  (do 072 first, then 074 rebases onto it).
