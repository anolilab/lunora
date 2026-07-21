/**
 * The `ctx.trace` and `ctx.metrics` factories, and the pure builder for a
 * dispatch's synthetic root span.
 *
 * Split out of `shard-do.ts` for the reason `parseLogArgs`/`isLogFields` and
 * `resolveTraceAnchor`/`toErrorType` were: that file is ~8.3k lines, and none of
 * this needs the shard instance. What it *does* need — the trace anchor, the
 * shard key, the acting user, and somewhere to put a finished record — is a
 * small, explicit dependency set, so it is injected rather than reached for
 * through `this`. That makes both factories directly unit-testable without
 * standing up a Durable Object.
 *
 * The injected `record` callbacks are where the buffering and sink dispatch live
 * (`ShardDO.recordSpan` / `recordMetric`); this module decides only *what* a
 * span or measurement is, never where it goes.
 */
import type { LogFields } from "../../../shared/log-fields";
import { normalizeLogFields } from "../../../shared/log-fields";
import type { MetricEvent, MetricKind } from "../../../shared/metric-event";
import { otlpRandomHex } from "../../../shared/otlp";
import type { SpanEvent } from "../../../shared/span-event";
import { toErrorType } from "./trace-context";

/**
 * Structural shape of the `ctx.trace` span factory (see the server
 * `LunoraTracer`). Declared here rather than imported so `@lunora/do` takes no
 * dependency on `@lunora/server`; a cross-package assignability guard in
 * `@lunora/testing` fails the build if the two drift apart.
 */
export type ContextTracer = <T>(name: string, function_: (trace: ContextTracer) => Promise<T> | T, attributes?: LogFields) => Promise<T>;

/** Structural shape of the `ctx.metrics` recorder (see the server `LunoraMetrics`). */
export interface ContextMetrics {
    count: (name: string, value?: number, attributes?: LogFields) => void;
    gauge: (name: string, value: number, attributes?: LogFields) => void;
    record: (name: string, value: number, attributes?: LogFields) => void;
}

/** The trace a ctx's spans hang off: the shared id, and the span they parent to. */
export interface TraceAnchor {
    rootSpanId: string;
    traceId: string;
}

/** What {@link createTracer} needs from the shard to build a span. */
export interface TracerDeps {
    /** The trace this ctx's spans belong to. */
    anchor: TraceAnchor;
    /** Function path the spans are attributed to. */
    functionPath: string;
    /** Hand a finished span to the buffer + sink. */
    record: (span: SpanEvent) => void;
    /** Shard key for single-shard calls; absent for the unnamed root DO. */
    shardKey: string | undefined;
    /** Read lazily — the acting user is resolved per span, not per ctx. */
    userId: () => string | undefined;
}

/** What {@link createMetrics} needs from the shard to build a measurement. */
export interface MetricsDeps {
    functionPath: string;
    record: (event: MetricEvent) => void;
    shardKey: string | undefined;
}

/**
 * Build the `ctx.trace` span factory for one dispatched function.
 *
 * **Nesting is explicit, not ambient.** Each span's body receives a tracer bound
 * to that span; calling it is what makes a child. An earlier design kept an
 * ambient stack of "the currently open span" and parented to its top, which
 * reads nicer but is unfixably wrong under concurrency: in
 * `Promise.all([trace("a", …), trace("b", …)])`, `b` starts while `a` is on the
 * stack and is recorded as a *child* of `a` rather than its sibling — and
 * parallel fan-out is one of the main things people reach for a tracer to
 * measure. Distinguishing "called inside a's body" from "called concurrently
 * with a" needs `AsyncLocalStorage`, which this package deliberately avoids (see
 * `dependency-tracker.ts` — shard DOs run under a slimmer compat profile than
 * `nodejs_compat`). So the parent is threaded, exactly like the dependency
 * tracker and the subscription identity: correct in every case, and visible at
 * the call site.
 *
 * The anchor is passed in for the same reason. `ShardDO.currentRequestTrace` is
 * cleared in the dispatch `finally`, and a subscription re-run builds its ctx
 * during* the writing mutation's flush — so reading that shared field at span
 * time would file the re-run's spans under the mutation's trace.
 */
export const createTracer = (deps: TracerDeps): ContextTracer => {
    const { anchor, functionPath, record, shardKey, userId } = deps;

    const tracerFor =
        (parentSpanId: string): ContextTracer =>
        async <T>(name: string, function_: (trace: ContextTracer) => Promise<T> | T, attributes?: LogFields): Promise<T> => {
            const spanId = otlpRandomHex(8);
            const startTs = Date.now();
            // Normalized once, before the body runs, so a caller mutating the
            // attributes object mid-span can't alter what gets recorded.
            const normalized = normalizeLogFields(attributes);

            let ok = true;
            let error: SpanEvent["error"];

            try {
                // The body gets a tracer bound to THIS span, so anything it opens
                // is a child of it — under `Promise.all` too.
                return await function_(tracerFor(spanId));
            } catch (error_) {
                // Record the failure, then re-throw untouched: `ctx.trace` is
                // instrumentation, never flow control.
                ok = false;
                error = {
                    message: error_ instanceof Error ? error_.message : String(error_),
                    // Prefer a LunoraError's stable `code` over the class name so
                    // spans group by the same taxonomy the RPC spans use.
                    type: toErrorType(error_),
                };

                throw error_;
            } finally {
                // Guarded here, not only in the injected `record`: the span is
                // recorded *after* the body already settled, so a telemetry
                // failure escaping would turn a succeeded operation into a failed
                // request — and worse, replace the body's own error with a
                // telemetry one. Owning the invariant at the point where it is
                // promised means a caller injecting a raw `record` can't lose it.
                try {
                    record({
                        ...(normalized === undefined ? {} : { attributes: normalized }),
                        durationMs: Date.now() - startTs,
                        ...(error === undefined ? {} : { error }),
                        functionPath,
                        name,
                        ok,
                        parentSpanId,
                        shardKey,
                        spanId,
                        startTs,
                        traceId: anchor.traceId,
                        userId: userId(),
                    });
                } catch {
                    // Best-effort — never let span capture fail the handler.
                }
            }
        };

    return tracerFor(anchor.rootSpanId);
};

/**
 * Build the `ctx.metrics` recorder for one dispatched function.
 *
 * Deliberately stateless: each call emits one measurement rather than
 * accumulating into a per-dispatch map. Pre-aggregating here would have to pick a
 * flush point and a merge rule per instrument kind (sum a counter, last-wins a
 * gauge, and a histogram cannot be merged at all without losing the
 * distribution) — so the runtime stays a transport and the collector, which is
 * built for exactly this, does the aggregation.
 */
export const createMetrics = (deps: MetricsDeps): ContextMetrics => {
    const { functionPath, record, shardKey } = deps;

    const emit = (kind: MetricKind, name: string, value: number, attributes?: LogFields): void => {
        // A NaN/Infinity measurement has no meaningful encoding and would poison
        // an aggregate downstream — drop it rather than export it.
        if (!Number.isFinite(value)) {
            return;
        }

        const normalized = normalizeLogFields(attributes);

        // Guarded for the same reason as a span's — see `createTracer`.
        try {
            record({
                ...(normalized === undefined ? {} : { attributes: normalized }),
                functionPath,
                kind,
                name,
                shardKey,
                ts: Date.now(),
                value,
            });
        } catch {
            // Best-effort — recording a measurement must never break the handler.
        }
    };

    return {
        count: (name: string, value = 1, attributes?: LogFields) => {
            emit("counter", name, value, attributes);
        },
        gauge: (name: string, value: number, attributes?: LogFields) => {
            emit("gauge", name, value, attributes);
        },
        record: (name: string, value: number, attributes?: LogFields) => {
            emit("histogram", name, value, attributes);
        },
    };
};

/**
 * Build the synthetic root span for a finished dispatch — the bar the studio's
 * waterfall hangs a request's `ctx.trace` spans under.
 *
 * Pure: the caller decides whether to record it (only when the dispatch actually
 * produced spans) and where to put it. It is never routed to `sink.onSpan`,
 * because the runtime already emits the dispatch to `onRpc` and a collector would
 * otherwise show it twice.
 */
export const dispatchRootSpan = (input: {
    anchor: TraceAnchor;
    durationMs: number;
    failure: { thrown: unknown } | undefined;
    functionPath: string;
    shardKey: string | undefined;
    startTs: number;
    userId: string | undefined;
}): SpanEvent => {
    const { anchor, durationMs, failure, functionPath, shardKey, startTs, userId } = input;

    return {
        dispatch: true,
        durationMs,
        ...(failure === undefined
            ? {}
            : {
                  error: {
                      message: failure.thrown instanceof Error ? failure.thrown.message : String(failure.thrown),
                      type: toErrorType(failure.thrown),
                  },
              }),
        functionPath,
        name: functionPath,
        ok: failure === undefined,
        // Empty: this span IS the trace's root locally. The worker's own RPC span
        // sits above it in a full collector-side trace, but it is not in this
        // buffer, so naming it here would dangle.
        parentSpanId: "",
        shardKey,
        spanId: anchor.rootSpanId,
        startTs,
        traceId: anchor.traceId,
        userId,
    };
};
