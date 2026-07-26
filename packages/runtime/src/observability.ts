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
import type { TraceSamplingConfig, TraceSamplingDecision } from "../../../shared/sampling";
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
    /** Host of the inbound request (e.g. `"api.example.com"`). */
    host?: string;
    /** HTTP method of the inbound request (e.g. `"POST"`). */
    method?: string;
    /** True when the dispatch completed without throwing. */
    ok: boolean;

    /**
     * Span id of the upstream caller extracted from the inbound `traceparent`,
     * when present. This becomes the OTLP `parentSpanId` for the dispatch span so
     * collector waterfalls show the worker span nested under the upstream caller.
     */
    parentSpanId?: string;
    /** URL path of the inbound request (e.g. `"/_lunora/rpc"`). */
    path?: string;
    /** Port of the inbound request, when available. */
    port?: number;
    /** URL scheme of the inbound request (e.g. `"https"`). */
    scheme?: string;

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

    /**
     * W3C trace flags for this dispatch (the sampled flag, bit 0). Carried from
     * the upstream `traceparent` or set by the runtime's head-sampling decision.
     */
    traceFlags?: number;

    traceId?: string;

    /** Inbound `User-Agent` header, when available. */
    userAgent?: string;
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
     * Ship anything the sink is holding, now.
     *
     * A batching sink (`otlpSink` by default) buffers events and exports them as
     * one request instead of one request per event. That is only safe because a
     * Workers isolate can be frozen the instant a response is returned: the
     * runtime calls this at every invocation boundary — end of `fetch`, `queue`,
     * `scheduled`, and each Durable Object dispatch — passing the request's
     * `waitUntil` so the export outlives the response.
     *
     * Optional and idempotent: a non-buffering sink simply omits it, and calling
     * it with an empty buffer is a no-op. A sink must never throw from here; like
     * every other hook, a telemetry failure must not surface to the caller.
     */
    flush?: (context?: ObservabilitySinkContext) => void;

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

    /**
     * How much detail automatic `ctx.db` instrumentation produces.
     *
     * `"summary"` (**default**) — aggregate counters (`db.calls`, `db.duration_ms`,
     * per-operation counts) folded onto the dispatch's wide event. No extra spans
     * and no extra log records, so the cost is flat no matter how many queries a
     * handler makes.
     *
     * `"spans"` — one span per database call: the full waterfall, for when you are
     * chasing a specific slow query. Capped per dispatch so a query loop cannot
     * bury the trace; truncation is reported as `db.spans_truncated`.
     *
     * `"off"` — no database telemetry.
     *
     * Applies only when a sink is configured; with none, `ctx.db` is untouched.
     */
    instrumentDatabase?: "off" | "spans" | "summary";

    /**
     * **Opt-in, default `false`.** Durable per-minute rollups of every
     * `ctx.metrics.*` measurement, kept in a reserved per-shard SQLite table so the
     * Studio can chart a 24h local trend without an external collector.
     *
     * Off by default because it is **not free**: each `ctx.metrics.count/gauge/record`
     * becomes a durable SQLite write (a billed, rate-limited storage op that competes
     * with your app's own data for the shard's write budget), on the request path. The
     * live cross-instance path is `onMetric` → your collector; this is only the local
     * trend convenience, so enable it deliberately.
     *
     * `true` uses the built-in caps (≈24h retention, 1000 distinct series). Pass an
     * object to tune them: `maxSeries` bounds the distinct series tracked (a
     * high-cardinality attribute otherwise mints a series per value), `retentionBuckets`
     * the minute-buckets kept per series before older ones are trimmed.
     *
     * Pass this on the SAME sink object you give `createShardDO` — the DO reads it
     * when recording a measurement.
     */
    // keep in sync with MetricHistoryOptions (`@lunora/do`'s `metric-history.ts`).
    // Inlined rather than imported so this public runtime type stays free of a
    // (type) dependency on `@lunora/do`'s internal module — the object is the same
    // `{ maxSeries?, retentionBuckets? }` the DO consumes.
    metricHistory?: boolean | { maxSeries?: number; retentionBuckets?: number };

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

    /**
     * Whether `ctx.fetch` is instrumented: each outbound call becomes a **CLIENT
     * span**, and a W3C `traceparent` naming that span is injected so the callee's
     * spans join this trace instead of starting a disconnected one. Default `true`
     * whenever a sink is configured.
     *
     * Set `false` for the bare platform `fetch` (no span, no header). Pass
     * `{ propagate }` to keep the spans but control who receives trace context, e.g.
     * `propagate: (url) => url.host.endsWith(".internal")` to send it to your own
     * services and not to third parties.
     */
    traceFetch?: boolean | { propagate?: ((url: URL) => boolean) | boolean };
}

/**
 * Invoke `sink.onRpc` with the given event, swallowing any error the sink
 * throws. Use at the dispatch boundary; the runtime should never see a
 * sink-originating throw bubble up past this point. `context.waitUntil`, when
 * supplied, lets a network sink keep its send alive past the response.
 *
 * The verdict applied to this dispatch's SERVER span comes from `decision` when
 * the caller settled one — pass the dispatch's already-settled decision so the
 * export gate can never disagree with the propagated `traceparent` (a trace kept
 * or dropped as a whole, per PR #191). Its `isTraced` must carry the propagated
 * sampled bit (`trace.sampled`), not the raw head verdict, so a trusted upstream
 * that sampled the trace out keeps its SERVER span out here too. The event is
 * dropped unless the trace was sampled or (with errors force-kept) this dispatch
 * errored — the tail bias.
 *
 * `sampling` is the legacy fallback for callers with no settled decision: it
 * re-derives the verdict from `event.traceId`. A dispatch with no `traceId` (a
 * fan-out aggregation, which mints none) is always kept, and both an absent
 * `decision` and an absent `sampling` keep everything, so all are
 * backward-compatible.
 */
export const emitRpcEvent = (
    sink: ObservabilitySink | undefined,
    event: ObservabilityEvent,
    context?: ObservabilitySinkContext,
    sampling?: TraceSamplingConfig,
    decision?: TraceSamplingDecision,
): void => {
    if (!sink?.onRpc) {
        return;
    }

    if (decision !== undefined) {
        // Settled-verdict path: honor the decision the dispatch already made
        // (including a trusted upstream's sampled-out `00`), never re-derive it.
        if (!shouldExportTrace(decision, !event.ok)) {
            return;
        }
    } else if (sampling !== undefined && event.traceId !== undefined && !shouldExportTrace(resolveTraceSampling(sampling, event.traceId), !event.ok)) {
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

/**
 * Ask a sink to ship whatever it has buffered, swallowing any error — the same
 * failure model as {@link emitRpcEvent}. Call at every invocation boundary; a
 * sink without a `flush` is a no-op.
 */
export const flushSink = (sink: ObservabilitySink | undefined, context?: ObservabilitySinkContext): void => {
    if (!sink?.flush) {
        return;
    }

    try {
        sink.flush(context);
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
