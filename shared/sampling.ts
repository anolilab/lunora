/**
 * Deterministic trace-sampling primitives, bundler-inlined (like
 * {@link file://./otlp.ts}) so the worker runtime (`@lunora/runtime`) and the
 * Durable Object (`@lunora/do`) reach the SAME keep/drop verdict for a trace from
 * ONE encoder instead of two drifting mirrors. The two consumers sit on opposite
 * tiers and must not gain a runtime dependency edge on each other, so this lives
 * in `shared/` and is inlined into each `dist` rather than published.
 *
 * The model mirrors Cloudflare Workers' `head_sampling_rate`: one deterministic
 * head decision per trace, taken ONCE at the worker's entry and then propagated
 * — so a trace is kept or dropped *whole* (never half) — biased to always keep
 * traces that produced an error (tail bias) so failures are never sampled away.
 *
 * **What the verdict is keyed on is the caller's choice, not this module's.**
 * `resolveTraceSampling` hashes whatever id it is handed. The worker
 * (`otel-trace.ts`'s `beginDispatchTrace`) hands it the inbound TRACE id only
 * when `trustInboundTraceContext` accepted the upstream; otherwise it hands it
 * the freshly-minted SPAN id, because a client that could choose the trace id
 * could otherwise choose its own verdict — dropping itself out of every trace,
 * or forcing capture to inflate the operator's ingest bill. Shards and
 * containers do NOT re-derive anything: they read the settled verdict off the
 * propagated `traceparent` sampled flag (`trace-context.ts`), which is what
 * actually keeps the trace whole across tiers.
 *
 * Pure and dependency-free (only built-ins) so inlining stays sound. Only trace
 * spans are governed here; metrics and application logs are never sampled.
 */

/** Default head-sampling rate: keep every trace. */
const DEFAULT_TRACE_HEAD_RATE = 1;

/**
 * Trace-sampling configuration — the `sampling` block on the worker's
 * observability options.
 */
interface TraceSamplingConfig {
    /**
     * Always keep a whole trace that produced an error span (root or any child
     * `ok: false`), regardless of the head decision — the tail bias that keeps
     * failures observable under aggressive head sampling. Default `true`.
     */
    alwaysSampleErrors?: boolean;

    /**
     * Fraction of traces to keep by the deterministic head decision, in `[0, 1]`.
     * `1` keeps every trace (the default), `0` drops every non-error trace, `0.1`
     * keeps ~10%. Values outside the range are clamped by the decision helpers.
     */
    headRate?: number;
}

/**
 * The resolved per-trace decision. `isTraced` is the cheap head verdict callers
 * check to skip work up front; `keepErrors` carries the tail-bias toggle to the
 * export boundary, where the trace's final error status is known.
 */
interface TraceSamplingDecision {
    /**
     * True when the trace passed head sampling. Callers may cheaply skip buffering
     * or exporting a trace's spans when this is false — subject to the error-keep
     * re-check at the export boundary (see {@link shouldExportTrace}).
     */
    isTraced: boolean;
    /** Whether error traces are force-kept at export even when `isTraced` is false. */
    keepErrors: boolean;
}

/**
 * Map a trace id to a stable value in `[0, 1)` from its LAST 8 hex characters
 * (the low 32 bits) divided by `2^32`. Same id → same value everywhere, so the
 * head decision is identical on the worker, the shard, and any container. A
 * malformed or empty id parses to `NaN` and falls back to `0` (the keep-leaning
 * end), so a bad id is never silently dropped.
 *
 * The LOW bits, not the high ones, because an inbound trace id is not
 * necessarily uniformly random across its 128 bits. The OpenTelemetry
 * specification's `TraceIdRatioBased` sampler is defined over the *rightmost*
 * portion of the id for exactly this reason: a 64-bit-id system propagating into
 * a W3C context left-pads with 16 zero hex digits, and AWS X-Ray puts the
 * request's epoch seconds in the leading 8. Keying on the first 8 characters
 * therefore gave every zero-padded trace the value `0` (kept at ANY rate above
 * 0) and every X-Ray trace of the current era a value near `1` (dropped at any
 * rate below ~0.9) — i.e. 100% or 0% sampling instead of the configured rate.
 * `@lunora/runtime`'s `otel-trace.ts` keys on the upstream id whenever
 * `trustInboundTraceContext` is set, so both shapes reach here in practice.
 * Locally minted ids are uniformly random, so they are unaffected either way.
 */
const traceIdToUnitInterval = (traceId: string): number => {
    const int = Number.parseInt(traceId.slice(-8), 16);

    return Number.isFinite(int) ? int / 0x1_0000_0000 : 0;
};

/**
 * The deterministic head-sampling verdict for a trace id at a given rate. `>= 1`
 * keeps every trace (so the all-`f` id is never dropped by a rounding boundary);
 * `<= 0` drops every trace; otherwise keep when the id's stable unit value is
 * below the rate.
 */
const isTraceHeadSampled = (traceId: string, headRate: number = DEFAULT_TRACE_HEAD_RATE): boolean => {
    if (headRate >= 1) {
        return true;
    }

    if (headRate <= 0) {
        return false;
    }

    return traceIdToUnitInterval(traceId) < headRate;
};

/**
 * Resolve a {@link TraceSamplingConfig} against a trace id into the concrete
 * {@link TraceSamplingDecision} for that trace. Applies the defaults (keep-all
 * head rate, errors force-kept) so an absent config keeps every trace — fully
 * backward-compatible.
 */
const resolveTraceSampling = (config: TraceSamplingConfig | undefined, traceId: string): TraceSamplingDecision => {
    return {
        isTraced: isTraceHeadSampled(traceId, config?.headRate ?? DEFAULT_TRACE_HEAD_RATE),
        keepErrors: config?.alwaysSampleErrors ?? true,
    };
};

/**
 * The export-boundary verdict: keep the trace when it was head-sampled, or when
 * it produced an error and errors are force-kept. This is where the tail bias is
 * applied — a trace dropped by the head decision is still exported whole if it
 * turned out to contain an error span.
 */
const shouldExportTrace = (decision: TraceSamplingDecision, traceHasError: boolean): boolean => {
    return decision.isTraced || (decision.keepErrors && traceHasError);
};

export type { TraceSamplingConfig, TraceSamplingDecision };
export { DEFAULT_TRACE_HEAD_RATE, isTraceHeadSampled, resolveTraceSampling, shouldExportTrace, traceIdToUnitInterval };
