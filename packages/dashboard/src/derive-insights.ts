import type { FunctionCallStat, ShardMetrics } from "./admin.js";

/** Visual + ordering weight of a detected issue. */
type InsightSeverity = "error" | "info" | "warning";

/**
 * Which heuristic fired. The panel maps each kind to a localized title/detail,
 * so the detection stays free of presentation strings (and trivially testable).
 *
 * `missing-index` is the causal upgrade of `slow-function`: a slow function
 * whose latency is explained by a full-table scan. When the scan attribution
 * pins the cause, the insight names the scanned table(s) (`tables`) and deep-
 * links to the Schema/Indexes tab to add the index, rather than leaving the
 * slowness an unattributed symptom.
 */
type InsightKind = "high-error-rate" | "high-evictions" | "low-cache-hit-rate" | "missing-index" | "slow-function";

/**
 * One detected issue. `value` is the headline number whose meaning depends on
 * `kind`: a 0–1 rate for cache-hit / error-rate, a millisecond figure for
 * slow-function / missing-index, an entry count for evictions. `fn` is set only
 * for per-function insights; `message` carries the last error for
 * high-error-rate; `tables` carries the full-scanned tables (busiest first) for
 * the causal `missing-index` kind.
 */
interface Insight {
    fn?: string;
    kind: InsightKind;
    message?: string;
    severity: InsightSeverity;
    tables?: string[];
    value: number;
}

/** Tunable cut-offs for {@link deriveInsights}. Exposed so a host (or a test) can tighten/loosen them. */
interface InsightThresholds {
    /** Flag functions whose error ratio is at or above this (0–1). */
    highErrorRate: number;
    /** Flag a cache whose hit rate is below this (0–1). */
    lowCacheHitRate: number;
    /** Require this many cache samples (hits + misses) before judging hit rate, to avoid cold-start noise. */
    minCacheSamples: number;
    /** Require this many calls before judging a function's error ratio. */
    minErrorCalls: number;
    /** Flag functions whose slowest call is at or above this many milliseconds. */
    slowFunctionMs: number;
}

const DEFAULT_INSIGHT_THRESHOLDS: InsightThresholds = {
    highErrorRate: 0.05,
    lowCacheHitRate: 0.5,
    minCacheSamples: 10,
    minErrorCalls: 5,
    slowFunctionMs: 1000,
};

/** error first, then warning, then info — so the worst issues sort to the top. */
const SEVERITY_ORDER: Record<InsightSeverity, number> = { error: 0, info: 2, warning: 1 };

/**
 * Per-function heuristics for one `getFunctionStats` row, factored out of
 * {@link deriveInsights} so the cache + function passes each stay simple.
 *
 * Emits up to two insights: a latency one (`missing-index` when a full-table
 * scan explains the slowness — the causal upgrade, naming the scanned tables —
 * otherwise the bare `slow-function`) and a `high-error-rate` one when the
 * function fails over a meaningful call count.
 */
const deriveFunctionInsights = (stat: FunctionCallStat, thresholds: InsightThresholds): Insight[] => {
    const insights: Insight[] = [];

    if (stat.maxDurationMs >= thresholds.slowFunctionMs) {
        const scannedTables = stat.scannedTables ?? [];

        if (scannedTables.length > 0) {
            insights.push({
                fn: stat.path,
                kind: "missing-index",
                severity: "warning",
                tables: scannedTables.map((attribution) => attribution.table),
                value: stat.maxDurationMs,
            });
        } else {
            insights.push({ fn: stat.path, kind: "slow-function", severity: "info", value: stat.maxDurationMs });
        }
    }

    if (stat.calls >= thresholds.minErrorCalls && stat.errors / stat.calls >= thresholds.highErrorRate) {
        insights.push({
            fn: stat.path,
            kind: "high-error-rate",
            message: stat.lastErrorMessage ?? undefined,
            severity: "error",
            value: stat.errors / stat.calls,
        });
    }

    return insights;
};

/**
 * Derive a prioritised list of issues from the two snapshots the dashboard
 * already pulls — the `getMetrics` health snapshot and the `getFunctionStats`
 * per-function table. Pure and side-effect-free: same inputs, same output, so
 * the heuristics can be unit-tested without rendering.
 *
 * Heuristics: low-cache-hit-rate (cache below the threshold once enough samples
 * exist — a cold cache isn't a problem); high-evictions (more evictions than
 * hits, so the cache is too small or churning on invalidation); missing-index (a
 * slow function whose latency is *explained* by a full-table scan — the causal
 * upgrade of slow-function, naming the scanned table(s)); slow-function (a
 * function whose slowest call crosses the threshold with no scan attribution to
 * blame); high-error-rate (a function failing over a meaningful count).
 *
 * A slow function with full-scan attribution emits `missing-index` (causal, with
 * `tables`) instead of the bare `slow-function`, so the panel can link straight
 * to the fix rather than restating the symptom.
 */
const deriveInsights = (
    metrics: ShardMetrics | null,
    functions: FunctionCallStat[] | null,
    thresholds: InsightThresholds = DEFAULT_INSIGHT_THRESHOLDS,
): Insight[] => {
    const insights: Insight[] = [];

    if (metrics?.cache) {
        const { evictions, hits, misses } = metrics.cache;
        const samples = hits + misses;

        if (samples >= thresholds.minCacheSamples) {
            const rate = hits / samples;

            if (rate < thresholds.lowCacheHitRate) {
                insights.push({ kind: "low-cache-hit-rate", severity: "warning", value: rate });
            }
        }

        if (evictions > 0 && evictions > hits) {
            insights.push({ kind: "high-evictions", severity: "warning", value: evictions });
        }
    }

    for (const stat of functions ?? []) {
        insights.push(...deriveFunctionInsights(stat, thresholds));
    }

    return insights.toSorted((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
};

export type { Insight, InsightKind, InsightSeverity, InsightThresholds };
export { DEFAULT_INSIGHT_THRESHOLDS, deriveInsights };
