/**
 * Pure geometry + filtering for the Traces waterfall, kept out of the panel so
 * both are unit-testable in isolation (the same split as `metrics-aggregate.ts`
 * and `slo-aggregate.ts`).
 *
 * The server already flattens each trace — every `TraceSpan` carries a precomputed
 * `depth` and an `offsetMs` relative to the trace start — so there is no tree math
 * here. All that remains is turning `(offsetMs, durationMs)` into a percentage
 * pair the bar can be positioned and sized with, and narrowing the trace list by
 * a search term.
 */

import type { TraceSpan, TraceSummary } from "../../lib/admin";

/**
 * Smallest bar width, in percent, the waterfall will render. A span that
 * completed in under a wall-clock millisecond (or any span of a zero-duration
 * trace) would otherwise compute to `0%` and vanish, reading as "this span is
 * missing" rather than "this span was instant".
 */
const MIN_BAR_PERCENT = 0.5;

/** Gridlines drawn across a waterfall, excluding the 0% edge (the track's own border reads as that). */
const TICK_COUNT = 4;

/** Clamp `value` into the inclusive `[0, 100]` percentage range. */
const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** A span bar's horizontal placement, as percentages of the trace's total width. */
export interface SpanBar {
    /** Distance from the left edge of the waterfall, in percent. */
    readonly leftPercent: number;
    /** Width of the bar, in percent. Never below {@link MIN_BAR_PERCENT}. */
    readonly widthPercent: number;
}

/**
 * Position and size one span's bar within its trace.
 *
 * `traceDurationMs` is the denominator, and it is legitimately `0` — a trace
 * whose whole dispatch settled inside one wall-clock millisecond (routine on a
 * Durable Object, whose clock only advances on I/O) folds to a zero duration.
 * Dividing by it would yield `NaN%`, which renders as no bar at all, so a
 * non-positive duration instead lays every span out full-width: the waterfall
 * degrades to "these spans all ran, too fast to order" rather than to nothing.
 *
 * The width is also clipped to what remains to the right of `leftPercent`, so a
 * span whose end is past the trace end (possible on a partial trace, where the
 * anchor is a survivor rather than the true root) cannot overflow its track.
 * @param span The span to place, carrying the server-computed `offsetMs`.
 * @param traceDurationMs The enclosing trace's total duration, in ms.
 */
export const spanBar = (span: TraceSpan, traceDurationMs: number): SpanBar => {
    if (!Number.isFinite(traceDurationMs) || traceDurationMs <= 0) {
        return { leftPercent: 0, widthPercent: 100 };
    }

    const leftPercent = clampPercent((span.offsetMs / traceDurationMs) * 100);
    const rawWidth = (span.durationMs / traceDurationMs) * 100;
    const widthPercent = Math.max(MIN_BAR_PERCENT, Math.min(clampPercent(rawWidth), 100 - leftPercent));

    return { leftPercent, widthPercent };
};

/**
 * Narrow the trace list by a case-insensitive substring over the trace's root
 * span name, function path, full trace id, and every span's name and id — so
 * pasting a span id from an error report or a `traceparent` header finds the
 * trace that contains it, not just the trace it happens to be named after. An
 * empty or whitespace-only term matches everything, so an untouched control never
 * hides a trace.
 * @param traces The loaded traces, newest first.
 * @param search The raw search-box value.
 * @param onlyErrors Keep only traces where the root or a descendant span threw.
 */
export const filterTraces = (traces: ReadonlyArray<TraceSummary>, search: string, onlyErrors = false): TraceSummary[] => {
    const needle = search.trim().toLowerCase();
    const byStatus = onlyErrors ? traces.filter((trace) => !trace.ok) : traces;

    if (needle === "") {
        return [...byStatus];
    }

    return byStatus.filter(
        (trace) =>
            trace.rootName.toLowerCase().includes(needle) ||
            trace.functionPath.toLowerCase().includes(needle) ||
            trace.traceId.toLowerCase().includes(needle) ||
            trace.spans.some((span) => span.name.toLowerCase().includes(needle) || span.spanId.toLowerCase().includes(needle)),
    );
};

/** One labelled gridline of the waterfall's time ruler. */
export interface TraceTick {
    /** Elapsed time at this gridline, pre-formatted. */
    readonly label: string;
    /** Distance from the left edge of the timeline track, in percent. */
    readonly percent: number;
}

/**
 * Render a millisecond duration for a waterfall row. Sub-millisecond spans are
 * shown to two decimals so an instant span reads as `0.4ms` rather than
 * collapsing to a bare `0ms`; anything longer rounds to a whole millisecond.
 * @param durationMs The duration to format.
 */
export const formatSpanDuration = (durationMs: number): string => {
    if (!Number.isFinite(durationMs)) {
        return "—";
    }

    return durationMs > 0 && durationMs < 1 ? `${durationMs.toFixed(2)}ms` : `${String(Math.round(durationMs))}ms`;
};

/**
 * Evenly-spaced elapsed-time gridlines for a trace's timeline.
 *
 * A waterfall without a ruler shows the *shape* of a request but not where in it
 * a span sits — you can see one bar starts later than another and have to guess
 * by how much. Even spacing rather than "nice" round intervals keeps this to
 * arithmetic: the labels are derived from the duration, so they land on whatever
 * values the trace actually has.
 *
 * A non-positive or non-finite duration yields no ticks, matching {@link spanBar},
 * which lays every span out full-width in that case — there is no timeline to
 * annotate.
 * @param traceDurationMs The enclosing trace's total duration, in ms.
 */
export const traceTicks = (traceDurationMs: number): TraceTick[] => {
    if (!Number.isFinite(traceDurationMs) || traceDurationMs <= 0) {
        return [];
    }

    return Array.from({ length: TICK_COUNT }, (_unused, index) => {
        const fraction = (index + 1) / TICK_COUNT;

        return { label: formatSpanDuration(traceDurationMs * fraction), percent: fraction * 100 };
    });
};
