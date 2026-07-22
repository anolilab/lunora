/**
 * Observability hooks for the Lunora runtime.
 *
 * A user-supplied {@link ObservabilitySink} receives one event per dispatched
 * RPC (single-shard forward or fan-out). The runtime is otherwise oblivious
 * to where the telemetry goes — adapters that forward to Cloudflare Analytics
 * Engine, OTLP-over-HTTP, Sentry, or stdout all implement the same shape.
 *
 * Failure model: the sink callback is wrapped in a try/catch so a faulty
 * adapter never breaks user-facing RPC dispatch. Errors thrown from inside
 * the sink are swallowed (they would otherwise replace a useful user-visible
 * error with a telemetry-pipeline failure).
 */

/* eslint-disable no-secrets/no-secrets -- the entropy heuristic flags a CamelCase sink-context type name quoted in a doc comment below, not a credential */
import type { ContextLogLevel, LogEvent, LogSinkContext } from "../../../shared/log-event";
import type { MetricEvent } from "../../../shared/metric-event";
import type { TraceSamplingConfig } from "../../../shared/sampling";
import { resolveTraceSampling, shouldExportTrace } from "../../../shared/sampling";
import type { SpanEvent } from "../../../shared/span-event";

/**
 * Per-RPC dispatch event. Single-shard calls set `shardKey`; cross-shard
 * fan-outs set `fanOut` with the table being aggregated, shard count, and
 * per-shard failure count.
 */
export interface ObservabilityEvent {
    /** Wall-clock duration of the dispatch, in milliseconds. */
    durationMs: number;

    /**
     * Populated on `ok === false`. `code`/`status` mirror the LunoraError
     * taxonomy; `message` is the human-readable string (may include user
     * input — sinks that ship to third parties should scrub it).
     */
    error?: {
        code: string;
        message: string;
        status: number;
    };

    /**
     * Populated for fan-out dispatches.
     * `shards` is the total fan-out cardinality; `failed` counts shards that
     * timed out or returned an error (the same `errors[]` the response body
     * carries to the caller).
     */
    fanOut?: {
        failed: number;
        shards: number;
        table: string;
    };
    /** Function path being invoked, e.g. `"messages:list"`. */
    functionPath: string;
    /** True when the dispatch completed without throwing. */
    ok: boolean;
    /** Shard key for single-shard calls; absent for fan-outs. */
    shardKey?: string;

    /**
     * W3C trace context for this dispatch, generated once at dispatch entry (32-
     * and 16-hex). A sink (e.g. `otlpSink`) reuses these for the dispatch's span
     * instead of minting fresh ids, and the runtime propagates them to the shard
     * as a `traceparent` so a container the handler calls can stitch its spans
     * under the same trace. Absent on paths that don't originate a trace (a sink
     * falls back to random ids).
     */
    spanId?: string;
    traceId?: string;
}

/**
 * The `ctx.log` observability contract lives in `shared/` (inlined into each
 * `dist`) so the DO that builds the events and the runtime sink that consumes
 * them agree by construction rather than by hand-mirrored duplication. Re-exported
 * here under the runtime's historical names.
 *
 * `LogLevel` is the canonical `ctx.log` severity union (the five console tiers
 * plus `trace`/`fatal`); `ObservabilitySinkContext` is the shared per-event sink
 * context (a `waitUntil` to keep a background send alive past the response).
 */
export type LogLevel = ContextLogLevel;
export type ObservabilitySinkContext = LogSinkContext;

/**
 * The hook contract. Methods are optional so a sink can opt into only the
 * events it cares about; the runtime no-ops the others.
 */
export interface ObservabilitySink {
    /**
     * **Opt-in, EXPERIMENTAL, default `false`.** When `true`, each `ctx.trace`
     * span the Durable Object records is ALSO emitted as a Cloudflare **custom
     * span** (`tracing.enterSpan` from `cloudflare:workers`, GA 2026-06-16) so it
     * nests inside CF's native binding/fetch/handler trace tree on the hosted
     * path — a deeper waterfall in Cloudflare's own trace viewer.
     *
     * Capability-probed: a safe no-op off-Cloudflare, on a compat date predating
     * custom spans, or when the trace is unsampled. This ONLY ADDS a CF-side span;
     * it never replaces {@link ObservabilitySink.onSpan}, which stays the source
     * of truth and drives the local studio waterfall.
     *
     * **Workerd-validated (partial).** The `tracing.enterSpan` bridge is confirmed
     * available and side-effect-free inside a real Durable Object under
     * `@cloudflare/vitest-pool-workers` — the body runs without throwing,
     * `span.isTraced` is a real boolean, and `onSpan`'s recorded tree is byte-for-byte
     * identical with the flag on vs off. Still EXPERIMENTAL because the harness is
     * unsampled (`isTraced === false`), so CF's own EXPORTED parent-linking of the
     * custom span under the DO's ambient span is not yet observable there.
     *
     * **Double-export caveat.** Leave this off unless you understand the trade:
     * with it on, a deployment that also ships `onSpan` to a collector via
     * `otlpSink` AND lets Cloudflare export its trace tree will emit the same
     * logical span down two pipelines. Enable it only when you want the CF-native
     * nesting and have accounted for that overlap.
     *
     * Pass this on the SAME sink object you give both `createWorker` and
     * `createShardDO` — the DO reads the flag when building `ctx.trace`.
     */
    fuseCloudflareTraces?: boolean;

    /** Invoked once per `ctx.log.*` call from a function handler. */
    onLog?: (event: LogEvent, context?: ObservabilitySinkContext) => void;

    /**
     * Invoked once per `ctx.metrics.*` measurement. No pre-aggregation happens
     * upstream, so counter values are deltas for the destination to sum.
     */
    onMetric?: (event: MetricEvent, context?: ObservabilitySinkContext) => void;
    /** Invoked once per dispatched RPC (single-shard or fan-out). */
    onRpc?: (event: ObservabilityEvent, context?: ObservabilitySinkContext) => void;

    /**
     * Invoked once per `ctx.trace(name, fn)` span, when the span body settles.
     * Distinct from `onRpc`: that is the one SERVER span per dispatch, this is the
     * INTERNAL spans a handler creates beneath it.
     */
    onSpan?: (event: SpanEvent, context?: ObservabilitySinkContext) => void;
}

/**
 * Invoke `sink.onRpc` with the given event, swallowing any error the sink
 * throws. Use at the dispatch boundary; the runtime should never see a
 * sink-originating throw bubble up past this point. `context.waitUntil`, when
 * supplied, lets a network sink keep its send alive past the response.
 *
 * `sampling` applies the trace-sampling verdict to this dispatch's SERVER span:
 * the event is dropped unless the trace was head-sampled or (with errors
 * force-kept) this dispatch errored — the tail bias. A dispatch with no
 * `traceId` (a fan-out aggregation, which mints none) is always kept, and an
 * absent `sampling` keeps everything, so both are backward-compatible.
 */
export const emitRpcEvent = (
    sink: ObservabilitySink | undefined,
    event: ObservabilityEvent,
    context?: ObservabilitySinkContext,
    sampling?: TraceSamplingConfig,
): void => {
    if (!sink?.onRpc) {
        return;
    }

    if (sampling !== undefined && event.traceId !== undefined && !shouldExportTrace(resolveTraceSampling(sampling, event.traceId), !event.ok)) {
        return;
    }

    try {
        sink.onRpc(event, context);
    } catch {
        // Swallow — a buggy sink must not break user-facing dispatch. We
        // deliberately do not console.error here either: in a Workers runtime
        // that would propagate to the platform's error log and create the
        // same noise loop the swallow exists to avoid.
    }
};

/**
 * Invoke `sink.onLog` with the given log event, swallowing any error the sink
 * throws. The same failure model as {@link emitRpcEvent}: a buggy log sink must
 * never break the handler that emitted the line.
 */
export const emitLogEvent = (sink: ObservabilitySink | undefined, event: LogEvent, context?: ObservabilitySinkContext): void => {
    if (!sink?.onLog) {
        return;
    }

    try {
        sink.onLog(event, context);
    } catch {
        // Swallow — see emitRpcEvent.
    }
};

// NOTE: there is deliberately no `emitSpanEvent` / `emitMetricEvent` to mirror
// the two above. Spans and metrics originate in `@lunora/do`, which cannot
// import this package (the dependency edge runs the other way), and the runtime
// itself never emits them — so such helpers would have no possible caller. The
// DO applies the identical swallow inline in its own `recordSpan`/`recordMetric`.

export { type LogEvent } from "../../../shared/log-event";
export { type LogFields } from "../../../shared/log-fields";
export { type MetricEvent, type MetricKind } from "../../../shared/metric-event";
export { type TraceSamplingConfig } from "../../../shared/sampling";
export { type SpanEvent } from "../../../shared/span-event";
