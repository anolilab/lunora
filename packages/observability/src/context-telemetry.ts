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
import { evaluationAttributes } from "../../../shared/evaluation-attributes";
import type { LogFields } from "../../../shared/log-fields";
import { normalizeLogFields } from "../../../shared/log-fields";
import type { MetricEvent, MetricKind } from "../../../shared/metric-event";
import { buildTraceparent, LUNORA_ATTR, otlpRandomHex } from "../../../shared/otlp";
import type { SpanEvent, SpanEventPoint, SpanHandle, SpanLink, SpanOptions } from "../../../shared/span-event";
import { redactArgs } from "./request-log";
import { toErrorType } from "./trace-context";

/**
 * Disambiguate `ctx.trace`'s third argument, which accepts either a plain
 * attribute bag (`{ orderId }`) or a {@link SpanOptions} object
 * (`{ kind: "client", attributes: { … } }`).
 *
 * The rule is deliberately narrow: it is options ONLY when every key is one of
 * the three option names. So `{ kind: "client" }` is options and
 * `{ kind: "premium", plan: "x" }` is attributes — the ambiguity is confined to
 * a bag whose keys are *exclusively* `attributes`/`kind`/`links`, and the
 * explicit `{ attributes: { kind: "premium" } }` form resolves even that.
 *
 * The alternative — a fourth positional parameter — puts the rarely-used knob
 * in front of the commonly-used one at every call site, and a hard switch to
 * options-only would break every existing `ctx.trace(name, fn, { orderId })`.
 */
const isSpanOptions = (value: LogFields | SpanOptions): value is SpanOptions => {
    const keys = Object.keys(value);

    return keys.length > 0 && keys.every((key) => key === "attributes" || key === "kind" || key === "links");
};

/**
 * Bound cardinality of what one span body can attach. A span is not a log
 * stream: a loop calling `addEvent` per iteration would otherwise build an
 * unbounded array inside the request and then try to ship it, which fails the
 * collector's own limits anyway (OTel's default span-event limit is 128). We
 * keep the FIRST N rather than the last, because the events that explain a
 * runaway loop are at its start.
 */
const MAX_SPAN_EVENTS = 128;
const MAX_SPAN_LINKS = 128;

/**
 * Same bound for the attribute bag, for the same reason: `setAttribute` in a loop
 * (`span.setAttribute(`row.${id}`, status)` over a result set) is the identical
 * unbounded-growth failure through a different door, and a high-cardinality bag is
 * what destroys a collector's aggregate views. OTel's default attribute limit is
 * 128 too. Keeps the FIRST N keys; a write to a key already present always lands,
 * so a bounded set of attributes stays updatable no matter how full the bag is.
 */
const MAX_SPAN_ATTRIBUTES = 128;

/**
 * Merge normalized fields into a span's attribute bag, dropping NEW keys once
 * {@link MAX_SPAN_ATTRIBUTES} is reached.
 *
 * EVERY path that puts attributes on an exported span goes through this or
 * {@link boundedAttributes} — the post-hoc `setAttribute`/`recordEvaluation`
 * writers, the START attributes of `ctx.trace(name, fn, bag)`, and the per-item
 * bags on `addEvent`/`addLink`. The last three used to skip it, which meant a
 * handler that forwarded request args as span attributes let a client mint
 * unbounded keys through a door the bound did not cover.
 */
const assignBoundedAttributes = (attributes: Record<string, LogFields[string]>, fields: LogFields | undefined): void => {
    if (fields === undefined) {
        return;
    }

    let size = Object.keys(attributes).length;

    for (const [key, value] of Object.entries(fields)) {
        const isNew = !Object.hasOwn(attributes, key);

        if (isNew && size >= MAX_SPAN_ATTRIBUTES) {
            continue;
        }

        if (isNew) {
            size += 1;
        }

        // eslint-disable-next-line no-param-reassign -- documented mutate-in-place contract (see jsdoc above): the caller owns the bag and all three writers merge into it
        attributes[key] = value;
    }
};

/**
 * The bounded form of {@link assignBoundedAttributes} for a fresh bag: normalize
 * a caller's fields, cap them at {@link MAX_SPAN_ATTRIBUTES}, and return
 * `undefined` when nothing survives — so an empty bag is omitted rather than
 * riding as `{}`, exactly like {@link normalizeLogFields} on its own.
 */
const boundedAttributes = (fields: LogFields | undefined): LogFields | undefined => {
    const normalized = normalizeLogFields(fields);

    if (normalized === undefined || Object.keys(normalized).length <= MAX_SPAN_ATTRIBUTES) {
        return normalized;
    }

    const bounded: LogFields = {};

    assignBoundedAttributes(bounded, normalized);

    return bounded;
};

/**
 * Redact an outbound URL for a span attribute: scheme, host, and path, with the
 * query string and any userinfo dropped.
 *
 * `url.full` is the OTel-conventional attribute, but a query string routinely
 * carries API keys, signed-URL signatures, and session tokens — and a span is
 * exactly the thing that gets shipped to a third-party collector and kept for
 * months. The path alone answers "which endpoint was slow"; the secret in the
 * query answers nothing worth that risk.
 */
const redactUrl = (raw: string): string => {
    try {
        const url = new URL(raw);

        return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
        // Not absolute (a relative path, or a malformed string) — nothing to strip.
        return raw;
    }
};

/** Host of a URL, or the raw string when it will not parse. Used for low-cardinality span names. */
const safeHost = (raw: string): string => {
    try {
        return new URL(raw).host;
    } catch {
        return raw;
    }
};

/** Run a caller's propagation predicate, defaulting to NOT propagating if it throws or the URL won't parse. */
const safePropagate = (predicate: (url: URL) => boolean, raw: string): boolean => {
    try {
        return predicate(new URL(raw));
    } catch {
        return false;
    }
};

/** Normalize `ctx.trace`'s third argument into a {@link SpanOptions} (see {@link isSpanOptions}). */
const resolveSpanOptions = (options: LogFields | SpanOptions | undefined): SpanOptions => {
    if (options === undefined) {
        return {};
    }

    return isSpanOptions(options) ? options : { attributes: options };
};

// Both re-exported straight from their source module (also imported above for
// local use in `MetricsDeps`/`TracerDeps` etc.) — `export…from` keeps the
// single source of truth per `unicorn/prefer-export-from`.
export type { MetricEvent, MetricKind } from "../../../shared/metric-event";
export type { SpanEvent, SpanEventPoint, SpanHandle, SpanKind, SpanLink, SpanOptions } from "../../../shared/span-event";

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
export type ContextTracer = <T>(
    name: string,
    function_: (trace: ContextTracer, span: SpanHandle) => Promise<T> | T,
    options?: LogFields | SpanOptions,
) => Promise<T>;

/** Structural shape of the `ctx.metrics` recorder (see the server `LunoraMetrics`). */
export interface ContextMetrics {
    count: (name: string, value?: number, attributes?: LogFields) => void;
    gauge: (name: string, value: number, attributes?: LogFields) => void;
    record: (name: string, value: number, attributes?: LogFields) => void;
}

/** The trace a ctx's spans hang off: the shared id, and the span they parent to. */
export interface TraceAnchor {
    rootSpanId: string;

    /**
     * The W3C `sampled` verdict for this trace, inherited from the inbound
     * `traceparent` when there was one. Carried on the anchor rather than
     * re-derived per outbound call so every `ctx.fetch` of one dispatch
     * propagates the same answer.
     */
    sampled?: boolean;
    traceId: string;
}

/**
 * Minimal structural shape of one **host-native custom span** — the object a
 * `tracing.enterSpan(name, (span) => …)` callback receives (GA 2026-06-16). Only
 * the surface the bridge touches is declared, so `@lunora/do` needs no runtime
 * dependency on `cloudflare:workers`; the real platform span is structurally
 * assignable.
 */

/**
 * A host-supplied span, structurally.
 *
 * Named for the role rather than the provider: this is whatever the runtime's
 * own tracer hands back, and Cloudflare's `enterSpan` callback argument is one
 * shape that satisfies it. Kept structural so no provider type is imported —
 * the repo's documented `*Like` pattern.
 */
export interface HostSpanLike {
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
export interface HostTracingLike {
    enterSpan: <T>(name: string, callback: (span: HostSpanLike) => T) => T;
}

/**
 * Resolves CF's `tracing` namespace, or `undefined` when it is unavailable —
 * on a host with no native tracer, on a Cloudflare compat date predating custom spans, or when
 * `tracing.enterSpan` is not a function. **Injected, never imported here**, so the
 * tracer stays pure and unit-testable without `cloudflare:workers`; the shard
 * supplies the real resolver, tests a fake or `undefined`.
 */
export type HostTracingResolver = () => HostTracingLike | Promise<HostTracingLike | undefined> | undefined;

/** What {@link createTracer} needs from the shard to build a span. */
export interface TracerDeps {
    /** The trace this ctx's spans belong to. */
    anchor: TraceAnchor;

    /**
     * Whether to record a span body's error message (and a `recordException`
     * stacktrace) verbatim rather than redacted. Mirrors the request log's
     * `captureRaw`: `true` in dev (`isDevEnvironment`), `false` in production —
     * the span pipeline is the one sink third-party collectors (Datadog/Axiom
     * via `otlpSink`) receive, so it must not ship raw PII/internals by default
     * the way the request log and function-metrics sinks already don't.
     */
    captureRaw?: boolean;

    /** Function path the spans are attributed to. */
    functionPath: string;

    /**
     * **Opt-in, EXPERIMENTAL, default off.** When `true` *and*
     * {@link TracerDeps.resolveHostTracing} yields a working
     * `tracing.enterSpan`, each `ctx.trace` span is ALSO emitted as a host-native
     * **custom span**, so it nests inside CF's native binding/fetch/handler trace
     * tree on the hosted path. This only ADDS a CF-side span — the recorded
     * {@link SpanEvent} (our `SpanBuffer`/`otlpSink`) is untouched and remains the
     * source of truth plus the local studio waterfall. The `enterSpan` call itself
     * is now workerd-validated as available and side-effect-free inside a Durable
     * Object; CF's exported parent-linking under sampling remains unverified. See
     * {@link createTracer} for the double-export and Durable-Object async-context
     * caveats.
     */
    fuseHostSpans?: boolean;

    /** Hand a finished span to the buffer + sink. */
    record: (span: SpanEvent) => void;

    /**
     * Injected resolver for CF's `tracing` namespace (see
     * {@link HostTracingResolver}). Only consulted when
     * {@link TracerDeps.fuseHostSpans} is `true`, so the default path never
     * calls it.
     */
    resolveHostTracing?: HostTracingResolver;

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
export const applyHostSpanAttributes = (
    span: HostSpanLike,
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

    span.setAttribute(LUNORA_ATTR.functionPath, meta.functionPath);
    span.setAttribute(LUNORA_ATTR.ok, meta.ok);
    span.setAttribute(LUNORA_ATTR.durationMs, meta.durationMs);

    if (meta.shardKey !== undefined) {
        span.setAttribute(LUNORA_ATTR.shardKey, meta.shardKey);
    }

    if (meta.userId !== undefined) {
        span.setAttribute(LUNORA_ATTR.userId, meta.userId);
    }

    if (meta.error !== undefined) {
        // Wire change: these were `lunora.error.type` / `lunora.error.message`;
        // they now converge on the OTel-standard `error.type` / `error.message`
        // so a collector query matches the worker exporter's span too.
        span.setAttribute(LUNORA_ATTR.errorType, meta.error.type);
        span.setAttribute(LUNORA_ATTR.errorMessage, meta.error.message);
    }

    for (const [key, value] of Object.entries(meta.attributes)) {
        if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
            span.setAttribute(`lunora.attr.${key}`, value);
        }
    }
};

/** Everything a {@link SpanHandle}'s body attached, ready to merge into the recorded span. */
export interface SpanCollection {
    attributes: Record<string, LogFields[string]>;
    events: SpanEventPoint[];
    links: SpanLink[];
}

/** A {@link SpanHandle} plus read access to what it has collected so far. */
export interface SpanCollector {
    collected: SpanCollection;
    handle: SpanHandle;
}

/**
 * Build a span's post-hoc collection surface: the {@link SpanHandle} handed to a
 * `ctx.trace` body, and the bag it writes into.
 *
 * Factored out because the same surface backs two things — every `ctx.trace`
 * span, and the per-dispatch **wide event** (`ctx.span`), where the accumulated
 * attributes become the canonical one-event-per-request summary. Sharing the
 * implementation is what makes those two feel like the same API instead of two
 * that happen to resemble each other.
 *
 * `captureRaw` (default `false`) gates `recordException`'s `exception.message`/
 * `exception.stacktrace` the same way {@link createTracer} gates a span's own
 * error message — a stack is file paths and internals by definition, the exact
 * class `isInternalCode` redaction exists for, so it rides the same dev-only
 * escape hatch rather than shipping to a third-party collector by default.
 */
export const createSpanCollector = (ids: { spanId: string; traceId: string }, captureRaw = false): SpanCollector => {
    const collected: SpanCollection = { attributes: {}, events: [], links: [] };

    const handle: SpanHandle = {
        spanContext: () => ids,
        addEvent: (name, attributes) => {
            if (collected.events.length >= MAX_SPAN_EVENTS) {
                return;
            }

            const normalized = boundedAttributes(attributes);

            collected.events.push({
                ...(normalized === undefined ? {} : { attributes: normalized }),
                name,
                ts: Date.now(),
            });
        },
        addLink: (link) => {
            if (collected.links.length >= MAX_SPAN_LINKS) {
                return;
            }

            const normalized = boundedAttributes(link.attributes);

            collected.links.push({
                ...(normalized === undefined ? {} : { attributes: normalized }),
                spanId: link.spanId,
                traceId: link.traceId,
            });
        },
        recordEvaluation: (evaluation) => {
            // Build the `gen_ai.evaluation.<name>.score`/`.label` pair (the exact
            // keys the cloud OTLP decoder reads back) and merge it in like any
            // other post-hoc attribute, so it flushes on this span over OTLP with
            // no special casing downstream. `evaluationAttributes` throws on an
            // empty name / non-finite score — caller misuse, so it surfaces in the
            // body rather than being silently dropped.
            assignBoundedAttributes(collected.attributes, normalizeLogFields(evaluationAttributes(evaluation)));
        },
        recordException: (error) => {
            // The OTel-conventional `exception` event. `exception.stacktrace` is
            // included when present AND `captureRaw` — a HANDLED exception has no
            // other record (nothing re-throws it for a top-level handler to log),
            // but a stack is exactly the kind of internal detail the production
            // redaction posture exists to keep off third-party sinks.
            const rawMessage = error instanceof Error ? error.message : String(error);

            handle.addEvent("exception", {
                "exception.message": redactArgs(rawMessage, captureRaw) as string,
                ...(captureRaw && error instanceof Error && typeof error.stack === "string" ? { "exception.stacktrace": error.stack } : {}),
                "exception.type": toErrorType(error),
            });
        },
        setAttribute: (key, value) => {
            assignBoundedAttributes(collected.attributes, normalizeLogFields({ [key]: value }));
        },
        setAttributes: (fields) => {
            assignBoundedAttributes(collected.attributes, normalizeLogFields(fields));
        },
    };

    return { collected, handle };
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
 * `deps.fuseHostSpans` is `true` and `deps.resolveHostTracing` yields
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
 * **DO async-context caveat (EXPERIMENTAL, partially workerd-validated).**
 * `tracing.enterSpan` is now confirmed to EXIST and RUN inside a real Durable
 * Object under `@cloudflare/vitest-plugin` (see
 * `__tests__/workerd/context-telemetry-cf-bridge.workerd.test.ts`): it resolves
 * from `cloudflare:workers`, its callback executes and returns the body value
 * without throwing, `span.isTraced` is a real boolean, and — the key additive
 * guarantee — our recorded {@link SpanEvent} tree (parent/child via the threaded
 * `parentSpanId`) is byte-for-byte identical with the bridge on vs off. What that
 * harness CANNOT prove is CF's own *exported* parent-linking: with no trace head
 * attached the run is unsampled (`isTraced === false`), so CF records nothing and
 * its span tree is not introspectable. So `enterSpan`'s ambient-span parent-linking
 * inside a DO stays unverified upstream, and this remains capability-probed: an
 * absent/undefined `tracing`, a missing `enterSpan`, or an off-CF/unsampled run all
 * resolve to `undefined`/no-op — exact prior behavior. If CF's ambient-span linkage
 * misbehaves in a DO, the worst case is a mis-parented CF span; our own recorded
 * waterfall is unaffected.
 */
export const createTracer = (deps: TracerDeps): ContextTracer => {
    const { anchor, captureRaw = false, fuseHostSpans, functionPath, record, resolveHostTracing, shardKey, userId } = deps;

    const tracerFor =
        (parentSpanId: string): ContextTracer =>
        async <T>(name: string, function_: (trace: ContextTracer, span: SpanHandle) => Promise<T> | T, options?: LogFields | SpanOptions): Promise<T> => {
            const spanId = otlpRandomHex(8);
            const startTs = Date.now();
            // Either a plain attribute bag or a full options object — see
            // `isSpanOptions` for the (deliberately narrow) discriminator.
            const resolved: SpanOptions = resolveSpanOptions(options);
            // Normalized once, before the body runs, so a caller mutating the
            // attributes object mid-span can't alter what gets recorded.
            const normalized = normalizeLogFields(resolved.attributes);

            // Post-hoc attributes/events/links the body attaches through its
            // `SpanHandle`. Attributes merge over `normalized` at record time
            // (post-hoc wins on a key clash); each write is normalized through the
            // same field coercer as the start attributes, so the bag stays JSON-safe.
            const { collected, handle: spanHandle } = createSpanCollector({ spanId, traceId: anchor.traceId }, captureRaw);

            // The recorded span (our `SpanBuffer`/`otlpSink`) is produced here
            // IDENTICALLY whether or not the CF bridge is active. An optional
            // `hostSpan` only receives a MIRROR of the finished span's attributes —
            // it never alters, gates, or replaces what we record.
            const runRecorded = async (hostSpan?: HostSpanLike): Promise<T> => {
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

                    const rawMessage = error_ instanceof Error ? error_.message : String(error_);

                    error = {
                        // Redacted like the request log's error message by default
                        // (`captureRaw` is the same dev-only escape hatch) — this
                        // is the span pipeline, the one sink with third-party
                        // fan-out (`otlpSink`/`webhookSink`), so it must not ship
                        // a raw validation/constraint message in the clear.
                        message: redactArgs(rawMessage, captureRaw) as string,
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
                    //
                    // Merged THROUGH the bound, not with a spread: `collected` is
                    // already capped on its own, but the start bag never was, so a
                    // spread let `ctx.trace(name, fn, req.body)` mint unbounded
                    // keys — the exact high-cardinality blow-up
                    // `MAX_SPAN_ATTRIBUTES` exists to stop, through a door it did
                    // not cover. Start attributes are merged first so they claim
                    // the slots (they are the ones the caller declared up front);
                    // a post-hoc write to a key already present always lands.
                    const merged: LogFields = {};

                    assignBoundedAttributes(merged, normalized);
                    assignBoundedAttributes(merged, collected.attributes);
                    // Start links (known up front) then post-hoc ones, in the order
                    // they were declared — a link list is causal history, not a set.
                    const links = [...(resolved.links ?? []), ...collected.links];

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
                            ...(collected.events.length === 0 ? {} : { events: collected.events }),
                            ...(error === undefined ? {} : { error }),
                            functionPath,
                            // Omitted when `"internal"` so the default costs no
                            // bytes and pre-existing recorded spans stay identical.
                            ...(resolved.kind === undefined || resolved.kind === "internal" ? {} : { kind: resolved.kind }),
                            ...(links.length === 0 ? {} : { links }),
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
                    if (hostSpan !== undefined) {
                        try {
                            applyHostSpanAttributes(hostSpan, {
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
            if (fuseHostSpans === true && resolveHostTracing !== undefined) {
                // Guarded, like every other host interaction here: `runRecorded` is
                // the ARGUMENT to `enterSpan`, so a probe rejection or an
                // `enterSpan` throw would mean the handler body never runs at all —
                // telemetry silently swallowing a user's mutation. On any failure
                // fall through to the un-bridged path, which is the exact prior
                // behavior.
                let bodyStarted = false;

                try {
                    const cfTracing = await resolveHostTracing();

                    if (cfTracing !== undefined && typeof cfTracing.enterSpan === "function") {
                        return await cfTracing.enterSpan(name, (span) => {
                            bodyStarted = true;

                            return runRecorded(span);
                        });
                    }
                } catch (error_) {
                    // Only a failure BEFORE the body started is ours to swallow —
                    // then the un-bridged path below runs it exactly once. Once the
                    // body has started, the rejection is the handler's own error
                    // (`ctx.trace` re-throws those untouched) and re-running would
                    // execute the user's mutation twice.
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `bodyStarted` is set inside the `enterSpan` callback, which TS's control-flow analysis cannot see, so it narrows to its initializer here. The guard is what stops a handler error being swallowed and the user's mutation re-run.
                    if (bodyStarted) {
                        throw error_;
                    }
                }
            }

            return await runRecorded();
        };

    return tracerFor(anchor.rootSpanId);
};

/** What {@link createTracedFetch} needs from the shard. */
export interface TracedFetchDeps {
    /** The trace the CLIENT spans belong to. */
    anchor: TraceAnchor;

    /**
     * Whether to record a failed fetch's error message verbatim rather than
     * redacted. Same dev-only escape hatch as {@link TracerDeps.captureRaw}, and
     * the same reason: a `fetch` TypeError embeds the request URL, so a key in a
     * query string would otherwise reach the collector in the clear on the very
     * span whose `url.full` is scrubbed by `redactUrl`.
     */
    captureRaw?: boolean;

    /** Function path the spans are attributed to. */
    functionPath: string;

    /**
     * Whether to inject `traceparent` into the outbound request — and, with a
     * predicate, to which destinations. Default `true`.
     */
    propagate?: ((url: URL) => boolean) | boolean;
    /** Hand a finished span to the buffer + sink. */
    record: (span: SpanEvent) => void;
    /** Shard key for single-shard calls; absent for the unnamed root DO. */
    shardKey: string | undefined;
    /** Read lazily — the acting user is resolved per span. */
    userId: () => string | undefined;
}

/** The `fetch` shape `ctx.fetch` exposes — the platform global's, narrowed to what we wrap. */
export type ContextFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Build `ctx.fetch`: the platform `fetch`, wrapped so every outbound call
 * becomes a **CLIENT span** and carries W3C trace context to the callee.
 *
 * Two gaps close here. First, an uninstrumented `fetch` makes the single most
 * common source of latency — waiting on somebody else's service — invisible: a
 * handler that spends 900ms in Stripe shows one opaque 900ms bar. Second,
 * without an outbound `traceparent` the callee starts a brand-new trace, so the
 * two halves of one logical request can never be stitched together, which is the
 * entire premise of distributed tracing.
 *
 * The span id is minted BEFORE the request is sent, precisely so the header
 * announces the id the span will actually be recorded under. Deriving it
 * afterwards (or reusing the parent's) would produce a `traceparent` naming a
 * span that never existed, and a callee parented to nothing.
 *
 * Kind is `client` rather than `internal` — that is what lets a collector draw
 * the edge to the downstream service in a service map.
 *
 * Failures are recorded and re-thrown untouched, and a non-2xx response is
 * recorded as an ERROR span (it is a failed call from the caller's point of
 * view) while still being returned normally — instrumentation, never flow
 * control.
 */
export const createTracedFetch = (deps: TracedFetchDeps, base: ContextFetch): ContextFetch => {
    const { anchor, captureRaw = false, functionPath, propagate = true, record, shardKey, userId } = deps;

    return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
        const spanId = otlpRandomHex(8);
        const startTs = Date.now();
        const request = new Request(input, init);
        const shouldPropagate = typeof propagate === "function" ? safePropagate(propagate, request.url) : propagate;

        if (shouldPropagate) {
            // Set, not appended: a caller that already put a `traceparent` on the
            // request meant it, but our span is the immediate parent of whatever
            // the callee records, so ours is the correct one to send.
            // `anchor.sampled` — NOT a hardcoded `true`. Telling the callee a trace
            // is sampled when it was sampled out upstream makes it record spans
            // for a trace nobody kept, and the collector holds an orphan.
            request.headers.set("traceparent", buildTraceparent(anchor.traceId, spanId, anchor.sampled ?? true));
        }

        // No separate `ok` flag: it is exactly `error === undefined` on every path
        // (a non-2xx response sets `error` just as a thrown failure does), and a
        // seeded `let ok = true` was a dead write CodeQL rightly flagged.
        let error: SpanEvent["error"];
        let status: number | undefined;

        try {
            const response = await base(request);

            status = response.status;

            if (!response.ok) {
                error = { message: `HTTP ${String(response.status)}`, type: `HTTP_${String(response.status)}` };
            }

            return response;
        } catch (error_) {
            // Redacted like every other span error: a `fetch` failure message
            // routinely embeds the full request URL (query string included), and
            // this is the span pipeline — the one sink with third-party fan-out.
            // Shipping it raw here would leak exactly what `redactUrl` strips off
            // `url.full` two lines below.
            const rawMessage = error_ instanceof Error ? error_.message : String(error_);

            error = { message: redactArgs(rawMessage, captureRaw) as string, type: toErrorType(error_) };

            throw error_;
        } finally {
            try {
                record({
                    attributes: {
                        "http.request.method": request.method,
                        ...(status === undefined ? {} : { "http.response.status_code": status }),
                        "url.full": redactUrl(request.url),
                    },
                    durationMs: Date.now() - startTs,
                    ...(error === undefined ? {} : { error }),
                    functionPath,
                    kind: "client",
                    // Low-cardinality: the method plus the host, never the full
                    // path. A span name built from a path with ids in it makes
                    // every request its own group in a collector, which is how a
                    // trace backend's aggregate views get destroyed.
                    name: `${request.method} ${safeHost(request.url)}`,
                    ok: error === undefined,
                    parentSpanId: anchor.rootSpanId,
                    shardKey,
                    spanId,
                    startTs,
                    traceId: anchor.traceId,
                    userId: userId(),
                });
            } catch {
                // Best-effort — see createTracer.
            }
        }
    };
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

    /**
     * Whether to record the failure message verbatim rather than redacted —
     * the same dev-only escape hatch as {@link TracerDeps.captureRaw}. This
     * synthetic root span carries the SAME error message the request log and
     * function-metrics sinks already redact by default, so it must not be the
     * one durable copy that ships it raw to a third-party collector.
     */
    captureRaw?: boolean;

    /**
     * What the handler attached to the dispatch through `ctx.span` — the **wide
     * event**. These are the attributes that would otherwise have been scattered
     * across a dozen `ctx.log` lines; carrying them on the one span that already
     * exists per request is the OTel-native way to get a wide event without
     * multiplying log records.
     */
    collected?: SpanCollection;
    durationMs: number;
    failure: { thrown: unknown } | undefined;
    functionPath: string;
    shardKey: string | undefined;
    startTs: number;
    userId: string | undefined;
}): SpanEvent => {
    const { anchor, captureRaw = false, collected, durationMs, failure, functionPath, shardKey, startTs, userId } = input;
    const attributes = collected?.attributes ?? {};

    return {
        ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
        dispatch: true,
        durationMs,
        ...(collected === undefined || collected.events.length === 0 ? {} : { events: collected.events }),
        ...(failure === undefined
            ? {}
            : {
                  error: {
                      message: redactArgs(failure.thrown instanceof Error ? failure.thrown.message : String(failure.thrown), captureRaw) as string,
                      type: toErrorType(failure.thrown),
                  },
              }),
        functionPath,
        ...(collected === undefined || collected.links.length === 0 ? {} : { links: collected.links }),
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
