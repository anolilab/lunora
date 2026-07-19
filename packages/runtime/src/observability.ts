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
 * Severity of a {@link LogEvent}. The five console tiers plus `trace`/`fatal`,
 * so `ctx.log` spans the full OpenTelemetry severity ramp (`trace`→`fatal`) a
 * collector and the Cloud log viewer render.
 */
export type LogLevel = "debug" | "error" | "fatal" | "info" | "log" | "trace" | "warn";

/**
 * Structured, filterable key/value fields attached to a log line via
 * `ctx.log.info(message, fields)` or a bound `ctx.log.with(fields)` child. Sinks
 * map these to OTLP log-record attributes so a log pipeline can filter/index on
 * them (primitive values pass through; objects/arrays are JSON-encoded).
 */
export type LogFields = Record<string, unknown>;

/**
 * One application log line emitted from a function handler via `ctx.log`.
 *
 * Unlike {@link ObservabilityEvent} (one summary per dispatch), a `LogEvent`
 * is produced for each `ctx.log.*` call, carrying the human-readable `message`
 * (the args joined for display) plus the structured `args` array for sinks that
 * want the raw values. `functionPath` attributes the line to the handler that
 * emitted it; `shardKey`/`userId` mirror the dispatch context.
 *
 * This is how `ctx.log` reaches a destination in production: wire a sink's
 * {@link ObservabilitySink.onLog} and route it wherever you ship logs. In dev
 * the runtime also emits these to `console` so the CLI / Vite plugin can format
 * them in the terminal.
 */
export interface LogEvent {
    /** Raw arguments passed to the `ctx.log.*` call, in order. */
    args: unknown[];
    /**
     * Structured fields the caller attached via `ctx.log.info(message, fields)`
     * or a bound `ctx.log.with(fields)` child. Absent for a plain console-style
     * call. Sinks map these onto OTLP log-record attributes.
     */
    fields?: LogFields;
    /** Function path that emitted the line, e.g. `"messages:list"`. */
    functionPath: string;
    /** Severity the line was logged at. */
    level: LogLevel;
    /** Display string — the args rendered and space-joined. */
    message: string;
    /** Shard key for single-shard calls; absent for the unnamed root DO. */
    shardKey?: string;
    /**
     * Span id of the RPC this line was emitted under (the dispatch's server
     * span), so a sink can correlate the log record to its trace. Absent on
     * paths with no inbound trace context.
     */
    spanId?: string;
    /**
     * Trace id this line belongs to (the dispatch's W3C trace), threaded from the
     * inbound `traceparent`. Absent on paths with no inbound trace context.
     */
    traceId?: string;
    /** Wall-clock millis when the line was emitted. */
    ts: number;
    /** Acting userId, or absent when anonymous. */
    userId?: string;
}

/**
 * Per-event context handed to a sink alongside the event. Lets a sink register
 * background work (e.g. a telemetry POST) with the request's `ctx.waitUntil` so
 * it survives isolate teardown after the response returns. Absent (`undefined`
 * `waitUntil`) on paths with no request context (e.g. the in-process
 * `serverQuery` fast-path), where the sink falls back to fire-and-forget.
 */
export interface ObservabilitySinkContext {
    /** Keep a background promise alive past the response (the request's `ctx.waitUntil`). */
    waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * The hook contract. Methods are optional so a sink can opt into only the
 * events it cares about; the runtime no-ops the others.
 */
export interface ObservabilitySink {
    /** Invoked once per `ctx.log.*` call from a function handler. */
    onLog?: (event: LogEvent, context?: ObservabilitySinkContext) => void;
    /** Invoked once per dispatched RPC (single-shard or fan-out). */
    onRpc?: (event: ObservabilityEvent, context?: ObservabilitySinkContext) => void;
}

/**
 * Invoke `sink.onRpc` with the given event, swallowing any error the sink
 * throws. Use at the dispatch boundary; the runtime should never see a
 * sink-originating throw bubble up past this point. `context.waitUntil`, when
 * supplied, lets a network sink keep its send alive past the response.
 */
export const emitRpcEvent = (sink: ObservabilitySink | undefined, event: ObservabilityEvent, context?: ObservabilitySinkContext): void => {
    if (!sink?.onRpc) {
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
