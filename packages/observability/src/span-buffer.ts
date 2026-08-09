/**
 * In-memory span capture backing the studio's Traces panel, plus the pure fold
 * that turns a flat span list into renderable waterfalls.
 *
 * Same contract and the same caveats as {@link file://./log-buffer.ts}: a field
 * on the live Durable Object instance, so it resets on hibernation or restart.
 * It is a "recent traces on this instance" readout for local development, NOT a
 * durable trace store — production tracing is `otlpSink`'s job, shipping spans to
 * a real collector that can retain and index them across instances.
 */
import type { LogFields } from "../../../shared/log-fields";
import type { SpanEvent, SpanEventPoint, SpanKind } from "../../../shared/span-event";

/* eslint-disable import/exports-last -- a data + types module: the public TraceSpan/TraceSummary shapes are declared next to the ring buffer and fold that produce them; grouping all exports at the end would scatter the contract. */

const DEFAULT_CAPACITY = 500;

/**
 * One span in a folded trace, flattened for rendering: `depth` is its nesting
 * level under the root and `offsetMs` its start relative to the trace start, so
 * a waterfall row is a pure function of the record (indent by `depth`, bar from
 * `offsetMs` to `offsetMs + durationMs`) with no client-side tree math.
 */
export interface TraceSpan {
    attributes?: LogFields;
    /** Nesting level; the root span is 0. */
    depth: number;
    durationMs: number;
    error?: {
        message: string;
        type: string;
    };

    /**
     * Timestamped occurrences inside the span — `span.addEvent(...)` and
     * `span.recordException(...)`. Carried through so a handled retry or a
     * swallowed exception is visible on the span it happened in, which is the
     * only place it is interpretable. Absent when the body recorded none.
     */
    events?: SpanEventPoint[];
    /** OTel `SpanKind`; absent means `"internal"`. */
    kind?: SpanKind;
    name: string;
    /** Start of this span relative to the trace's start, in ms. */
    offsetMs: number;
    ok: boolean;
    parentSpanId: string;
    spanId: string;
}

/** One folded trace: the dispatch plus every span recorded beneath it. */
export interface TraceSummary {
    /** Wall-clock span of the whole trace (root start → last span end). */
    durationMs: number;
    functionPath: string;
    /** False when the root or any descendant span errored. */
    ok: boolean;
    /** Display name of the trace — the root span's name. */
    rootName: string;
    shardKey?: string;

    /**
     * Spans ordered by `(offsetMs, depth)`, ready to render as waterfall rows.
     * Start time alone is not enough to order them: spans are recorded on
     * completion and `startTs` has millisecond resolution, so a parent and its
     * child routinely tie. Breaking that tie by depth makes the sequence a valid
     * pre-order traversal of the span tree, so indenting each row by its `depth`
     * yields the nesting without a separate tree walk.
     */
    spans: TraceSpan[];
    startTs: number;
    traceId: string;
}

/**
 * A bounded, in-memory ring of recent {@link SpanEvent}s (oldest evicted first),
 * mirroring `LogBuffer`. Spans arrive in *completion* order — a parent settles
 * after its children — so ordering is imposed by {@link foldTraces} at read
 * time rather than assumed here.
 */
export class SpanBuffer {
    private readonly buffer: SpanEvent[] = [];

    private readonly capacity: number;

    public constructor(capacity: number = DEFAULT_CAPACITY) {
        this.capacity = capacity > 0 ? Math.trunc(capacity) : DEFAULT_CAPACITY;
    }

    /** Number of spans currently buffered. */
    public get size(): number {
        return this.buffer.length;
    }

    /** Drop every buffered span. */
    public clear(): void {
        this.buffer.length = 0;
    }

    /** Snapshot of the buffered spans in insertion order. Fresh array per call. */
    public entries(): SpanEvent[] {
        return [...this.buffer];
    }

    /**
     * Whether any buffered span belongs to `traceId`. A membership test rather
     * than `entries().some(...)` so the per-dispatch check that decides whether
     * to record a root span doesn't copy the whole ring on every request.
     */
    public hasTrace(traceId: string): boolean {
        return this.buffer.some((span) => span.traceId === traceId);
    }

    /** Append a span, evicting the oldest when at capacity. */
    public push(span: SpanEvent): void {
        this.buffer.push(span);

        if (this.buffer.length > this.capacity) {
            this.buffer.shift();
        }
    }
}

/** Default number of traces {@link foldTraces} returns, newest first. */
export const DEFAULT_TRACE_LIMIT = 50;

/** Bucket spans by their trace id, preserving arrival order within each group. */
const groupByTrace = (spans: ReadonlyArray<SpanEvent>): Map<string, SpanEvent[]> => {
    const byTrace = new Map<string, SpanEvent[]>();

    for (const span of spans) {
        const group = byTrace.get(span.traceId);

        if (group === undefined) {
            byTrace.set(span.traceId, [span]);
        } else {
            group.push(span);
        }
    }

    return byTrace;
};

/**
 * Pick the span a trace hangs off, in three explicitly-ordered cases:
 *
 * 1. The synthetic dispatch span, when it is present.
 * 2. Otherwise the earliest span whose parent is **absent** from the group — its parent was evicted from the ring or hasn't settled yet, which makes it the outermost span actually present. Both are routine for a bounded ring, not corruption.
 * 3. Otherwise the earliest span. Reachable only when *every* span's parent is present, which requires a parent cycle — impossible from the tracer, but a replayed or hand-built stream could carry one. `depthOf` breaks the cycle; this just guarantees an anchor exists.
 *
 * Structure decides this, not timing: spans are recorded on completion and
 * `startTs` has millisecond resolution, so a parent and its child routinely look
 * simultaneous.
 */
const selectAnchor = (group: ReadonlyArray<SpanEvent>, byId: ReadonlyMap<string, SpanEvent>): SpanEvent | undefined => {
    const declaredRoot = group.find((span) => span.dispatch === true);

    if (declaredRoot !== undefined) {
        return declaredRoot;
    }

    const byStart = group.toSorted((a, b) => a.startTs - b.startTs);

    return byStart.find((span) => !byId.has(span.parentSpanId)) ?? byStart[0];
};

/**
 * Build a memoized depth resolver for one trace: how many levels a span sits
 * below `anchor`.
 *
 * Memoized across the group rather than walked per span — a deep chain would
 * otherwise re-walk the same ancestors for every descendant, turning the fold
 * quadratic on exactly the traces that are already the largest.
 *
 * A missing or cyclic parent re-parents onto the anchor rather than looping or
 * dropping the span, so resolution always terminates and a partial trace still
 * renders every span it has.
 */
const depthResolver = (anchor: SpanEvent, byId: ReadonlyMap<string, SpanEvent>): ((span: SpanEvent) => number) => {
    const cache = new Map<string, number>([[anchor.spanId, 0]]);

    return (span: SpanEvent): number => {
        // Ancestors walked on the way up, innermost first, so each one can be
        // memoized on the way back down.
        const chain: SpanEvent[] = [];
        const seen = new Set<string>();
        // Never undefined: the walk `break`s before it would assign an absent
        // parent (see the `parent === undefined` guard below), so the loop is
        // driven entirely by its internal `break`s rather than a head condition.
        let current = span;
        let base = 0;

        for (;;) {
            const known = cache.get(current.spanId);

            if (known !== undefined) {
                base = known;
                break;
            }

            // Cycle: stop and treat the chain as hanging directly off the anchor.
            if (seen.has(current.spanId)) {
                break;
            }

            seen.add(current.spanId);
            chain.push(current);

            const parent: SpanEvent | undefined = byId.get(current.parentSpanId);

            // Parent absent from the group — re-parent onto the anchor.
            if (parent === undefined) {
                break;
            }

            current = parent;
        }

        // `base` is the depth of the node ABOVE the chain's top — the memoized
        // ancestor we stopped at, or the anchor (depth 0) when the walk ran out
        // of parents. So the outermost unresolved span sits one below it, and
        // each subsequent one another level down.
        for (const [index, entry] of chain.toReversed().entries()) {
            cache.set(entry.spanId, base + index + 1);
        }

        return cache.get(span.spanId) ?? base;
    };
};

/** {@link foldTraces} result: the folded waterfalls plus the total distinct traces available before the `limit`. */
export interface FoldedTraces {
    /**
     * Distinct traces present in the buffer — the denominator for a "showing N of
     * M" affordance. `traces.length` is `min(total, limit)`, so `total > traces.length`
     * means older traces are held in the ring but not returned.
     */
    total: number;
    /** The newest `limit` traces, folded into waterfalls. */
    traces: TraceSummary[];
}

/**
 * Group a flat span list into per-trace waterfalls, newest trace first, plus the
 * total number of distinct traces available (so a caller can report truncation).
 * @param spans Buffered spans, in arrival order.
 * @param limit Maximum number of traces to return, newest first.
 */
export const foldTraces = (spans: ReadonlyArray<SpanEvent>, limit: number = DEFAULT_TRACE_LIMIT): FoldedTraces => {
    const byTrace = groupByTrace(spans);

    // Newest-first and truncated to `limit` BEFORE folding, so a full ring only
    // pays the fold cost for the traces actually returned. This runs on every
    // write flush for a live Traces subscriber, so the discarded work is not
    // free.
    const selected = [...byTrace.entries()]
        .map(([traceId, group]) => {
            return { group, startTs: Math.min(...group.map((span) => span.startTs)), traceId };
        })
        .toSorted((a, b) => b.startTs - a.startTs)
        .slice(0, limit);

    const summaries: TraceSummary[] = [];

    for (const { group, traceId } of selected) {
        const byId = new Map(group.map((span) => [span.spanId, span]));
        const anchor = selectAnchor(group, byId);

        if (anchor === undefined) {
            continue;
        }

        const depthOf = depthResolver(anchor, byId);
        const { startTs } = anchor;
        const endTs = Math.max(...group.map((span) => span.startTs + span.durationMs));

        const rows: TraceSpan[] = group
            .map((span) => {
                return {
                    ...(span.attributes === undefined ? {} : { attributes: span.attributes }),
                    depth: depthOf(span),
                    durationMs: span.durationMs,
                    ...(span.error === undefined ? {} : { error: span.error }),
                    ...(span.events === undefined ? {} : { events: span.events }),
                    ...(span.kind === undefined ? {} : { kind: span.kind }),
                    name: span.name,
                    // Clamped at 0: a child whose parent was evicted can predate the
                    // anchor, and a negative offset would render as a bar off-canvas.
                    offsetMs: Math.max(0, span.startTs - startTs),
                    ok: span.ok,
                    parentSpanId: span.parentSpanId,
                    spanId: span.spanId,
                };
            })
            // Start-ordered, then shallowest-first. The depth tie-break is what
            // makes this a valid pre-order: spans are recorded on *completion*, so
            // a child is buffered before its parent, and at millisecond resolution
            // the two routinely share a `startTs` — without it a child would sort
            // above the parent it belongs under.
            .toSorted((a, b) => a.offsetMs - b.offsetMs || a.depth - b.depth);

        summaries.push({
            durationMs: endTs - startTs,
            functionPath: anchor.functionPath,
            ok: group.every((span) => span.ok),
            rootName: anchor.name,
            ...(anchor.shardKey === undefined ? {} : { shardKey: anchor.shardKey }),
            spans: rows,
            startTs,
            traceId,
        });
    }

    // Re-sorted on the anchor's start: `selected` ordered by each group's
    // earliest span, which is the anchor in the normal case but not when the
    // group is partial. `total` is the distinct-trace count BEFORE the `limit`
    // slice, so the panel can flag when older traces exist but weren't returned.
    return { total: byTrace.size, traces: summaries.toSorted((a, b) => b.startTs - a.startTs) };
};
