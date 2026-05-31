/**
 * Observability hooks for the Cirrus runtime.
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
     * Populated on `ok === false`. `code`/`status` mirror the CirrusError
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
}

/**
 * The hook contract. Methods are optional so a sink can opt into only the
 * events it cares about; the runtime no-ops the others.
 */
export interface ObservabilitySink {
    /** Invoked once per dispatched RPC (single-shard or fan-out). */
    onRpc?: (event: ObservabilityEvent) => void;
}

/**
 * Invoke `sink.onRpc` with the given event, swallowing any error the sink
 * throws. Use at the dispatch boundary; the runtime should never see a
 * sink-originating throw bubble up past this point.
 */
export const emitRpcEvent = (sink: ObservabilitySink | undefined, event: ObservabilityEvent): void => {
    if (!sink?.onRpc) {
        return;
    }

    try {
        sink.onRpc(event);
    } catch {
        // Swallow — a buggy sink must not break user-facing dispatch. We
        // deliberately do not console.error here either: in a Workers runtime
        // that would propagate to the platform's error log and create the
        // same noise loop the swallow exists to avoid.
    }
};
