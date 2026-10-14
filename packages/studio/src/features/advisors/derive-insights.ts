import type { FunctionCallStat, ShardMetrics } from "../../lib/admin";

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
type InsightKind =
    "high-error-rate" | "high-evictions" | "high-write-contention" | "low-cache-hit-rate" | "missing-index" | "slow-function" | "storage-headroom";

/**
 * One detected issue. `value` is the headline number whose meaning depends on
 * `kind`: a 0–1 rate for cache-hit / error-rate, a millisecond figure for
 * slow-function / missing-index, an entry count for evictions. `fn` is set only
 * for per-function insights; `message` carries the last error for
 * high-error-rate; `tables` carries the full-scanned tables (busiest first) for
 * the causal `missing-index` kind. For `high-write-contention` it is the OCC
 * conflict ratio (conflicts / calls). For `storage-headroom` it is the shard's
 * SQLite size in bytes.
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
    /** Flag functions whose OCC write-conflict ratio is at or above this (0–1). */
    highWriteContention: number;
    /** Flag a cache whose hit rate is below this (0–1). */
    lowCacheHitRate: number;
    /** Require this many cache samples (hits + misses) before judging hit rate, to avoid cold-start noise. */
    minCacheSamples: number;
    /** Require this many calls before judging a function's conflict ratio. */
    minConflictCalls: number;
    /** Require this many calls before judging a function's error ratio. */
    minErrorCalls: number;
    /** Flag functions whose slowest call is at or above this many milliseconds. */
    slowFunctionMs: number;
    /** Escalate the storage insight to `error` at or above this many bytes. */
    storageCriticalBytes: number;
    /** Flag a shard whose SQLite is at or above this many bytes. */
    storageWarnBytes: number;
}

const DEFAULT_INSIGHT_THRESHOLDS: InsightThresholds = {
    highErrorRate: 0.05,
    highWriteContention: 0.1,
    lowCacheHitRate: 0.5,
    minCacheSamples: 10,
    minConflictCalls: 5,
    minErrorCalls: 5,
    slowFunctionMs: 1000,
    // Half the 10 GiB per-DO ceiling. Past this the escape hatch is itself
    // expensive — re-homing the rows needs a write window whose length scales
    // with the data — so it stops being a thing to plan and starts being a
    // thing to schedule.
    storageCriticalBytes: 5_368_709_120,
    // 1 GiB, 10% of the per-DO ceiling — the same point `@lunora/do` emits its
    // one-shot `console.warn` at, so the studio and the runtime agree on when
    // headroom becomes a topic. Deliberately a studio-side knob rather than an
    // import: the studio does not (and should not) depend on `@lunora/do`.
    storageWarnBytes: 1_073_741_824,
};

/** error first, then warning, then info — so the worst issues sort to the top. */
const SEVERITY_ORDER: Record<InsightSeverity, number> = { error: 0, info: 2, warning: 1 };

/**
 * Per-function heuristics for one `getFunctionStats` row, factored out of
 * {@link deriveInsights} so the cache + function passes each stay simple.
 *
 * Emits up to three insights: a latency one (`missing-index` when a full-table
 * scan explains the slowness — the causal upgrade, naming the scanned tables —
 * otherwise the bare `slow-function`), a `high-error-rate` one when the function
 * fails over a meaningful call count, and a `high-write-contention` one when OCC
 * write conflicts (a subset of errors) make up a meaningful share of calls — the
 * signal that the function is a sharding candidate.
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

    const conflicts = stat.conflicts ?? 0;

    if (conflicts > 0 && stat.calls >= thresholds.minConflictCalls && conflicts / stat.calls >= thresholds.highWriteContention) {
        insights.push({
            fn: stat.path,
            kind: "high-write-contention",
            severity: "warning",
            value: conflicts / stat.calls,
        });
    }

    return insights;
};

/**
 * Derive a prioritised list of issues from the two snapshots the studio
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
 * blame); high-error-rate (a function failing over a meaningful count);
 * high-write-contention (a function whose OCC write conflicts make up a
 * meaningful share of calls — a sharding candidate); storage-headroom (a shard
 * whose SQLite is closing on the 10 GiB per-DO ceiling).
 *
 * A slow function with full-scan attribution emits `missing-index` (causal, with
 * `tables`) instead of the bare `slow-function`, so the panel can link straight
 * to the fix rather than restating the symptom.
 *
 * `storage-headroom` exists because the runtime's own signal is a one-shot
 * `console.warn` inside the Durable Object — it fires once per DO instance, into
 * a log nobody is tailing at 3am months before the wall. The size is already on
 * the `getMetrics` snapshot the studio pulls, so surfacing it as a finding costs
 * one comparison and puts the warning where someone will actually meet it.
 */
const deriveInsights = (
    metrics: ShardMetrics | null,
    functions: FunctionCallStat[] | null,
    thresholds: InsightThresholds = DEFAULT_INSIGHT_THRESHOLDS,
): Insight[] => {
    const insights: Insight[] = [];

    // `databaseSize` is null on a runtime that does not expose one (workerd
    // blocks the SQLite size pragmas, so the DO reports it directly); absent is
    // "unknown", never "empty", so it must not read as headroom.
    if (typeof metrics?.databaseSize === "number" && metrics.databaseSize >= thresholds.storageWarnBytes) {
        insights.push({
            kind: "storage-headroom",
            severity: metrics.databaseSize >= thresholds.storageCriticalBytes ? "error" : "warning",
            value: metrics.databaseSize,
        });
    }

    // TODO(stranded-rows): a sibling `stranded-rows` insight — a table the schema
    // declares `.shardBy()` that still holds rows in `__root__`. Those are the
    // pre-migration copies the app can no longer read (admin ops are addressed to
    // a SHARD, not routed by the schema, which is why the Studio's Data page can
    // still clear them), and they keep counting against the 10 GiB ceiling.
    //
    // NOT built yet, deliberately: `lunora deploy`'s schema-drift gate already
    // classifies a shard-mode change as `breaking` and blocks the deploy
    // (`shared/schema-snapshot.ts`, `changedShardMode`), so rows cannot be
    // stranded without someone passing `--allow-schema-drift` on purpose. That is
    // prevention, and it strictly beats detection-after-the-fact.
    //
    // BUILD IT WHEN either becomes true:
    //   - `--allow-schema-drift` turns habitual (CI pipelines pinning it, support
    //     threads recommending it) — the gate is then bypassed as a matter of
    //     routine and stops being the guard this comment leans on; or
    //   - a second consumer needs per-table shard mode client-side, so the cost
    //     below is shared rather than paid for one advisory.
    //
    // COST, measured 2026-08-28: the studio cannot see `shardMode` today.
    // `listTables` (which this panel already calls per shard, and which returns
    // the `{ name, rowCount }` half of the answer) reads SQLite physically —
    // `listTables(sql)` in `@lunora/do`'s admin path, no schema in scope. Only the
    // schema snapshot JSON carries shard mode, via schemaVersions → schemaVersion
    // → parse, which is two extra round-trips on every Advisors load. The cheaper
    // shape is an optional `shardMode` on `TableInfo`, filled by the codegen ShardDO
    // subclass (which does hold the schema) and left absent by the base class, so
    // an older worker degrades to "no finding" rather than a wrong one.

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
