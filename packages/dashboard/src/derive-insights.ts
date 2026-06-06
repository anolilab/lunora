import type { FunctionCallStat, ShardMetrics } from "./admin.js";

/** Visual + ordering weight of a detected issue. */
type InsightSeverity = "error" | "info" | "warning";

/**
 * Which heuristic fired. The panel maps each kind to a localized title/detail,
 * so the detection stays free of presentation strings (and trivially testable).
 */
type InsightKind = "high-error-rate" | "high-evictions" | "low-cache-hit-rate" | "slow-function";

/**
 * One detected issue. `value` is the headline number whose meaning depends on
 * `kind`: a 0–1 rate for cache-hit / error-rate, a millisecond figure for
 * slow-function, an entry count for evictions. `fn` is set only for
 * per-function insights; `message` carries the last error for high-error-rate.
 */
interface Insight {
    fn?: string;
    kind: InsightKind;
    message?: string;
    severity: InsightSeverity;
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
 * Derive a prioritised list of issues from the two snapshots the dashboard
 * already pulls — the `getMetrics` health snapshot and the `getFunctionStats`
 * per-function table. Pure and side-effect-free: same inputs, same output, so
 * the heuristics can be unit-tested without rendering.
 *
 * Heuristics: low-cache-hit-rate (cache below the threshold once enough samples
 * exist — a cold cache isn't a problem); high-evictions (more evictions than
 * hits, so the cache is too small or churning on invalidation); slow-function (a
 * function whose slowest call crosses the threshold — likely a full scan or
 * missing index); high-error-rate (a function failing over a meaningful count).
 */
const deriveInsights = (metrics: ShardMetrics | null, functions: FunctionCallStat[] | null, thresholds: InsightThresholds = DEFAULT_INSIGHT_THRESHOLDS): Insight[] => {
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
        if (stat.maxDurationMs >= thresholds.slowFunctionMs) {
            insights.push({ fn: stat.path, kind: "slow-function", severity: "info", value: stat.maxDurationMs });
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
    }

    return insights.toSorted((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
};

export type { Insight, InsightKind, InsightSeverity, InsightThresholds };
export { DEFAULT_INSIGHT_THRESHOLDS, deriveInsights };
