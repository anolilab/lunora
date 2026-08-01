# Plan 248 — Feeding `lunora insights` error-rate/latency into the runtime-advisor category (design spike)

**Baseline:** `524ded734` (2026-07-31)
**Status:** DONE (spike) — reachability confirmed, one lint prototyped; productizing the rest is follow-on work

## 0. Headline finding

The runtime-advisor category's data channel (`LintContext`'s `shardTraffic` /
`tableScans` / `indexHits`) carries **no** error-rate or latency signal today —
confirmed by reading `packages/advisor/src/types.ts`'s `LintContext` in full.
But that is not because the underlying data is unreachable: the studio's
Advisors panel (`packages/studio/src/features/advisors/insights-panel.tsx`)
already fetches the exact per-function rows that carry it
(`__lunora_admin__:getFunctionStats` → `FunctionCallStat { calls, errors,
maxDurationMs, totalDurationMs, scannedTables }`) and already threads that same
array into `deriveRuntimeAdvisories`'s `functions` input — today only to pull
`scannedTables` out of it for `tableScans`. `errors`/`maxDurationMs` ride along
in the same rows, unused.

So: **reachable, at the granularity `lunora insights` itself already operates
at** (one shard's `getFunctionStats` snapshot), via a feed the caller already
holds. **Not reachable at `hot_shard`'s cross-shard granularity** — `hot_shard`
gets that reach from `orchestrateShardTraffic`, a fan-out that exists for
`getMetrics` (request counts) but has no equivalent for `getFunctionStats`
(error/latency counts) today. Building that fan-out would be new plumbing, which
this spike does not build (see §3).

One lint, `error_rate_outlier`, is prototyped end-to-end (type, lint, tests) —
see §4. Latency and the cross-shard question are left open (§5, §6).

## 1. Current state (verified)

- `packages/advisor/src/types.ts`'s `LintContext` interface: the only
  runtime-signal fields are `shardTraffic?: ReadonlyArray<AdvisorShardTraffic>`
  (per-shard request counts), `tableScans?: ReadonlyArray<AdvisorTableScan>`
  (per-table full-scan counts), and `indexHits?: ReadonlyArray<AdvisorIndexHit>`
  (per-index read counts). No error or duration field exists anywhere in the
  interface — grepped for `errorRate`/`latency`/`duration`/`p50`/`p95`/`p99`
  across `packages/advisor/src/**/*.ts` with no hits outside comments about
  D1/global-table poll latency (unrelated).
- `packages/advisor/src/lints/runtime/hot-shard.ts` reads `context.shardTraffic`
  only. Its docblock: "The per-shard request volume comes from the runtime
  feeder (`context.shardTraffic`): the studio backend fans out over the
  function's shards and reads each shard's recorded `__lunora_metrics` call
  total" — i.e. `hot_shard`'s reach comes from a **cross-shard fan-out**
  (`orchestrateShardTraffic`, `packages/runtime/src/query-coordinator.ts:1903`),
  which calls `getMetrics` (not `getFunctionStats`) on every shard in the
  function's registry and rolls up the per-shard totals.
- `packages/advisor/src/lints/runtime/index-utilization.ts` reads
  `context.tableScans` / `context.indexHits`, sourced from
  `FunctionCallStat.scannedTables` (aggregated in
  `packages/studio/src/features/advisors/derive-runtime-advisories.ts`'s
  `aggregateTableScans`) and the durable `__lunora_metrics_index` table via
  `getMetrics` respectively — again the fan-out or dead-index path, not
  per-function error/latency.
- `packages/cli/src/commands/insights/handler.ts` reads
  `__lunora_admin__:getFunctionStats` directly (`GET_FUNCTION_STATS_OP`),
  **scoped to one shard** (root, or `--shard <key>`; no fan-out). The row type
  (`FunctionStatRow`) carries `calls`, `errors`, `conflicts?`,
  `lastErrorMessage`, `maxDurationMs`, `totalDurationMs`. `buildInsightsReport`
  already ranks `errorHotspots` (by `errors/calls`) and `latencyOutliers` (by
  `maxDurationMs`) from exactly these fields — this is the report the plan asks
  to feed into the advisor gate.
- `packages/studio/src/lib/admin.ts`'s `FunctionCallStat` (the studio's own copy
  of the same wire shape) carries the identical fields, **plus**
  `scannedTables?`. `packages/studio/src/features/advisors/insights-panel.tsx:170`
  fetches it via `useAdminQuery<FunctionStatsResult>(ADMIN_FUNCTIONS.getFunctionStats,
{}, { live: true, shardKey: debouncedShard })` — single-shard, matching the
  CLI's scope — and passes the resulting `functions` array straight into
  `deriveRuntimeAdvisories({ functions, ... })` at line 369.
- `packages/studio/src/features/advisors/derive-runtime-advisories.ts`'s
  `aggregateTableScans(inputs.functions ?? [])` is the **only** thing done with
  that `functions` array today — it walks `scannedTables` per row and discards
  the rest (`calls`, `errors`, `maxDurationMs`, `totalDurationMs`, `conflicts`).
- `packages/do/src/shard-do.ts:4911-4934`'s `collectFunctionStats` (backing
  `getFunctionStats`) reads the durable `__lunora_metrics` table — **this
  shard's** table, no cross-shard read. `orchestrateShardTraffic` (backing
  `hot_shard`'s `shardTraffic`) is a genuinely different code path: it fans
  `getMetrics` out over every shard key the registry returns for a table/group.
  There is no `getFunctionStats` equivalent of `orchestrateShardTraffic` — a
  deployment-wide, cross-shard error-rate/latency view does not exist.

## 2. The answer to the load-bearing question (STEP 1)

**Reachable — with a scope caveat, not stubbed.** The `functions` array
`deriveRuntimeAdvisories` already receives, on every render of the Advisors
panel, already carries `errors`, `calls`, and `maxDurationMs` per function
for the currently-selected shard. Wiring a new runtime lint to read those
fields requires exactly the same shape of change `tableScans`/`indexHits`
already are — a new `LintContext` field + a small aggregation/passthrough +
a lint file — not a new collection path, new RPC, or new fan-out. That is
what makes prototyping meaningful here rather than stubbed: the fixture in
§4's tests exercises the identical field shape the studio already has in
hand.

The caveat: this reach is **single-shard**, matching `lunora insights`'
own scope, not `hot_shard`'s deployment-wide cross-shard scope. Extending to
cross-shard would mean building a `getFunctionStats` fan-out analogous to
`orchestrateShardTraffic` — genuinely new plumbing, out of this spike's scope
per its own instruction not to build a parallel metrics feed. §6 records this
as the one open question that would gate productizing beyond a single shard.

## 3. What this spike does NOT build

- No new admin RPC, no new fan-out, no change to `@lunora/do` or
  `@lunora/runtime`. `error_rate_outlier` (§4) reads a `LintContext` field the
  caller must populate itself, exactly like `shardTraffic`/`tableScans` do —
  the studio wiring to actually populate `functionMetrics` from the `functions`
  array it already fetches is a follow-on (one line: project `functions` into
  `AdvisorFunctionMetrics[]` and pass it in `deriveRuntimeAdvisories`'s caller,
  mirroring `aggregateTableScans`). Left undone here so this spike stays inside
  `@lunora/advisor` per its stated scope (`packages/advisor/src`), and because
  wiring the studio caller before the threshold model (§5) is settled would
  ship a lint nobody has validated isn't noisy on real traffic.
- No latency lint. STEP 2 asks for ONE runtime lint; error-rate was chosen over
  p99-latency because it has a direct existing precedent to rank against
  (`lunora insights`' `errorHotspots`, itself just `errors/calls` — no
  percentile math) and a boolean-shaped signal (over threshold / not) that
  needed no new statistical machinery to prototype honestly. A latency lint
  needs the threshold-model answer (§5) even more than error-rate does — "how
  many ms is too many" has no domain-agnostic answer the way "how much of your
  traffic can error before that's a problem" arguably does (10% is a common
  SRE-ish default `hot_shard`'s own 50%-share threshold and
  `index-utilization`'s `HOT_SCAN_THRESHOLD = 25` show a similar "pick a
  round, defensible number, document it as a prototype threshold" convention).
- No change to `lunora insights` itself (explicitly out of scope) — it stays
  the human-readable report; the new lint duplicates its ranking logic rather
  than calling into it (see §6 for whether that duplication should collapse).

## 4. What was built (STEP 2 — prototype)

- `packages/advisor/src/function-metrics.ts` — new type
  `AdvisorFunctionMetrics { calls, errors, maxDurationMs, path }`, documented as
  sourced from the same `FunctionCallStat` rows `tableScans` already draws from,
  with the single-shard scope caveat stated inline.
- `packages/advisor/src/types.ts` — `LintContext.functionMetrics?:
ReadonlyArray<AdvisorFunctionMetrics>`, alongside `shardTraffic`/`tableScans`/
  `indexHits`, same "absent for static callers" contract.
- `packages/advisor/src/lints/runtime/error-rate-outlier.ts` — the
  `error_rate_outlier` lint (`PERFORMANCE`, `WARN`, `source: "runtime"`),
  modeled directly on `hot-shard.ts`'s structure (a `MIN_CALLS` volume floor
  mirroring `MIN_TOTAL_REQUESTS`, then an `ERROR_RATE_THRESHOLD` share check,
  one finding per over-threshold function). Both constants are marked
  PROTOTYPE THRESHOLD in their doc comments — see §5.
- Registered in `packages/advisor/src/index.ts`: import, named export, added to
  `RUNTIME_LINTS` (now `[hotShard, indexUtilization, constraintValidator,
errorRateOutlier]`) and the `AdvisorFunctionMetrics` type export.
- Tests: `packages/advisor/__tests__/runtime-lints.test.ts` — a high-error-rate
  function flags (100 calls, 15 errors → 15% ≥ 10% threshold), a healthy
  function doesn't (200 calls, 2 errors → 1%), a 100%-error function under the
  `MIN_CALLS` floor stays quiet (3 of 3 calls, floor is 20), the lint finds
  nothing without `functionMetrics` (static caller), and three functions with
  mixed rates each get judged independently. Updated the runtime-lint-count
  assertion to include the new lint.

**Verification run:** `pnpm --filter "@lunora/advisor" run test` — 454 passed
(62 files), `pnpm --filter "@lunora/advisor" run lint:types` — exit 0,
`pnpm --filter "@lunora/codegen" run lint:types` / `pnpm --filter "@lunora/studio"
run lint:types` — exit 0 (advisor's public surface only grew).

## 5. Threshold model (open question — not resolved by this spike)

Two provisional constants ship in the prototype (`MIN_CALLS = 20`,
`ERROR_RATE_THRESHOLD = 0.1`), explicitly marked as unvalidated. Real questions
a productizing pass must answer before this can run unattended in someone's CI:

- **Absolute vs. baseline-relative.** A flat 10% error rate is meaningless for
  a function whose normal operation involves client-driven 4xx-shaped throws
  (e.g. a validation action) versus one that should never fail
  (an internal db write). `hot_shard`'s 50%-share threshold has the same
  problem in miniature but gets away with it because "one shard dominating" is
  close to domain-agnostic; "10% of calls throwing" is not.
- **Sustained-over-window vs. point-in-time.** `context.functionMetrics` as
  designed is a single snapshot (cumulative since the counter's creation, same
  as `hot_shard`'s and `index_utilization`'s counters). A function that had a
  bad ten minutes eight hours ago and has been clean since still shows the same
  cumulative rate. `lunora insights` has the identical property today (it reads
  the same cumulative counters) and nobody has complained, which is weak
  evidence this is tolerable for a human report but not proof it's fine for a
  CI gate that fails a build.
- **No baseline to compare against.** There is no historical/rolling-window
  store the lint could diff "this week's rate" against "last week's" — the
  runtime harness is deliberately pure-function-over-a-snapshot (see
  `hot-shard.ts`'s docblock: "the lint is pure over that distribution"), so a
  trend-aware threshold would need a NEW persistence layer, squarely inside "do
  not build a parallel metrics feed."

Given this, `error_rate_outlier` should be treated as **not ready to gate CI**
without either (a) a documented, product-level decision that a flat threshold
is an acceptable first cut (the `hot_shard` precedent), or (b) the bucketed
history `packages/do/src/shard-do.ts`'s `collectFunctionMetricBuckets` /
`__lunora_metrics_buckets` already records for the studio's charts being
threaded in as a windowing signal (unexplored here — flagged as the most
promising next step, since unlike a fan-out it is _already collected_, just
not exposed to the advisor).

## 6. Surfacing + shared-feed question

- **How it surfaces in `lunora advisor`:** identically to `hot_shard` /
  `index_utilization` today — a `PERFORMANCE`/`WARN` finding in the same
  `runAdvisor({ source: "runtime" })` sweep, rendered by the studio's existing
  `advisoryRow` mapping. No new UI path needed.
- **Shared feed vs. duplicate query — answer: share, once wired.** The
  prototype's `AdvisorFunctionMetrics` type is deliberately shaped as a subset
  projection of the exact `FunctionCallStat` rows both `lunora insights` and
  the studio panel already fetch — not a second query. The follow-on wiring
  (§3) should project the SAME `functions` array `deriveRuntimeAdvisories`
  already holds into `functionMetrics`, the same way `aggregateTableScans`
  projects it into `tableScans` today. `lunora insights`' own
  `buildInsightsReport` and this lint would then be two different **views**
  (human report vs. CI gate) over one collection call, not two collectors —
  matching the "single source of truth" the plan asked about. Nothing here
  requires `lunora insights` itself to change.

## Non-goals (this spike)

- Wiring the studio caller to actually populate `functionMetrics` (needs §5
  resolved first, or an explicit "ship as opt-in / INFO-level, not WARN" call).
- A latency (`p99`/`maxDurationMs`) counterpart lint.
- Any change to `@lunora/do`, `@lunora/runtime`, or `lunora insights`.
- Resolving the AE-metrics-feeder question (plan 225 owns that; `ae-metrics.ts`
  was quarantined there, unrelated to this feed).
