# Plan 528 — Expire durable rate-limit rows (createDbStore / createSqlStore)

**Baseline:** `433f1859f` (2026-10-16)
**Status:** IN REVIEW — PR #1225 (stacked on #1223)

## 0. Headline finding

The durable rate-limit stores never delete a row. `createDbStore` keeps one row per
`(table, key)` pair, and `createSqlStore` keeps one per `(name, key)` in
`_lunora_rate_limits`. Plan 527 bounds the in-memory store; the durable rows still grow by one
per distinct key for the life of the app. On D1 this is the `rateLimits` table (default name, or
the app's own `ratelimit_buckets`), and on DO SQLite it is `_lunora_rate_limits` in each shard.

Same horizon rule as plan 527 applies: a row whose stored `ts` is older than its config's
retention behaves as absent. Plan 527 §4 and its correction cover the debt exception: a row with a
negative `value` must not be swept.

## 1. Current state (audit)

- `packages/ratelimit/src/store.ts` `createSqlStore`: `delete` exists, but the limiter only calls
  it from `reset()` (`rate-limiter.ts:155-158`). No store path removes idle rows.
- `packages/ratelimit/src/store.ts` `createDatabaseStore`: same. `ts` is a column but nothing
  filters or deletes on it.
- The DB store's `idCache` is per call (`database-middleware.ts`), so it is not a leak. The row
  table is.

## 2. Existing seams (do not reinvent)

- Plan 527's retention helper (`retentionMs` beside `availableAt`) and its debt exception.
- `createSqlStore` already runs `CREATE TABLE IF NOT EXISTS`, so an index on `ts` can be added
  the same way.
- Lunora's scheduler (`@lunora/scheduler`) already runs periodic jobs; a sweep can be one.

## 3. The behavioural contract to preserve

- Decisions are identical with and without the sweep (the plan 527 differential test, run against
  the durable stores).
- No row with a negative `value` is deleted.
- A row inside its retention is never deleted.

## 4. Design decisions (owner input needed)

- **Decided (2026-10-16): option (a), a bounded sweep on write.** The lead chose it so the store
  stays self-contained; option (b) is not built. Original options:
- **Where the sweep runs.** Options: (a) on write, deleting up to N expired rows through an index
  on `ts`, which keeps the store self-contained but adds a delete to the consume path; (b) a
  scheduled job through `@lunora/scheduler`, which keeps the consume path unchanged but needs the
  app to register it; (c) both. The consume path is the hot path, so (a) must stay bounded.
- **Who registers the job** for option (b): the ratelimit plugin, or the app. Decide with the
  owner of `@lunora/scheduler`.
- **Ceiling to record:** with (b), rows accumulate up to one scheduler interval of churn.

## 5. Workstreams

- **W1 (S):** add `ts` index in `createSqlStore` and the documented `createDbStore` table shape.
- **W2 (S):** `sweepExpired(now, limit)` on both stores, retention from plan 527, debt rows kept.
- **W3 (S):** wire the sweep per §4's decision.

## 6. Platform parity

The sweep runs on both D1 (`createDbStore` through `ctx.db`) and DO SQLite (`createSqlStore`), so
each target needs the same delete. Both are `native` today for `ctx.db` writes; record the
decision in `PlatformCapabilities` only if a new `ctx.*` surface is added. None is, so this is
"not applicable" for the matrix.

## 7. Phasing & ordering

| Phase | Work                 | Gate                                                                                         |
| ----- | -------------------- | -------------------------------------------------------------------------------------------- |
| 0     | Owner decision in §4 | Written choice in this file.                                                                 |
| 1     | W1 + W2              | Store tests: expired rows removed, debt rows kept, index used (EXPLAIN in a workerd test).   |
| 2     | W3                   | Differential decision test against the durable stores; row count bounded in a long-run test. |

Depends on plan 527 (retention helper and debt rule).
