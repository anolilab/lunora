/**
 * Shared, bundler-inlined contract for one application metric measurement
 * (`ctx.metrics.*`).
 *
 * The same split as {@link file://./log-event.ts} and
 * {@link file://./span-event.ts}: `@lunora/do` builds these events and hands
 * them to a `@lunora/runtime` `ObservabilitySink.onMetric`, with no runtime
 * dependency edge between the two packages. Keep genuinely zero-dependency so
 * inlining stays sound.
 */
import type { LogFields } from "./log-fields";

/**
 * What kind of instrument produced a measurement, which decides how a collector
 * aggregates it:
 *
 * - `counter` — a monotonic delta to add up (requests, retries, bytes sent).
 * - `gauge` — a point-in-time reading that replaces the last one (queue depth,
 *   cache size).
 * - `histogram` — a value whose *distribution* matters (latency, payload size),
 *   giving percentiles rather than just a mean.
 */
export type MetricKind = "counter" | "gauge" | "histogram";

/**
 * One measurement recorded from a function handler.
 *
 * Each `ctx.metrics.*` call produces exactly one of these — the runtime does no
 * pre-aggregation, so counters carry **delta** temporality and a collector sums
 * them. That keeps the sink model identical to logs and spans (one event, one
 * export) at the cost of chattiness in a hot loop, where the handler should sum
 * locally and record once.
 */
export interface MetricEvent {
    /**
     * Structured attributes the caller attached, normalized to a fresh bag of
     * JSON-safe primitives (see `shared/log-fields.ts`). These are the metric's
     * dimensions — keep them low-cardinality; an id-valued attribute creates a
     * distinct time series per id.
     *
     * Caller-controlled, so they MAY contain user input and they DO egress to
     * whatever destination the sink ships to — the same caveat as a log line's
     * `fields` and a span's `error.message`. Scrub upstream if that matters.
     */
    attributes?: LogFields;
    /** Function path that recorded the measurement, e.g. `"orders:checkout"`. */
    functionPath: string;
    /** Instrument kind; see {@link MetricKind}. */
    kind: MetricKind;
    /** Instrument name, e.g. `"orders.placed"`. */
    name: string;
    /** Shard key for single-shard calls; absent for the unnamed root DO. */
    shardKey?: string;
    /**
     * Trace id of the dispatch that recorded this measurement, when it ran inside
     * one — the measurement's **exemplar**, letting a consumer jump from a metric
     * point to a trace that produced it (OpenTelemetry's exemplar model). Stamped
     * by the shard from the current request's trace context, not by the caller.
     */
    traceId?: string;
    /** Wall-clock millis when the measurement was recorded. */
    ts: number;
    /**
     * The measured value: the increment for a `counter`, the current reading for
     * a `gauge`, the observed sample for a `histogram`.
     */
    value: number;
}
