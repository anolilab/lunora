/**
 * Trace folding for the dashboard **Traces** view.
 *
 * The cloud stores tenant runtime logs (`tenantLogs`), each carrying the
 * `traceId`/`spanId`/`functionPath`/`level` the framework stamped on it. It does
 * NOT store OpenTelemetry spans with durations (the OTLP ingest keeps only error
 * spans, folded into Issues — see `otlp.ts`), so a full span-duration waterfall
 * would need a separate span store. What the log data DOES support is a real
 * per-trace **timeline**: group a script's recent lines by `traceId` and each
 * group is one dispatch trace — its span of time, the function it entered at, how
 * many lines it emitted, and its peak severity.
 *
 * This module is the pure fold (no `_generated` import), so it unit-tests like
 * the rest of `src/telemetry/*`; the `logs.listTraces` query is a thin wrapper.
 */

/** The seven-tier `ctx.log` severity ramp, least→most severe — the framework's `LOG_LEVEL_ORDER`. */
const SEVERITY_ORDER = ["trace", "debug", "log", "info", "warn", "error", "fatal"] as const;

/** One `ctx.log` severity. */
export type TraceLogLevel = (typeof SEVERITY_ORDER)[number];

/** The subset of a `tenantLogs` row the fold reads. */
export interface TraceLogRow {
    createdAt: number;
    functionPath?: string;
    level: TraceLogLevel;
    traceId?: string;
}

/** One folded trace: every line sharing a `traceId`, summarized for the list. */
export interface TraceSummary {
    /** Wall-clock ms of the last folded line. */
    endedAt: number;
    /** The `&lt;file>:&lt;function>` the trace entered at (the earliest line's), when attributed. */
    functionPath?: string;
    /** `true` when any folded line was `error`/`fatal` — the trace saw a failure. */
    hasError: boolean;
    /** Number of log lines folded into this trace. */
    lineCount: number;
    /** The most severe level any folded line reached. */
    maxLevel: TraceLogLevel;
    /** Wall-clock ms of the first folded line. */
    startedAt: number;
    /** The trace id (from the inbound `traceparent`). */
    traceId: string;
}

/** Rank of a level in {@link SEVERITY_ORDER}; higher is more severe. */
const severityRank = (level: TraceLogLevel): number => SEVERITY_ORDER.indexOf(level);

/** Whether a level is a failure (`error`/`fatal`). */
const isFailure = (level: TraceLogLevel): boolean => level === "error" || level === "fatal";

/** Accumulator carrying the internal `rootAt` (min ts seen) that {@link TraceSummary} drops. */
interface TraceAccumulator extends TraceSummary {
    /** The `createdAt` of the earliest line seen so far — decides which line owns `functionPath`. */
    rootAt: number;
}

/**
 * Fold log rows into per-`traceId` {@link TraceSummary}s, newest-active first
 * (by `endedAt` desc), capped at `limit`. Lines with no `traceId` are skipped
 * (untraced console lines belong to the Logs view, not a trace). Order-agnostic:
 * `startedAt`/`endedAt` track min/max and `functionPath` follows the earliest
 * line, so a page in any order folds identically.
 */
export const foldTraces = (rows: ReadonlyArray<TraceLogRow>, limit: number): TraceSummary[] => {
    const byTrace = new Map<string, TraceAccumulator>();

    for (const row of rows) {
        if (row.traceId === undefined || row.traceId === "") {
            continue;
        }

        const existing = byTrace.get(row.traceId);

        if (existing === undefined) {
            byTrace.set(row.traceId, {
                endedAt: row.createdAt,
                functionPath: row.functionPath,
                hasError: isFailure(row.level),
                lineCount: 1,
                maxLevel: row.level,
                rootAt: row.createdAt,
                startedAt: row.createdAt,
                traceId: row.traceId,
            });

            continue;
        }

        existing.startedAt = Math.min(existing.startedAt, row.createdAt);
        existing.endedAt = Math.max(existing.endedAt, row.createdAt);
        existing.lineCount += 1;
        existing.hasError = existing.hasError || isFailure(row.level);

        if (severityRank(row.level) > severityRank(existing.maxLevel)) {
            existing.maxLevel = row.level;
        }

        // The earliest line owns the representative (root) function path.
        if (row.createdAt < existing.rootAt) {
            existing.rootAt = row.createdAt;
            existing.functionPath = row.functionPath;
        }
    }

    return [...byTrace.values()]
        .toSorted((a, b) => b.endedAt - a.endedAt)
        .slice(0, Math.max(limit, 0))
        .map(({ rootAt: _rootAt, ...summary }) => summary);
};
