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
import type { SpanEvent, SpanHandle } from "../../../shared/span-event";
import { toErrorType } from "./trace-context";

export type { SpanHandle } from "../../../shared/span-event";

/**
 * Structural shape of the `ctx.trace` span factory (see the server
 * `LunoraTracer`). Declared here rather than imported so `@lunora/do` takes no
 * dependency on `@lunora/server`; a cross-package assignability guard in
 * `@lunora/testing` fails the build if the two drift apart.
 *
 * The body's second argument is the enclosing span's {@link SpanHandle}, through
 * which it can attach attributes only known *after* it resolves (post-hoc). It is
 * a trailing parameter, so a `(trace) => …` body that ignores it still conforms.
 */
export type ContextTracer = <T>(name: string, function_: (trace: ContextTracer, span: SpanHandle) => Promise<T> | T, attributes?: LogFields) => Promise<T>;

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

/**
 * Minimal structural shape of one **Cloudflare custom span** — the object CF's
 * `tracing.enterSpan(name, (span) => …)` callback receives (GA 2026-06-16). Only
 * the surface the bridge touches is declared, so `@lunora/do` needs no runtime
 * dependency on `cloudflare:workers`; the real platform span is structurally
 * assignable.
 */
export interface CloudflareSpanLike {
    /**
     * Whether this span is actually being recorded by the runtime's sampler.
     * `false` off the traced path (unsampled) — the bridge skips its
     * `setAttribute` work in that case rather than building attribute strings for
     * a span nobody will read.
     */
    readonly isTraced: boolean;
    /** Attach one primitive attribute to the CF span. */
    setAttribute: (key: string, value: boolean | number | string | undefined) => void;
}

/**
 * Minimal structural shape of the `tracing` namespace exported by
 * `cloudflare:workers`. `enterSpan` opens a custom span that auto-nests under the
 * runtime's ambient span and ends when `callback` settles.
 */
export interface CloudflareTracingLike {
    enterSpan: <T>(name: string, callback: (span: CloudflareSpanLike) => T) => T;
}

/**
 * Resolves CF's `tracing` namespace, or `undefined` when it is unavailable —
 * off-Cloudflare, on a compat date predating custom spans, or when
 * `tracing.enterSpan` is not a function. **Injected, never imported here**, so the
 * tracer stays pure and unit-testable without `cloudflare:workers`; the shard
 * supplies the real resolver, tests a fake or `undefined`.
 */
export type CloudflareTracingResolver = () => CloudflareTracingLike | Promise<CloudflareTracingLike | undefined> | undefined;

/** What {@link createTracer} needs from the shard to build a span. */
export interface TracerDeps {
    /** The trace this ctx's spans belong to. */
    anchor: TraceAnchor;

    /** Function path the spans are attributed to. */
    functionPath: string;

    /**
     * **Opt-in, EXPERIMENTAL, default off.** When `true` *and*
     * {@link TracerDeps.resolveCloudflareTracing} yields a working
     * `tracing.enterSpan`, each `ctx.trace` span is ALSO emitted as a Cloudflare
     * **custom span**, so it nests inside CF's native binding/fetch/handler trace
     * tree on the hosted path. This only ADDS a CF-side span — the recorded
     * {@link SpanEvent} (our `SpanBuffer`/`otlpSink`) is untouched and remains the
     * source of truth plus the local studio waterfall. See {@link createTracer}
     * for the double-export and Durable-Object async-context caveats.
     */
    fuseCloudflareSpans?: boolean;

    /** Hand a finished span to the buffer + sink. */
    record: (span: SpanEvent) => void;

    /**
     * Injected resolver for CF's `tracing` namespace (see
     * {@link CloudflareTracingResolver}). Only consulted when
     * {@link TracerDeps.fuseCloudflareSpans} is `true`, so the default path never
     * calls it.
     */
    resolveCloudflareTracing?: CloudflareTracingResolver;

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
 * Mirror a finished span's name-independent key attributes onto its Cloudflare
 * custom span, best-effort. Pure and side-effect-only, so the wrapping in
 * {@link createTracer} stays readable and this is directly unit-testable with a
 * fake span.
 *
 * Gated on `span.isTraced`: an untraced span discards attributes, so building the
 * strings would be waste. User attributes are already coerced to JSON primitives
 * by `normalizeLogFields` (a nested value arrives as its JSON string), so every
 * one is copyable; the `typeof` guard is a defensive net against a non-primitive
 * ever reaching CF's `setAttribute`, which takes `string | number | boolean |
 * undefined`.
 */
export const applyCloudflareSpanAttributes = (
    span: CloudflareSpanLike,
    meta: {
        attributes: Record<string, LogFields[string]>;
        durationMs: number;
        error: SpanEvent["error"];
        functionPath: string;
        ok: boolean;
        shardKey: string | undefined;
        userId: string | undefined;
    },
): void => {
    if (!span.isTraced) {
        return;
    }

    span.setAttribute("lunora.function_path", meta.functionPath);
    span.setAttribute("lunora.ok", meta.ok);
    span.setAttribute("lunora.duration_ms", meta.durationMs);

    if (meta.shardKey !== undefined) {
        span.setAttribute("lunora.shard_key", meta.shardKey);
    }

    if (meta.userId !== undefined) {
        span.setAttribute("lunora.user_id", meta.userId);
    }

    if (meta.error !== undefined) {
        span.setAttribute("lunora.error.type", meta.error.type);
        span.setAttribute("lunora.error.message", meta.error.message);
    }

    for (const [key, value] of Object.entries(meta.attributes)) {
        if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
            span.setAttribute(`lunora.attr.${key}`, value);
        }
    }
};

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
 *
 * **Cloudflare custom-spans bridge (opt-in, EXPERIMENTAL).** When
 * `deps.fuseCloudflareSpans` is `true` and `deps.resolveCloudflareTracing` yields
 * a working `tracing.enterSpan` (`cloudflare:workers`, GA 2026-06-16), each span
 * body runs inside a CF custom span so our span nests under CF's native
 * binding/fetch/handler trace tree on the hosted path, and the finished span's
 * key attributes are mirrored onto it (gated on `span.isTraced`). Two deliberate
 * boundaries hold.
 *
 * **No double-export by default, and never a replacement.** The bridge only ADDS a
 * CF-side span; the recorded {@link SpanEvent} handed to `record` (our
 * `SpanBuffer`/`otlpSink`) is byte-for-byte the same as without the bridge and
 * stays the source of truth. It is off unless explicitly enabled precisely
 * because, once on, a deployment that ALSO ships our `otlpSink` to a collector
 * AND lets CF export its trace tree emits the same logical span down two
 * pipelines — an intentional, documented trade the operator opts into, not a
 * default.
 *
 * **DO async-context caveat.** `tracing.enterSpan`'s parent-linking inside Durable
 * Objects is unverified upstream, so this is capability-probed: an
 * absent/undefined `tracing`, a missing `enterSpan`, or an off-CF/unsampled run
 * all resolve to `undefined` and the bridge is a total no-op — exact prior
 * behavior. If CF's ambient-span linkage misbehaves in a DO, the worst case is a
 * mis-parented CF span; our own recorded waterfall is unaffected.
 */
export const createTracer = (deps: TracerDeps): ContextTracer => {
    const { anchor, fuseCloudflareSpans, functionPath, record, resolveCloudflareTracing, shardKey, userId } = deps;

    const tracerFor =
        (parentSpanId: string): ContextTracer =>
        async <T>(name: string, function_: (trace: ContextTracer, span: SpanHandle) => Promise<T> | T, attributes?: LogFields): Promise<T> => {
            const spanId = otlpRandomHex(8);
            const startTs = Date.now();
            // Normalized once, before the body runs, so a caller mutating the
            // attributes object mid-span can't alter what gets recorded.
            const normalized = normalizeLogFields(attributes);

            // Post-hoc attributes the body sets through its `SpanHandle` — merged
            // over `normalized` at record time (post-hoc wins on a key clash).
            // Each write is normalized through the same field coercer as the start
            // attributes, so the merged bag stays JSON-safe.
            const collected: Record<string, LogFields[string]> = {};
            const spanHandle: SpanHandle = {
                setAttribute: (key, value) => {
                    Object.assign(collected, normalizeLogFields({ [key]: value }));
                },
                setAttributes: (fields) => {
                    Object.assign(collected, normalizeLogFields(fields));
                },
            };

            // The recorded span (our `SpanBuffer`/`otlpSink`) is produced here
            // IDENTICALLY whether or not the CF bridge is active. An optional
            // `cfSpan` only receives a MIRROR of the finished span's attributes —
            // it never alters, gates, or replaces what we record.
            const runRecorded = async (cfSpan?: CloudflareSpanLike): Promise<T> => {
                let ok = true;
                let error: SpanEvent["error"];

                try {
                    // The body gets a tracer bound to THIS span, so anything it
                    // opens is a child of it — under `Promise.all` too — plus the
                    // span's handle for post-hoc attributes.
                    return await function_(tracerFor(spanId), spanHandle);
                } catch (error_) {
                    // Record the failure, then re-throw untouched: `ctx.trace` is
                    // instrumentation, never flow control.
                    ok = false;
                    error = {
                        message: error_ instanceof Error ? error_.message : String(error_),
                        // Prefer a LunoraError's stable `code` over the class name
                        // so spans group by the same taxonomy the RPC spans use.
                        type: toErrorType(error_),
                    };

                    throw error_;
                } finally {
                    const durationMs = Date.now() - startTs;
                    const resolvedUserId = userId();
                    // Merge start attributes with anything the body attached
                    // post-hoc; post-hoc wins on a key clash. Emit `attributes`
                    // only when the merged bag is non-empty, so a span with
                    // neither doesn't ride an empty object.
                    const merged = { ...normalized, ...collected };

                    // Guarded here, not only in the injected `record`: the span is
                    // recorded *after* the body already settled, so a telemetry
                    // failure escaping would turn a succeeded operation into a
                    // failed request — and worse, replace the body's own error
                    // with a telemetry one. Owning the invariant at the point
                    // where it is promised means a caller injecting a raw `record`
                    // can't lose it.
                    try {
                        record({
                            ...(Object.keys(merged).length === 0 ? {} : { attributes: merged }),
                            durationMs,
                            ...(error === undefined ? {} : { error }),
                            functionPath,
                            name,
                            ok,
                            parentSpanId,
                            shardKey,
                            spanId,
                            startTs,
                            traceId: anchor.traceId,
                            userId: resolvedUserId,
                        });
                    } catch {
                        // Best-effort — never let span capture fail the handler.
                    }

                    // Mirror onto the CF custom span, in its OWN guard so a
                    // `setAttribute` throw can neither skip our recording above nor
                    // escape into the handler.
                    if (cfSpan !== undefined) {
                        try {
                            applyCloudflareSpanAttributes(cfSpan, {
                                attributes: merged,
                                durationMs,
                                error,
                                functionPath,
                                ok,
                                shardKey,
                                userId: resolvedUserId,
                            });
                        } catch {
                            // Best-effort — the CF mirror is additive telemetry.
                        }
                    }
                }
            };

            // Default path: no bridge, exact prior behavior. Only when opted in
            // AND CF's `tracing.enterSpan` resolves do we open a custom span and
            // run the recorded body inside it, so our span nests under CF's native
            // trace tree. The probe returns `undefined` off-CF / on older compat /
            // unsampled, in which case this is a safe no-op.
            if (fuseCloudflareSpans === true && resolveCloudflareTracing !== undefined) {
                const cfTracing = await resolveCloudflareTracing();

                if (cfTracing !== undefined && typeof cfTracing.enterSpan === "function") {
                    return await cfTracing.enterSpan(name, (span) => runRecorded(span));
                }
            }

            return await runRecorded();
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
