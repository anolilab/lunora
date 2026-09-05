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
import type { EvaluationInput } from "./evaluation-attributes";
import type { LogFields } from "./log-fields";
import type { OtlpSpanKind } from "./otlp";

export type { OtlpSpanKind as SpanKind } from "./otlp";

/**
 * One timestamped occurrence inside a span — OTel's `Span.events`.
 *
 * The right shape for something that has a moment but no duration: a retry, a
 * cache miss, a validation failure, a thrown exception. Modelling those as
 * near-zero-width child spans clutters the waterfall, and modelling them as
 * separate log lines loses the "which span was I in" correlation that makes them
 * useful in the first place.
 */
export interface SpanEventPoint {
    /** Structured attributes, normalized like a span's own. */
    attributes?: LogFields;
    /** Event name, e.g. `"exception"` or `"cache.miss"`. */
    name: string;
    /** Wall-clock millis when it happened. */
    ts: number;
}

/**
 * A causal reference to a span in ANOTHER trace — OTel's `Span.links`.
 *
 * The standard answer to fan-in: a queue consumer processing a batch of 100
 * messages links to the 100 producing spans rather than parenting to one of them
 * (arbitrary) or all of them (impossible). The traces stay separately navigable
 * and the causal edge survives.
 */
export interface SpanLink {
    /** Attributes describing the relationship, e.g. `{ "link.kind": "enqueued_by" }`. */
    attributes?: LogFields;
    /** Linked span id (16-hex). */
    spanId: string;
    /** Linked trace id (32-hex). */
    traceId: string;
}

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
    /**
     * Record a timestamped {@link SpanEventPoint} on the enclosing span — a retry,
     * a cache miss, a state transition. Prefer this over an extra `ctx.log` line
     * for anything that only makes sense *relative to this span*: it rides the
     * span's own export, so it costs no additional log record and can never be
     * separated from its context.
     */
    addEvent: (name: string, attributes?: LogFields) => void;

    /**
     * Link this span to one in another trace (see {@link SpanLink}) — how a batch
     * consumer points back at the requests that enqueued its items without
     * collapsing every producer into one giant trace.
     */
    addLink: (link: SpanLink) => void;

    /**
     * Attach an AI **evaluation** verdict to this (generation) span as the
     * `gen_ai.evaluation.<name>.score` / `.label` OpenTelemetry attributes, so a
     * scorer's grade rides the same trace as the generation it graded and the
     * collector reads it straight off the span. Convenience over
     * {@link SpanHandle.setAttributes} that owns the key format; privacy-safe —
     * only the name, score, and optional label are emitted, never the graded
     * prompt or completion. Throws on an empty name or a non-finite score.
     */
    recordEvaluation: (evaluation: EvaluationInput) => void;

    /**
     * Record a caught exception as the OTel-conventional `exception` span event
     * (`exception.type` / `exception.message` / `exception.stacktrace`).
     *
     * Distinct from letting the error propagate: this is for an error you
     * **handled** — a retried request, a fallback that worked — which should be
     * visible in the trace without marking the span failed. An error that escapes
     * the span body is recorded automatically and *does* set the error status.
     */
    recordException: (error: unknown) => void;

    /** Set one attribute on the enclosing span (merged at record time; post-hoc wins on key clash). */
    setAttribute: (key: string, value: LogFields[string]) => void;
    /** Merge attributes onto the enclosing span (post-hoc wins on key clash). */
    setAttributes: (fields: LogFields) => void;

    /**
     * The W3C ids of the span this handle refers to.
     *
     * A handle that cannot say WHICH span it is forces every consumer that needs
     * the identity — a `traceparent` for a hand-rolled outbound call, a trace id
     * echoed in an error response so a user can quote it in a bug report, an
     * `@opentelemetry/api` bridge parenting a third-party library's spans — to
     * reach around the API for it.
     */
    spanContext: () => SpanContextIds;
}

/**
 * The W3C identity of one span, plus the trace's settled sampling verdict.
 *
 * `sampled` is the propagated head decision (absent means "no verdict reached
 * this tier", which every consumer reads as keep). It rides alongside the ids
 * because everything that needs the ids to announce this span downstream — a
 * hand-built `traceparent`, the `@opentelemetry/api` bridge's `SpanContext` —
 * needs the flag in the same breath, and announcing `sampled` on a trace that
 * was sampled OUT is what leaves a collector holding the middle of a trace.
 */
export interface SpanContextIds {
    /** The trace's settled W3C `sampled` verdict; absent when none was propagated. */
    sampled?: boolean;
    /** This span's id (16-hex). */
    spanId: string;
    /** The trace this span belongs to (32-hex). */
    traceId: string;
}

/**
 * Caller-supplied ids for one `ctx.trace` span, passed as the tracer's fourth
 * argument.
 *
 * For adapters that must hand a span's identity to somebody else BEFORE the span
 * body runs — the `@opentelemetry/api` bridge returns a `SpanContext`
 * synchronously from `startSpan`, and a library builds a `traceparent` from it —
 * so the id the adapter published is the id that reaches the collector rather
 * than a phantom. `parentSpanId` overrides the enclosing span for the same
 * reason: an adapter that tracks its own parent/child structure (OTel's
 * `Context`) can express it without an ambient span stack.
 *
 * Not part of the ordinary `ctx.trace(name, fn, attributes)` call — a handler
 * never mints its own ids.
 */
export interface SpanIdentity {
    /** Parent to this span id instead of the enclosing `ctx.trace` / dispatch span. */
    parentSpanId?: string;
    /** Record the span under this id (16-hex) instead of a freshly minted one. */
    spanId?: string;
}

/** Options accepted by `ctx.trace(name, fn, options)` beyond the plain attribute bag. */
export interface SpanOptions {
    /** Start attributes, snapshotted before the body runs. */
    attributes?: LogFields;

    /**
     * OTel `SpanKind`, default `"internal"`. Set `"client"` for a call OUT to
     * another service, `"producer"`/`"consumer"` for queue hops — this is what a
     * collector builds its service map from, so leaving everything `"internal"`
     * yields a trace with no topology.
     */
    kind?: OtlpSpanKind;

    /** Links to spans in other traces, known at start (see {@link SpanLink}). */
    links?: SpanLink[];
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
     * Timestamped occurrences inside the span (see {@link SpanEventPoint}) —
     * `ctx.trace`'s `span.addEvent(...)` / `span.recordException(...)`. Absent
     * when the body recorded none.
     */
    events?: SpanEventPoint[];
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
    /**
     * OTel `SpanKind`. Absent means `"internal"` — the overwhelming majority of
     * `ctx.trace` spans — so the common case costs no bytes on the wire and every
     * pre-existing recorded span stays valid.
     */
    kind?: OtlpSpanKind;
    /** Causal references to spans in other traces (see {@link SpanLink}). Absent when none. */
    links?: SpanLink[];
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
