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
import type { ContextLogLevel, LogEvent, LogSinkContext } from "../../../shared/log-event";


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

export {type LogEvent} from "../../../shared/log-event";
export {type LogFields} from "../../../shared/log-fields";