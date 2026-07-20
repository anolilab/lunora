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
import type { SpanEvent } from "../../../shared/span-event";

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

/**
 * Group a flat span list into per-trace waterfalls, newest trace first.
 *
 * Pure and total — every input yields a renderable result, because the buffer is
 * a bounded ring and so is *routinely* partial: eviction can drop a parent while
 * keeping its children, and a trace can be read mid-dispatch, before its root
 * span has been recorded at all. Both cases are normal, not corruption. A span
 * whose parent is missing from the group is therefore re-parented to the trace's
 * shallowest span rather than dropped, so a partial trace still renders every
 * span it does have.
 *
 * Cycles (which a correct tracer cannot produce, but a hand-built or replayed
 * event stream could) are bounded by tracking the ancestors already walked, so
 * depth resolution always terminates.
 * @param spans Buffered spans, in arrival order.
 * @param limit Maximum number of traces to return, newest first.
 */
export const foldTraces = (spans: readonly SpanEvent[], limit = 50): TraceSummary[] => {
    const byTrace = new Map<string, SpanEvent[]>();

    for (const span of spans) {
        const group = byTrace.get(span.traceId);

        if (group === undefined) {
            byTrace.set(span.traceId, [span]);
        } else {
            group.push(span);
        }
    }

    const summaries: TraceSummary[] = [];

    for (const [traceId, group] of byTrace) {
        const byId = new Map(group.map((span) => [span.spanId, span]));
        const byStart = [...group].sort((a, b) => a.startTs - b.startTs);
        // The trace's anchor, in preference order: the declared root span; else
        // the earliest span whose parent isn't in this group — i.e. one whose
        // parent was evicted or hasn't settled yet, which makes it the outermost
        // span actually present. Structure rather than timing decides this: spans
        // are recorded on completion and `startTs` has millisecond resolution, so
        // a parent and its child routinely look simultaneous.
        const anchor = group.find((span) => span.root === true) ?? byStart.find((span) => !byId.has(span.parentSpanId)) ?? byStart[0];

        if (anchor === undefined) {
            continue;
        }

        const depthOf = (span: SpanEvent): number => {
            const seen = new Set<string>([span.spanId]);
            let depth = 0;
            let current = span;

            while (current.spanId !== anchor.spanId) {
                const parent = byId.get(current.parentSpanId);

                // Missing or cyclic parent — re-parent onto the anchor rather
                // than looping or dropping the span.
                if (parent === undefined || seen.has(parent.spanId)) {
                    return depth + 1;
                }

                seen.add(parent.spanId);
                current = parent;
                depth += 1;
            }

            return depth;
        };

        const startTs = anchor.startTs;
        const endTs = Math.max(...group.map((span) => span.startTs + span.durationMs));

        const rows: TraceSpan[] = group
            .map((span) => {
                return {
                    ...(span.attributes === undefined ? {} : { attributes: span.attributes }),
                    depth: depthOf(span),
                    durationMs: span.durationMs,
                    ...(span.error === undefined ? {} : { error: span.error }),
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
            .sort((a, b) => a.offsetMs - b.offsetMs || a.depth - b.depth);

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

    return summaries.sort((a, b) => b.startTs - a.startTs).slice(0, limit);
};
