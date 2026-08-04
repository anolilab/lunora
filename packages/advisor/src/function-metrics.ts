/**
 * One function's observed call/error/latency volume over the window — the input
 * a runtime reliability lint (`error_rate_outlier`, and a future latency
 * counterpart) reads.
 *
 * Not a new collection path: this is the same `FunctionCallStat` row shape
 * `__lunora_admin__:getFunctionStats` already returns and the studio's Advisors
 * panel already fetches (today only its `scannedTables` field feeds
 * `AdvisorTableScan`/`context.tableScans`); this type carries the `calls`/
 * `errors`/`maxDurationMs` columns of that same row instead. Prototype (plan
 * 248) — see `plans/248-runtime-lints-design.md` for the reachability finding
 * and the open scope/threshold questions before productizing further.
 *
 * Scope caveat: `getFunctionStats` reads one shard's durable `__lunora_metrics`
 * table with no cross-shard fan-out (unlike `AdvisorShardTraffic`, which
 * `orchestrateShardTraffic` sums across every shard). A caller feeding this from
 * a sharded function's single selected shard is reporting that shard's rate, not
 * the function's deployment-wide rate — same scope `lunora insights` itself
 * already operates at.
 */
export interface AdvisorFunctionMetrics {
    /** Total dispatches of `path` over the observed window. */
    calls: number;
    /** Dispatches that threw, over the same window. */
    errors: number;
    /** Slowest single dispatch, ms, over the same window. */
    maxDurationMs: number;
    /** The function's registered path (`&lt;file>:&lt;exportName>`). */
    path: string;
}
