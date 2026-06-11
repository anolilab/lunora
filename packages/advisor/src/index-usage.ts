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
 * `AdvisorIndexHit` is the per-declared-index hit count. The runtime does NOT yet
 * record this (see the note on `AdvisorIndexHit`); when a future feeder supplies
 * it the lint flags a declared index with zero recorded reads as dead. Absent,
 * the dead-index half is a no-op and only the hot-scan half of the lint runs off
 * the scan attribution that ships today.
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
 * **Gap:** the runtime does not currently record per-index usage. The metrics
 * pipeline records full-*scans* (reads that hit NO index, in
 * `__cirrus_metrics_scans`) but not which index a narrowing read *used*. So this
 * feed has no runtime producer yet — the lint reads it when present (e.g. a
 * future per-index counter, or a static "index never referenced by any
 * `.withIndex(...)` in the discovered reads" feeder), and the dead-index half is
 * inert until then.
 */
export interface AdvisorIndexHit {
    /** The declared index name. */
    index: string;
    /** Recorded reads that used this index to narrow over the observed window. */
    reads: number;
    /** The table the index is declared on. */
    table: string;
}
