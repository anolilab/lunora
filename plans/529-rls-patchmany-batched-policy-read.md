# Plan 529 — Batch the RLS policy re-read in patchMany

**Baseline:** `433f1859f` (2026-10-16)
**Status:** CLOSED — not worth it (W1 gate failed: 100-row policy-read cost is ~0.5 ms, under the 5 ms bar)

## 0. Headline finding

`patchMany` on a policy-protected table runs one policy check per row. Each check is a separate
`raw.findFirst(located.tableName, { baseWhere, limit: 1, where: { _id: id } })` through the
unguarded writer (`packages/server/src/rls/middleware.ts` ~1589-1596, inside `gatePatchById`).
A `patchMany` over N rows therefore costs N policy reads plus N patches, all serial. The delete
path already batches its policy re-read (#1188); patch does not. This is an N+1 on the write path
of RLS tables, and its size is not measured yet.

## 1. Current state (audit)

- `gatePatchById` (`rls/middleware.ts` ~1589-1596): one `findFirst` by `_id` with `baseWhere`
  per call.
- `patchMany` loops over ids and awaits `gatePatchById` for each.
- #1188's `deleteReadRows` re-reads rows in one query when `deleteRereadTables` contains the table.
  Patch has no equivalent.

## 2. Existing seams (do not reinvent)

- `deleteReadRows` and `deriveDeleteRereadTables` (`packages/shard-engine/src/ctx-db.ts`) show the
  batched shape: one `findMany` with `_id in (...)` under `baseWhere`.
- The point lookup already coalesces into one `IN` list for reads (perf audit 2026-10-14 notes),
  so the engine supports `IN` on `_id`.

## 3. The behavioural contract to preserve

- Each row is judged by the same `baseWhere` policy as today. A row the policy denies is not
  patched, and the denial is reported the way `patchMany` reports it now.
- Ordering of patches and error propagation are unchanged.
- No new bypass: the batched read stays on the unguarded writer and is scoped by `baseWhere`.

## 4. Design decisions

- **One `findMany({ baseWhere, where: { _id: { in: ids } } })`** replaces N `findFirst` calls, then
  the allowed set is a `Set` lookup per id. Alternative: keep per-row reads and add concurrency.
  Rejected: concurrency on one DO's SQLite gives no win, and the input gate already serialises it.
- **Chunk the `IN` list** to the SQLite bound-parameter ceiling (100 per statement on DO SQLite,
  see the workerd SQLite limits note). Chunk size 50 leaves headroom for `baseWhere` params.

## 5. Workstreams

- **W1 (S):** measure first. Time `patchMany` over 1, 100, 1000 rows on a policy table, before the
  change, in a workerd test. Record the numbers in this file.
- **W2 (M):** batched policy read in `patchMany`, chunked, with the same per-row verdicts.
- **W3 (S):** differential test: random policy outcomes over N rows, batched vs per-row,
  identical patched set and identical errors.

## 6. Platform parity

Not applicable: this changes the RLS middleware's internal read, not a `ctx.*` surface or a
binding. Every target that runs the shard engine gets the same behaviour.

## 7. Phasing & ordering

| Phase | Work  | Gate                                                                                      |
| ----- | ----- | ----------------------------------------------------------------------------------------- |
| 0     | W1    | Numbers recorded here; if 100-row patch is under ~5 ms, close the plan as not worth it.   |
| 1     | W2+W3 | Differential test passes; workerd RLS suite passes (`pnpm run test:workerd`, do package). |

## 8. W1 measurement (recorded 2026-10-16, alpha `97d5178ec`)

Harness: a temporary workerd test (`packages/do/__tests__/workerd/`, `LUNORA_WORKERD_TESTS=1`, project
`workerd`) on a real Durable Object's SQLite. `docs` table, 1000 seeded rows owned by `u1`. The policy is
`read` (a `whereFilter` `{ ownerId: "u1" }`) plus `update` (`row.ownerId === "u1"`), run through `rls()` and
`ctx.db.patchMany(patches, { limit: 1000 })`. The baseline is the same writer's `patchMany` with no RLS
middleware. Each sample repeats the call (50 / 10 / 2 times for 1 / 100 / 1000 rows) and divides the wall
time, because workerd's `performance.now()` resolves to about 1 ms. Median of 9 samples, one warm-up dropped.
The harness was deleted after the run; nothing from it is committed.

| Rows | No RLS (median ms) | Under RLS (median ms) | Policy overhead (ms) |       Statements / call, no RLS |          Statements / call, RLS |
| ---: | -----------------: | --------------------: | -------------------: | ------------------------------: | ------------------------------: |
|    1 |               0.02 |                  0.02 |                 ~0.0 |          3 (2 SELECT, 1 UPDATE) |          4 (3 SELECT, 1 UPDATE) |
|  100 |                0.8 |                   1.3 |                 ~0.5 |    300 (200 SELECT, 100 UPDATE) |    400 (300 SELECT, 100 UPDATE) |
| 1000 |                7.5 |                  11.0 |                 ~3.5 | 3000 (2000 SELECT, 1000 UPDATE) | 4000 (3000 SELECT, 1000 UPDATE) |

Gate: the 100-row policy-read cost is about 0.5 ms, under the ~5 ms bar. The plan is closed and W2/W3 are
not started.

### Findings that change the plan's premise

- **The extra statement per row is `lookupById`, not a `baseWhere` policy read.** `patchMany` goes through
  `gatePatchById` → `gateById` → `findRowTable` → `locateRow`, which issues one `raw.lookupById(id)` per id.
  The update decision is then the in-memory `allowsWrite`. No `findFirst` with `baseWhere` runs on the patch
  path. The `findFirst … baseWhere` calls in `middleware.ts` (~1540, ~1581) are in `get`/`lookupById`, not
  in `gatePatchById`. Batching `baseWhere` into one `findMany` would therefore not remove this cost.
- **The N+1 is real but small.** It is one extra `SELECT` per row (N extra statements). At 1000 rows it is
  about 3.5 ms of a 11 ms call. Per-row patches (the write itself, `2 SELECT + 1 UPDATE`) dominate the
  cost, and the write is already one statement per row outside this plan's scope.
- Re-check if the policy read path changes to use `baseWhere` on patch, or if a per-row write pipeline
  becomes cheaper and the policy overhead becomes a larger share.
