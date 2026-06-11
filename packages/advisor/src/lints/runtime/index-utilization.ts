import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * A table must be full-scanned at least this many times over the observed window
 * before a missing-index advisory fires. A handful of scans on a tiny table is
 * harmless; the lint targets a table the app reads *hot* with no index, which
 * degrades linearly as the table grows. Deliberately above one so a single
 * incidental scan stays quiet.
 */
const HOT_SCAN_THRESHOLD = 25;

/**
 * `index_utilization` — flag indexes the workload doesn't pay for. Two
 * complementary checks over recorded reads.
 *
 * Dead index — a declared index that recorded reads never used. An unused index
 * is pure overhead: every write maintains it, every byte of storage holds it,
 * and nothing reads through it. Fired off the per-index hit feed
 * (`context.indexHits`); a declared index whose recorded `reads` is `0` is dead
 * for the window. Gap: the runtime does not yet record per-index usage — the
 * metrics pipeline records full-scans (reads that hit NO index) but not which
 * index a narrowing read used. So `indexHits` has no runtime producer today and
 * this half stays inert until a feeder supplies it (see `AdvisorIndexHit`). It's
 * wired now so the rule lands complete and lights up the moment the signal
 * exists.
 *
 * Hot unindexed scan — a table read hot with no index at all. Fired off the
 * full-scan attribution the runtime does record (`context.tableScans`, sourced
 * from `__cirrus_metrics_scans` / `FunctionCallStat.scannedTables`): a table
 * whose scan count clears `HOT_SCAN_THRESHOLD` is one the app keeps
 * full-scanning, the runtime-confirmed counterpart to the static
 * `filter_without_index` advisory.
 */
const indexUtilization: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "Recorded reads show an index the workload doesn't pay for: either a declared index no read ever used (dead overhead on every write) or a table read hot with no index at all (a repeated full scan that degrades as it grows).",
    facing: "INTERNAL",
    level: "INFO",
    name: "index_utilization",
    remediation:
        "Drop a dead index so writes stop maintaining it; add an index covering the hot full-scanned table's read predicate so the read stops scanning every row.",
    run: (context) => {
        const findings = [];

        // Dead-index half: a declared index with zero recorded reads. Inert until
        // a per-index hit feed exists, but complete when it does.
        for (const hit of context.indexHits ?? []) {
            if (hit.reads > 0) {
                continue;
            }

            findings.push(
                emit(indexUtilization, {
                    cacheKey: `index_utilization:dead_index:${hit.table}:${hit.index}`,
                    detail: `Index "${hit.index}" on table "${hit.table}" recorded no reads over the observed window — it's dead overhead: every write maintains it and nothing reads through it.`,
                    metadata: { index: hit.index, kind: "dead_index", reads: hit.reads, table: hit.table },
                }),
            );
        }

        // Hot-scan half: a table the app keeps full-scanning with no index. This
        // is the runtime-confirmed counterpart to `filter_without_index`, so it
        // faces EXTERNAL (a user-felt latency cliff) and warns.
        for (const scan of context.tableScans ?? []) {
            if (scan.scans < HOT_SCAN_THRESHOLD) {
                continue;
            }

            findings.push(
                emit(indexUtilization, {
                    cacheKey: `index_utilization:hot_scan:${scan.table}`,
                    detail: `Table "${scan.table}" was full-scanned ${scan.scans.toString()} times over the observed window with no index — a repeated full scan that degrades linearly as "${scan.table}" grows. Add an index covering the read predicate.`,
                    facing: "EXTERNAL",
                    level: "WARN",
                    metadata: { kind: "hot_scan", scans: scan.scans, table: scan.table },
                }),
            );
        }

        return findings;
    },
    source: "runtime",
    title: "Index utilization",
};

export default indexUtilization;
