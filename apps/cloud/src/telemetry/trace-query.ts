/**
 * Server-side trace-list filtering — a pure predicate over folded
 * {@link TraceRollup}s, unit-tested like the rest of `src/telemetry/*` and
 * applied by `traces.list` after the fold. Kept separate from the fold itself
 * (`trace-tree.ts`) so the filter matrix is testable without standing up a
 * query, and so the query stays a thin wrapper.
 */
import type { TraceRollup } from "./trace-tree";

/** The trace-list filter: every set field must hold for a trace to be kept. */
export interface TraceFilter {
    /** Keep only traces with at least one errored span. */
    errorOnly?: boolean;
    /** Case-insensitive substring over the root operation (function path / name). */
    functionPath?: string;
    /** Keep traces active at/after this epoch-ms (the trace ended no earlier). */
    from?: number;
    /** Keep traces whose total latency is at least this many ms (slow-trace filter). */
    minDurationMs?: number;
    /** Keep traces active at/before this epoch-ms (the trace started no later) — the "older than" page cursor. */
    to?: number;
}

/** True when `trace` satisfies every set field of `filter` (an unset field is a pass). */
export const matchesTraceFilter = (trace: TraceRollup, filter: TraceFilter): boolean => {
    if (filter.errorOnly === true && trace.errorCount === 0) {
        return false;
    }

    if (filter.minDurationMs !== undefined && trace.durationMs < filter.minDurationMs) {
        return false;
    }

    // Time-range overlap: a trace is in range when its active interval
    // [startedAt, endedAt] overlaps [from, to]. `to` doubles as the "load older"
    // cursor — page back by lowering it to the oldest trace already shown.
    if (filter.from !== undefined && trace.endedAt < filter.from) {
        return false;
    }

    if (filter.to !== undefined && trace.startedAt > filter.to) {
        return false;
    }

    if (filter.functionPath !== undefined && filter.functionPath !== "") {
        const needle = filter.functionPath.toLowerCase();
        const haystack = `${trace.rootFunctionPath ?? ""} ${trace.rootName}`.toLowerCase();

        if (!haystack.includes(needle)) {
            return false;
        }
    }

    return true;
};

/** Keep only the traces matching `filter`, preserving order. */
export const filterTraces = (traces: ReadonlyArray<TraceRollup>, filter: TraceFilter): TraceRollup[] =>
    traces.filter((trace) => matchesTraceFilter(trace, filter));
