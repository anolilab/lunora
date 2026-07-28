# Plan 203 — Time-ranged statement-level query insights

- **Category**: feat/obs (competitive parity — Prisma Studio Query Insights)
- **Priority**: P2
- **Effort**: M · **Risk**: LOW
- **Status**: TODO
- **Baseline**: `865a9a4c` (2026-07-28)
- **Goal**: turn the existing lifetime slow-query leaderboard into a time-ranged
  view — throughput and latency over 1m/5m/15m/1h, p95 alongside the mean, and a
  live tail — so an operator can answer "what is hot _right now_", not only
  "what has been hot since this shard was created".

## Context (verified)

**We already collect per-statement metrics.** `packages/do/src/query-metrics.ts`
(188 lines) records into the reserved `__lunora_metrics_queries` table:
`normalizeSql()` strips literals (quoted strings, numerics, hex → `?`), collapses
whitespace, and truncates to a bounded length so the primary key stays compact;
`recordQueryMetric()` is called on the DO's SQL path
(`packages/do/src/shard-do.ts:5838`); `readQueryMetrics()` feeds
`getMetrics()`'s `queryStats` field (`shard-do.ts:5694`, best-effort — a missing
table yields an empty feed rather than failing the read).

**And we already surface them.** `QueryStatEntry` =
`{ normalizedSql, execCount, rowsRead, rowsWritten, totalDurationMs }` is typed
in `packages/studio/src/lib/admin.ts:252` and rendered in a "Query insights" tab
in `features/reports/metrics-panel.tsx:123`, enriched by
`enrichQueryStats` (`features/reports/metrics-aggregate.ts:218`) — which adds
exactly one derived field, `avgDurationMs = totalDurationMs / execCount`.

**So the gap is narrower than "we have no query insights".** What is missing:

| Missing            | Why it matters                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Any time dimension | Counters are cumulative for the life of the shard. A statement that was catastrophic yesterday and fixed today looks the same as one melting down now. |
| Percentiles        | Only a mean. A mean hides the tail, which is the thing operators actually chase.                                                                       |
| Live tail          | The tab refreshes with the metrics snapshot; there is no "watch it move".                                                                              |
| Honest caps        | `QUERY_METRICS_MAX_STATEMENTS` silently drops statements past the cap — the UI reads as complete coverage when it is not.                              |

**What Prisma does** (`Architecture/query-insights.md`): live query rows plus
throughput and latency charts over explicit **1m, 5m, 15m, 1h** ranges, sortable,
with traffic-exclusion and sanitization rules so Studio's own queries do not
pollute the numbers.

**The precedent for the fix already exists in-repo.**
`packages/do/src/function-metrics.ts` (594 lines) solves this exact problem one
level up: `__lunora_metrics` holds lifetime per-function accumulators and
`__lunora_metrics_buckets` holds coarse time-bucketed counters (`path` × `bucketMs`),
"giving a basic per-function time series the studio can chart", with the row count
bounded to one row per function per window. Plan 203 is that pattern applied to
statements instead of functions.

## Phase 1 — Time buckets

- [ ] Reserved `__lunora_metrics_queries_buckets`: `(sqlHash, bucketMs)` primary
      key, columns `execCount`, `totalDurationMs`, `rowsRead`, `rowsWritten`.
      Keyed by a hash of the normalized SQL (not the text) to keep the composite
      key small; the text stays in the existing table, joined on read.
- [ ] `recordQueryMetric` writes both rows in the same pass — one extra
      `INSERT … ON CONFLICT DO UPDATE`, matching the hot-path shape
      `function-metrics.ts` already accepts.
- [ ] Bucket width: reuse the per-function window so both series line up on one
      time axis. Verify the concrete value in `function-metrics.ts` before
      picking — do not introduce a second, differently-sized window.
- [ ] Bounded retention: prune buckets older than the longest supported range
      (1h) plus a margin, on the same sweep that already maintains the table.
      **Cardinality is the real risk here** — bucket rows are
      statements × windows, so the prune is load-bearing, not hygiene.

## Phase 2 — Percentiles without storing samples

- [ ] Fixed logarithmic latency histogram per `(sqlHash, bucketMs)` — a small
      bounded set of counter columns (e.g. ≤1ms, ≤2, ≤5, ≤10, … ≤5s, >5s).
      p50/p95 are interpolated from bucket boundaries on read.
- [ ] Explicitly **not** storing per-execution samples: unbounded growth on the
      hot path, for a precision nobody needs at this altitude. The histogram's
      accuracy limit (bucket-boundary interpolation) is documented in the read
      path so the number is not over-trusted.

## Phase 3 — Read path

- [ ] `__lunora_admin__:getQueryInsights` taking `{ range: "1m"|"5m"|"15m"|"1h",
sort, limit }` → per-statement rows (execCount, rows, mean, p50, p95) plus a
      bucketed series for the chart. Separate from `getMetrics` — the snapshot RPC
      should not grow a time-series payload it mostly does not need.
- [ ] Report the cap honestly: return `{ trackedStatements, capped: boolean }`
      so the UI can say "showing N of a capped set" instead of implying totality.
- [ ] Best-effort like every other reserved-table read: an unmigrated shard
      returns an empty feed, never an error.

## Phase 4 — The view

- [ ] Promote the "Query insights" tab in `features/reports/metrics-panel.tsx`
      into a range-selector view: throughput chart + latency chart (`recharts`,
      already a dependency) above the existing sortable table.
- [ ] p95 column beside the mean; sort by any column; range in URL state so a
      view is shareable (see plan 205 Phase 5).
- [ ] Live tail: subscribe the way the other panels do (`useAdminQuery` with
      `live: true`) rather than polling.
- [ ] Exclude Studio's own admin RPC traffic from the numbers, or label it —
      Prisma's traffic-exclusion rule. An operator investigating a hot statement
      must not be looking at the tool's own reads.
- [ ] Deep-link a statement to the advisor's index recommendation where one
      applies (`features/advisors/apply-index-button.tsx` already exists).

## Exit criteria

- Selecting 1m/5m/15m/1h changes the numbers, and a statement run 100× in the
  last minute ranks above one run 10,000× last week.
- p95 is present and provably derived (unit test: known latency distribution →
  expected percentile within the histogram's documented tolerance).
- The capped-set disclosure appears when the statement cap is hit.
- Bucket-table growth is bounded under a synthetic high-cardinality load
  (many distinct statements) — asserted by a test, not assumed.
- No measurable regression on the DO SQL hot path from the second upsert
  (`packages/do/__bench__` has the precedent for measuring this).

## Non-goals

- Full APM. This is per-shard, per-statement, over a short window — the retained
  long-horizon view belongs to `apps/cloud` (see the Wave 14 CLOUD bucket).
- Capturing statement _parameters_. Normalization strips literals deliberately;
  restoring them would put user data in a metrics table.
- Cross-shard aggregation of query stats. Every reserved metrics table is
  per-shard; the panel shows the selected shard.
