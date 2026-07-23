/**
 * OpenTelemetry W3C trace-context helpers for the Lunora runtime.
 *
 * This module wraps `@opentelemetry/core`'s `W3CTraceContextPropagator` so the
 * runtime extracts a `traceparent` from the inbound request, creates a child span
 * context, and propagates the updated context to downstream calls (shards,
 * containers, fetch). It keeps the dependency on the OTel API/core isolated here
 * rather than threading OTel types through the rest of the runtime.
 */
import type { SpanContext, TraceFlags } from "@opentelemetry/api";
import { context, trace, TraceFlags as TraceFlagsValue } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

import { otlpRandomHex } from "../../../shared/otlp";

/** The canonical W3C sampled flag value (bit 0). */
const SAMPLED_FLAG: TraceFlags = TraceFlagsValue.SAMPLED;

/** The canonical W3C unsampled flag value. */
const UNSAMPLED_FLAG: TraceFlags = TraceFlagsValue.NONE;

const propagator = new W3CTraceContextPropagator();

/** Carrier getter that reads from a `Headers` object. */
const headersGetter = {
    get: (carrier: Headers, key: string): string | undefined => carrier.get(key) ?? undefined,
    keys: (carrier: Headers): string[] => [...carrier.keys()],
};

/** Carrier setter that writes into a plain Record&lt;string, string> header bag. */
const recordSetter = {
    set: (carrier: Record<string, string>, key: string, value: string): void => {
        // eslint-disable-next-line no-param-reassign
        carrier[key] = value;
    },
};

/**
 * Extract a W3C trace context from the inbound request. Returns the upstream
 * span context (with `isRemote: true`) when a valid `traceparent` is present,
 * otherwise `undefined`.
 */
const extractTraceContext = (request: Request): SpanContext | undefined => {
    const otelContext = propagator.extract(context.active(), request.headers, headersGetter);
    const spanContext = trace.getSpanContext(otelContext);

    // `getSpanContext` returns `undefined` when the context has no span; only
    // return it when the extracted ids are valid.
    if (spanContext === undefined || !trace.isSpanContextValid(spanContext)) {
        return undefined;
    }

    return spanContext;
};

/**
 * Build a child span context for the current dispatch. If an upstream context is
 * provided, the trace id is preserved and the upstream span becomes the parent;
 * otherwise a fresh trace is minted. The returned span context is the local
 * dispatch span and should be propagated to the next hop.
 */
const createDispatchSpanContext = (parent?: SpanContext): SpanContext => {
    const traceId = parent?.traceId ?? otlpRandomHex(16);
    const spanId = otlpRandomHex(8);
    const traceFlags = parent?.traceFlags ?? SAMPLED_FLAG;

    return { spanId, traceFlags, traceId };
};

/**
 * Inject a W3C `traceparent` header carrying `spanContext` into an outgoing
 * header bag. Mutates `headers` in place.
 */
const injectTraceContext = (spanContext: SpanContext, headers: Record<string, string>): void => {
    const otelContext = trace.setSpanContext(context.active(), spanContext);

    propagator.inject(otelContext, headers, recordSetter);
};

/**
 * True when the trace flags indicate the trace is sampled. Mirrors the W3C
 * `trace-flags` bit 0 definition.
 */
// eslint-disable-next-line no-bitwise -- W3C trace flags are defined as bit fields; bit masking is the correct operation here.
const isSampled = (traceFlags: TraceFlags): boolean => (traceFlags & SAMPLED_FLAG) !== 0;

export { createDispatchSpanContext, extractTraceContext, injectTraceContext, isSampled, SAMPLED_FLAG, UNSAMPLED_FLAG };
