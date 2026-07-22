/**
 * Shared, bundler-inlined contract for one user-created span (`ctx.trace`).
 *
 * The same split as {@link file://./log-event.ts}: `@lunora/do` builds these
 * events (it owns the per-dispatch span stack) and hands them to a
 * `@lunora/runtime` `ObservabilitySink.onSpan`, while `@lunora/studio` renders
 * them as a waterfall — three packages with no acceptable runtime dependency
 * edge between them. Hosting the shape here (inlined into each `dist`) makes the
 * cross-package `onSpan` call structurally guaranteed rather than coincidentally
 * compatible. Keep genuinely zero-dependency so inlining stays sound.
 */
import type { LogFields } from "./log-fields";

/**
 * One span produced by a `ctx.trace(name, fn)` call, or the synthetic root span
 * the shard records for the dispatch itself so a waterfall has a bar to hang
 * its children under.
 *
 * Ids are the same lowercase-hex form the OTLP encoders and `traceparent` use
 * (32-hex trace, 16-hex span), so a `SpanEvent` composes into an OTLP span with
 * no reformatting.
 */
/**
 * Handle the enclosing `ctx.trace` span hands its body, so the body can attach
 * attributes only known *after* it resolves — an AI call's token usage or dollar
 * cost, a downstream response's status, a computed row count. The start
 * attributes passed to `ctx.trace(name, fn, attributes)` are snapshotted before
 * the body runs (so a mid-span mutation can't rewrite them); anything set through
 * this handle is merged over that snapshot at record time, with the post-hoc
 * value winning on a key clash.
 */
export interface SpanHandle {
    /** Set one attribute on the enclosing span (merged at record time; post-hoc wins on key clash). */
    setAttribute: (key: string, value: LogFields[string]) => void;
    /** Merge attributes onto the enclosing span (post-hoc wins on key clash). */
    setAttributes: (fields: LogFields) => void;
}

export interface SpanEvent {
    /**
     * Structured attributes the caller attached, already normalized to a fresh
     * bag of JSON-safe primitives (see `shared/log-fields.ts`) exactly like a log
     * line's `fields`. Absent when the caller passed none.
     */
    attributes?: LogFields;
    /** Wall-clock duration of the span body, in milliseconds. */
    durationMs: number;
    /**
     * Populated when the span body threw. `type` is the error's constructor name
     * (or its `LunoraError` code); `message` is the human-readable string and may
     * include user input, so sinks shipping to third parties should scrub it.
     */
    error?: {
        message: string;
        type: string;
    };
    /**
     * Function path the span was created under, e.g. `"messages:list"`. A span
     * created inside a function invoked via `ctx.runQuery`/`runMutation`/
     * `runAction` carries the OUTER entrypoint's path, since the composed call
     * reuses its context — the same attribution rule `ctx.log` follows.
     */
    functionPath: string;
    /** Caller-supplied span name, e.g. `"stripe.charge"`. */
    name: string;
    /** True when the span body returned without throwing. */
    ok: boolean;
    /**
     * Span id of the enclosing span — the parent `ctx.trace` when nested, else
     * the dispatch's own RPC span (from the inbound `traceparent`). A span with
     * no inbound trace context is parented to a locally-minted root, so this is
     * always set for a `ctx.trace` span; only the synthetic `dispatch` span below
     * carries `""`, meaning "nothing above me in this trace".
     */
    parentSpanId: string;
    /**
     * True for the synthetic span representing the **dispatch itself**, which the
     * shard records so a waterfall has a bar for the request to hang its
     * `ctx.trace` spans under.
     *
     * Named for what it is rather than "root": it is not the root of the
     * collector-side trace — the worker's own RPC span sits above it — and it is
     * never exported to a sink, because the runtime already emits that dispatch
     * via `onRpc` and a collector would otherwise show it twice. Locally it *is*
     * the outermost span, which is why the fold prefers it as a trace's anchor.
     */
    dispatch?: boolean;
    /** Shard key for single-shard calls; absent for the unnamed root DO. */
    shardKey?: string;
    /** This span's own id (16-hex). */
    spanId: string;
    /** Wall-clock millis when the span started. */
    startTs: number;
    /** Trace this span belongs to (32-hex) — shared with the dispatch's logs. */
    traceId: string;
    /** Acting userId, or absent when anonymous. */
    userId?: string;
}
