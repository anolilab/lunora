/**
 * Observed read signal over a table — the input the `index_utilization` runtime
 * lint consumes. Produced by the studio backend from each shard's recorded
 * metrics.
 *
 * `AdvisorTableScan` comes straight from the per-`(function, table)` full-scan
 * attribution the runtime already records (`__cirrus_metrics_scans`, surfaced as
 * `FunctionCallStat.scannedTables`). Each entry is a table the app read with no
 * index — a hot one points at a missing index.
 *
 * `AdvisorIndexHit` is the per-declared-index hit count. The runtime now records
 * this in the durable `__cirrus_metrics_index` table (stamped on every index use
 * via `onIndexUse`) and surfaces it through the `getMetrics` admin RPC; the
 * studio sums the per-shard arrays and feeds them as `context.indexHits`, and the
 * lint flags a declared index with zero recorded reads as dead. When the feed is
 * absent (a static caller, or a shard that recorded nothing) the dead-index half
 * is a no-op and only the hot-scan half runs off the scan attribution.
 */

/**
 * Per-table full-scan volume observed over the window — a read that hit no
 * index. Sourced from `FunctionCallStat.scannedTables` aggregated across
 * functions and shards. Runtime callers supply this; static callers don't, so
 * the hot-scan half of the lint finds nothing there.
 */
export interface AdvisorTableScan {
    /** Total full-scans of `table` over the observed window. */
    scans: number;
    /** The full-scanned table. */
    table: string;
}

/**
 * Per-declared-index hit count observed over the window — how many recorded
 * reads used the index to narrow.
 *
 * Produced by the runtime: every index use (`onIndexUse` in the DO) bumps a
 * per-`(table, index)` counter in the durable `__cirrus_metrics_index` table, the
 * complement of the full-*scan* attribution in `__cirrus_metrics_scans`. The
 * `getMetrics` admin RPC surfaces it per shard; the studio sums the arrays across
 * shards and passes them as `context.indexHits`. A declared index that appears
 * with `reads: 0` (or is absent entirely after the schema reconciliation) is dead
 * for the window.
 */
export interface AdvisorIndexHit {
    /** The declared index name. */
    index: string;
    /** Recorded reads that used this index to narrow over the observed window. */
    reads: number;
    /** The table the index is declared on. */
    table: string;
}
