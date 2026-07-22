/**
 * Trace roll-up + waterfall layout over stored **observations** (spans) — the
 * Traces model the Langfuse teardown pointed to, on real span timing. Two pure
 * folds, unit-tested like the rest of `src/telemetry/*`, shared by the
 * `traces.list`/`get` queries and the dashboard `TracesSection`:
 *
 * - {@link foldObservationTraces} groups a script's recent spans by `traceId`
 *   into one row per trace (real duration, span/error counts, root operation).
 * - {@link buildTraceTree} lays a single trace's spans out as a nested waterfall:
 *   each span placed by its real `startedAt`/`durationMs` and indented by its
 *   depth under `parentSpanId` — a true span waterfall, not a log-gap timeline.
 */

/** One eval score on a generation span (`gen_ai.evaluation.<name>.score`/`.label`), shown in the detail pane. */
export interface SpanEvaluation {
    label?: string;
    name: string;
    score: number;
}

/** One stored span, as both folds read it (a subset of the `observations` row). */
export interface ObservationSpan {
    /** Selected string span attributes (shown in the detail pane). */
    attributes?: Record<string, string>;
    /** Generation spans: completion token count. */
    completionTokens?: number;
    durationMs: number;
    endedAt: number;
    /** Generation spans: eval scores decoded from `gen_ai.evaluation.*`. */
    evaluations?: SpanEvaluation[];
    functionPath?: string;
    /** Generation spans: the recorded prompt (opt-in on the emitter), truncated. */
    input?: string;
    /** Which instrumentation emitted the span; `generation` = an AI model call. */
    kind?: "container" | "generation" | "worker";
    level: "error" | "info";
    /** Generation spans: the model id. */
    model?: string;
    name: string;
    /** Generation spans: the recorded completion (opt-in on the emitter), truncated. */
    output?: string;
    parentSpanId?: string;
    /** Generation spans: prompt token count. */
    promptTokens?: number;
    /** Generation spans: the conversation/thread id grouping turns into a session. */
    sessionId?: string;
    spanId: string;
    startedAt: number;
    statusMessage?: string;
    traceId: string;
}

/** One trace, folded from its spans for the list. */
export interface TraceRollup {
    /** Wall-clock duration of the whole trace (last span end − first span start), ms. */
    durationMs: number;
    endedAt: number;
    /** Spans in the trace whose status was error. */
    errorCount: number;
    /** The `<file>:<function>` of the root span, when attributed. */
    rootFunctionPath?: string;
    /** The root (earliest) span's name — what the trace is "of". */
    rootName: string;
    spanCount: number;
    startedAt: number;
    traceId: string;
}

/** One waterfall row: a span placed on the trace timeline, at its tree depth. */
export interface WaterfallSpan extends ObservationSpan {
    /** Nesting depth under `parentSpanId` (0 = root) — the indent. */
    depth: number;
    /** Bar width as a percent of the trace span (the real `durationMs`). */
    durationPct: number;
    /** Start offset from the trace start, ms. */
    offsetMs: number;
    /** Bar left edge as a percent of the trace span. */
    startPct: number;
}

/** Internal fold accumulator, carrying the root span's start so `rootName` follows the earliest span. */
interface RollupAccumulator extends TraceRollup {
    rootAt: number;
}

/**
 * Fold spans into per-trace {@link TraceRollup}s, newest-active first (by
 * `endedAt` desc), capped at `limit`. Order-agnostic — start/end track min/max
 * and the root operation follows the earliest span.
 */
export const foldObservationTraces = (spans: ReadonlyArray<ObservationSpan>, limit: number): TraceRollup[] => {
    const byTrace = new Map<string, RollupAccumulator>();

    for (const span of spans) {
        const existing = byTrace.get(span.traceId);

        if (existing === undefined) {
            byTrace.set(span.traceId, {
                durationMs: span.durationMs,
                endedAt: span.endedAt,
                errorCount: span.level === "error" ? 1 : 0,
                rootAt: span.startedAt,
                rootFunctionPath: span.functionPath,
                rootName: span.name,
                spanCount: 1,
                startedAt: span.startedAt,
                traceId: span.traceId,
            });

            continue;
        }

        existing.startedAt = Math.min(existing.startedAt, span.startedAt);
        existing.endedAt = Math.max(existing.endedAt, span.endedAt);
        existing.durationMs = existing.endedAt - existing.startedAt;
        existing.spanCount += 1;
        existing.errorCount += span.level === "error" ? 1 : 0;

        if (span.startedAt < existing.rootAt) {
            existing.rootAt = span.startedAt;
            existing.rootName = span.name;
            existing.rootFunctionPath = span.functionPath;
        }
    }

    return [...byTrace.values()]
        .toSorted((a, b) => b.endedAt - a.endedAt)
        .slice(0, Math.max(limit, 0))
        .map(({ rootAt: _rootAt, ...rollup }) => rollup);
};

/**
 * Lay a single trace's spans out as a nested waterfall. Children are ordered
 * under their parent by start time and indented one level deeper; a span whose
 * parent isn't in the set (or has none) is a root. Each row carries its
 * offset/width as a percent of the trace span, from the span's REAL
 * `startedAt`/`durationMs`. Cycle-safe (a span already placed is never revisited).
 */
export const buildTraceTree = (spans: ReadonlyArray<ObservationSpan>): WaterfallSpan[] => {
    if (spans.length === 0) {
        return [];
    }

    const start = Math.min(...spans.map((span) => span.startedAt));
    const end = Math.max(...spans.map((span) => span.endedAt));
    const spanMs = Math.max(end - start, 1);

    const byId = new Map(spans.map((span) => [span.spanId, span]));
    const childrenOf = new Map<string, ObservationSpan[]>();
    const roots: ObservationSpan[] = [];

    for (const span of spans) {
        const parent = span.parentSpanId;

        if (parent !== undefined && byId.has(parent)) {
            const siblings = childrenOf.get(parent);

            if (siblings) {
                siblings.push(span);
            } else {
                childrenOf.set(parent, [span]);
            }
        } else {
            roots.push(span);
        }
    }

    const rows: WaterfallSpan[] = [];
    const placed = new Set<string>();

    const walk = (span: ObservationSpan, depth: number): void => {
        if (placed.has(span.spanId)) {
            return;
        }

        placed.add(span.spanId);

        const offsetMs = Math.max(span.startedAt - start, 0);

        rows.push({
            ...span,
            depth,
            durationPct: Math.min((span.durationMs / spanMs) * 100, 100 - (offsetMs / spanMs) * 100),
            offsetMs,
            startPct: (offsetMs / spanMs) * 100,
        });

        for (const child of (childrenOf.get(span.spanId) ?? []).toSorted((a, b) => a.startedAt - b.startedAt)) {
            walk(child, depth + 1);
        }
    };

    for (const root of roots.toSorted((a, b) => a.startedAt - b.startedAt)) {
        walk(root, 0);
    }

    return rows;
};
