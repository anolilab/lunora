/**
 * Built-in {@link ObservabilitySink} adapters.
 *
 * These are concrete, dependency-free sinks that ship telemetry to common
 * destinations without forcing users to write their own adapter. Every sink
 * here is workerd-compatible: they use only the global Fetch API and `console`
 * — no bundled SDKs, no Node built-ins.
 *
 * All sinks are defensive: a failing destination (network error, throwing
 * callback) is caught and swallowed so it can never break user-facing RPC
 * dispatch. The runtime's `emitRpcEvent` already wraps `onRpc` in a try/catch,
 * but these adapters also guard their own async work (e.g. a rejected `fetch`
 * promise) since that escapes the synchronous try/catch.
 *
 * Privacy note: an {@link ObservabilityEvent}'s `error.message` is the
 * human-readable error string and MAY contain user input. The
 * {@link webhookSink} ships the full event — including `error.message` — to a
 * third party. Scrub or redact before enabling it against an external service
 * if that is a concern.
 */
import { coerceFieldValue } from "../../../shared/log-fields";
import type { OtlpAttribute } from "../../../shared/otlp";
import {
    encodeAttribute,
    mergeHeaders,
    OTLP_SEVERITY,
    otlpRandomHex,
    otlpUnixNano,
    wrapResourceLogs,
    wrapResourceMetrics,
    wrapResourceSpans,
} from "../../../shared/otlp";
import type { LogEvent, MetricEvent, ObservabilityEvent, ObservabilitySink, ObservabilitySinkContext, SpanEvent } from "./observability";

/** Shared shape for sinks that can be limited to error events only. */
interface OnlyErrorsOption {
    /** When true, only events with `ok === false` are forwarded. */
    onlyErrors?: boolean;
}

/** Returns true when the event should be skipped under an `onlyErrors` filter. */
const shouldSkip = (event: ObservabilityEvent, onlyErrors: boolean | undefined): boolean => onlyErrors === true && event.ok;

/** Build the OTLP trace-export body for one RPC dispatch event. */
const otlpTraceBody = (event: ObservabilityEvent, serviceName: string, endMs: number): unknown => {
    const attributes = [encodeAttribute("lunora.function_path", event.functionPath), encodeAttribute("lunora.ok", event.ok)];

    if (event.shardKey !== undefined) {
        attributes.push(encodeAttribute("lunora.shard_key", event.shardKey));
    }

    if (event.error) {
        // `error.type` is the OTel semantic-convention key; keep the numeric
        // HTTP-ish status under the lunora namespace.
        attributes.push(encodeAttribute("error.type", event.error.code), encodeAttribute("lunora.error_status", event.error.status));
    }

    if (event.fanOut) {
        attributes.push(
            encodeAttribute("lunora.fanout.table", event.fanOut.table),
            encodeAttribute("lunora.fanout.shards", event.fanOut.shards),
            encodeAttribute("lunora.fanout.failed", event.fanOut.failed),
        );
    }

    const span = {
        attributes,
        endTimeUnixNano: otlpUnixNano(endMs),
        // SPAN_KIND_SERVER — a dispatched RPC is server-side request handling.
        kind: 2,
        name: event.functionPath,
        // Reuse the dispatch's trace context when the runtime set it (so this span
        // shares the id it propagated as `traceparent`); else mint fresh ids.
        spanId: event.spanId ?? otlpRandomHex(8),
        startTimeUnixNano: otlpUnixNano(endMs - event.durationMs),
        // STATUS_CODE_OK (1) / STATUS_CODE_ERROR (2).
        status: event.ok ? { code: 1 } : { code: 2, message: event.error?.message ?? "" },
        traceId: event.traceId ?? otlpRandomHex(16),
    };

    return wrapResourceSpans(span, "@lunora/runtime", serviceName);
};

/**
 * Build the OTLP attribute list shared by every signal: the reserved `lunora.*`
 * keys, then the caller's own attributes.
 *
 * Keyed by name so a caller key that collides with a reserved one **overrides**
 * it rather than emitting a duplicate `KeyValue` (which a collector resolves
 * ambiguously). That precedence is a wire contract, and it was previously
 * re-implemented in the span, log, and metric encoders — three copies of one
 * rule, free to drift apart. One implementation, asserted once.
 */
const encodeSignalAttributes = (
    reserved: { errorType?: string; functionPath: string; shardKey?: string; userId?: string },
    caller: Record<string, unknown> | undefined,
): OtlpAttribute[] => {
    const byKey = new Map<string, OtlpAttribute>([["lunora.function_path", encodeAttribute("lunora.function_path", reserved.functionPath)]]);

    if (reserved.shardKey !== undefined) {
        byKey.set("lunora.shard_key", encodeAttribute("lunora.shard_key", reserved.shardKey));
    }

    if (reserved.userId !== undefined) {
        byKey.set("lunora.user_id", encodeAttribute("lunora.user_id", reserved.userId));
    }

    if (reserved.errorType !== undefined) {
        // `error.type` is the OTel semantic-convention key.
        byKey.set("error.type", encodeAttribute("error.type", reserved.errorType));
    }

    // Caller values arrive pre-normalized to JSON-safe primitives;
    // `coerceFieldValue` re-applies for a sink fed a raw event.
    for (const [key, value] of Object.entries(caller ?? {})) {
        byKey.set(key, encodeAttribute(key, coerceFieldValue(value)));
    }

    return [...byKey.values()];
};

/**
 * Build the OTLP trace-export body for one user-created `ctx.trace` span.
 *
 * The counterpart to {@link otlpTraceBody}: that encodes the one SERVER span per
 * dispatch, this encodes the INTERNAL spans a handler creates beneath it. The
 * span carries a real `parentSpanId`, so a collector nests it under its parent
 * (another `ctx.trace`, or the dispatch's own RPC span) rather than showing a
 * flat list of orphans.
 *
 * Attribute precedence follows {@link encodeSignalAttributes}.
 */
const otlpSpanBody = (event: SpanEvent, serviceName: string): unknown => {
    const span = {
        attributes: encodeSignalAttributes(
            { errorType: event.error?.type, functionPath: event.functionPath, shardKey: event.shardKey, userId: event.userId },
            event.attributes,
        ),
        endTimeUnixNano: otlpUnixNano(event.startTs + event.durationMs),
        // Always SPAN_KIND_INTERNAL: only `ctx.trace` spans reach a sink. The
        // synthetic dispatch span is buffered for the Studio waterfall and never
        // exported, because the runtime already emits that dispatch to `onRpc` as
        // a SERVER span — encoding it here too would duplicate it in every trace.
        kind: 1,
        name: event.name,
        parentSpanId: event.parentSpanId,
        spanId: event.spanId,
        startTimeUnixNano: otlpUnixNano(event.startTs),
        // STATUS_CODE_OK (1) / STATUS_CODE_ERROR (2).
        status: event.ok ? { code: 1 } : { code: 2, message: event.error?.message ?? "" },
        traceId: event.traceId,
    };

    return wrapResourceSpans(span, "@lunora/runtime", serviceName);
};

/**
 * Build the OTLP metric-export body for one `ctx.metrics.*` measurement.
 *
 * One data point per call — the runtime does no pre-aggregation — so counters
 * and histograms are exported with **DELTA** temporality (`aggregationTemporality: 1`),
 * which tells the collector to sum successive exports rather than treat each as
 * a running total. A gauge has no temporality: it is a reading that replaces the
 * previous one.
 *
 * The histogram carries a single observation in one implicit bucket
 * (`explicitBounds: []`, `bucketCounts: ["1"]`) — a valid OTLP encoding that lets
 * the collector build the distribution from the stream of counts/sums, without
 * the runtime having to pick bucket boundaries for the user.
 */
const otlpMetricBody = (event: MetricEvent, serviceName: string): unknown => {
    const timeUnixNano = otlpUnixNano(event.ts);
    const attributes = encodeSignalAttributes({ functionPath: event.functionPath, shardKey: event.shardKey }, event.attributes);
    // `startTimeUnixNano` is deliberately omitted (it is optional). A delta point
    // covers `(startTimeUnixNano, timeUnixNano]`, so setting both to the same
    // instant would declare a zero-width aggregation window — which the
    // `deltatocumulative` processor and Prometheus remote-write paths treat as
    // invalid and may drop. Omitting it lets the collector infer the interval
    // from the previous export, which is what it does for a stream of deltas.
    const dataPoint = { asDouble: event.value, attributes, timeUnixNano };

    if (event.kind === "gauge") {
        return wrapResourceMetrics({ gauge: { dataPoints: [dataPoint] }, name: event.name }, "@lunora/runtime", serviceName);
    }

    if (event.kind === "histogram") {
        return wrapResourceMetrics(
            {
                histogram: {
                    aggregationTemporality: 1,
                    dataPoints: [
                        {
                            attributes,
                            bucketCounts: ["1"],
                            count: "1",
                            explicitBounds: [],
                            max: event.value,
                            min: event.value,
                            // `startTimeUnixNano` omitted for the same reason as
                            // the Sum data point above — see the comment there.
                            sum: event.value,
                            timeUnixNano,
                        },
                    ],
                },
                name: event.name,
            },
            "@lunora/runtime",
            serviceName,
        );
    }

    return wrapResourceMetrics(
        { name: event.name, sum: { aggregationTemporality: 1, dataPoints: [dataPoint], isMonotonic: true } },
        "@lunora/runtime",
        serviceName,
    );
};

/** Build the OTLP log-export body for one application log line. */
const otlpLogBody = (event: LogEvent, serviceName: string): unknown => {
    const logRecord: Record<string, unknown> = {
        // Caller-supplied structured fields become log-record attributes so a
        // pipeline can filter/index on them; precedence per `encodeSignalAttributes`.
        attributes: encodeSignalAttributes({ functionPath: event.functionPath, shardKey: event.shardKey, userId: event.userId }, event.fields),
        body: { stringValue: event.message },
        severityNumber: OTLP_SEVERITY[event.level],
        severityText: event.level.toUpperCase(),
        timeUnixNano: otlpUnixNano(event.ts),
    };

    // Correlate the log record to its dispatch span (OTLP `LogRecord.trace_id` /
    // `span_id`) when the runtime threaded the inbound trace context, so the
    // Cloud/collector links the line to its trace.
    if (event.traceId !== undefined) {
        logRecord.traceId = event.traceId;
    }

    if (event.spanId !== undefined) {
        logRecord.spanId = event.spanId;
    }

    return wrapResourceLogs(logRecord, "@lunora/runtime", serviceName);
};

/** POST an OTLP payload fire-and-forget, keeping it alive past the response when a request context is present. */
const otlpPost = (url: string, body: unknown, headers: Record<string, string>, context?: ObservabilitySinkContext): void => {
    try {
        // `.catch` swallows any rejection so a failed export can never reject
        // into the dispatch path.
        const sent = fetch(url, { body: JSON.stringify(body), headers, method: "POST" }).catch(() => {
            // Network error / non-OK response — intentionally ignored.
        });

        if (context?.waitUntil) {
            context.waitUntil(sent);
        }
    } catch {
        // `fetch` throwing synchronously (e.g. an invalid URL) must not break dispatch.
    }
};

/**
 * A sink that logs each event via `console`.
 *
 * Useful as a zero-config default during development, or wired behind
 * {@link combineSinks} alongside a network sink. Successful events are logged
 * with `console.log`; error events (`ok === false`) with `console.error`.
 * @param options Sink options; set `onlyErrors` to log error events only.
 */
export const consoleSink = (options: OnlyErrorsOption = {}): ObservabilitySink => {
    const { onlyErrors } = options;

    return {
        onLog: (event) => {
            // `onlyErrors` filters the RPC summary stream; application log lines
            // are emitted whole so a developer still sees their `ctx.log` output.
            if (event.level === "error" || event.level === "fatal") {
                // eslint-disable-next-line no-console
                console.error("[lunora:log]", event.functionPath, event.message);
            } else {
                // eslint-disable-next-line no-console
                console.log("[lunora:log]", event.functionPath, event.message);
            }
        },
        onMetric: (event) => {
            // Measurements, like log lines, are the developer's own output and so
            // are never scoped by `onlyErrors`.
            // eslint-disable-next-line no-console
            console.log("[lunora:metric]", `${event.name}=${String(event.value)}`, event.kind, event.functionPath);
        },
        onRpc: (event) => {
            if (shouldSkip(event, onlyErrors)) {
                return;
            }

            if (event.ok) {
                // eslint-disable-next-line no-console
                console.log("[lunora:rpc]", event);
            } else {
                // eslint-disable-next-line no-console
                console.error("[lunora:rpc]", event);
            }
        },
        onSpan: (event) => {
            const status = event.ok ? "ok" : `error ${event.error?.type ?? ""}`.trim();

            // eslint-disable-next-line no-console
            console.log("[lunora:span]", event.name, `${String(event.durationMs)}ms`, status, event.functionPath);
        },
    };
};

/** Options for {@link webhookSink}. */
export interface WebhookSinkOptions extends OnlyErrorsOption {
    /**
     * Extra headers merged onto the POST. `Content-Type: application/json` is
     * set by default and may be overridden here (e.g. to add an
     * `Authorization` / API-key header for Axiom, Datadog, etc.).
     */
    headers?: Record<string, string>;

    /**
     * Optional redaction hook applied to each event immediately before it is
     * serialized and shipped. Use it to scrub or drop PII (e.g. strip
     * `error.message`) before it leaves the worker. Return the (possibly
     * modified) event to send, or `null`/`undefined` to drop the event
     * entirely. A throwing `transform` drops the event (fail-closed) so a buggy
     * redactor can never leak the un-scrubbed payload.
     */
    transform?: (event: ObservabilityEvent) => null | ObservabilityEvent | undefined;

    /**
     * Optional redaction hook for `ctx.log` events (the `transform`
     * counterpart for log lines). Same fail-closed contract: return the event to
     * ship it, `null`/`undefined` to drop it, and a throw drops it. When unset,
     * log events are shipped as-is (message + structured fields — which may carry
     * user input; see the privacy note).
     */
    transformLog?: (event: LogEvent) => LogEvent | null | undefined;
    /** The ingestion endpoint to POST each event to. */
    url: string;
}

/**
 * A fire-and-forget sink that POSTs each event as JSON to an HTTP endpoint.
 *
 * This covers Axiom, Datadog, and any generic webhook/log-ingestion service —
 * point `url` at the ingestion endpoint and supply auth via `headers`. Each
 * event is sent as its own `fetch`. When the runtime supplies a per-event
 * `context.waitUntil` (the request's `ctx.waitUntil`), the send is registered
 * with it so it survives isolate teardown after the response returns; otherwise
 * it degrades to fire-and-forget. Either way its rejection is swallowed so a
 * flaky endpoint never surfaces to the caller.
 *
 * Privacy: the full event is serialized, including `error.message`, which may
 * contain user input. See the module-level note. Pass a `transform` callback to
 * scrub or drop fields before they leave the worker.
 * @param options Sink options: `url` is the POST target, `headers` are merged
 * request headers (e.g. an API key), `onlyErrors` ships error events only, and
 * `transform` redacts/drops each event before send.
 */
export const webhookSink = (options: WebhookSinkOptions): ObservabilitySink => {
    const { headers, onlyErrors, transform, transformLog, url } = options;
    const mergedHeaders = mergeHeaders({ "content-type": "application/json" }, headers);

    /** POST one already-redacted payload, keeping the send alive past the response. */
    const post = (payload: unknown, context?: ObservabilitySinkContext): void => {
        try {
            const sent = fetch(url, { body: JSON.stringify(payload), headers: mergedHeaders, method: "POST" }).catch(() => {
                // Network error / non-OK response — intentionally ignored.
            });

            if (context?.waitUntil) {
                context.waitUntil(sent);
            }
        } catch {
            // `fetch` throwing synchronously (e.g. an invalid URL) must not break dispatch.
        }
    };

    return {
        onLog: (event, context) => {
            // `onlyErrors` scopes the RPC stream; `ctx.log` lines always ship, so
            // a developer's logs reach the endpoint even when RPC events are
            // filtered. Fail-closed on a throwing `transformLog`.
            let payload: LogEvent | null | undefined = event;

            if (transformLog) {
                try {
                    payload = transformLog(event);
                } catch {
                    return;
                }
            }

            if (payload === null || payload === undefined) {
                return;
            }

            post(payload, context);
        },
        onRpc: (event, context?: ObservabilitySinkContext) => {
            if (shouldSkip(event, onlyErrors)) {
                return;
            }

            try {
                let payload: null | ObservabilityEvent | undefined = event;

                if (transform) {
                    // Fail-closed: if the redactor throws we drop the event
                    // rather than ship the un-scrubbed original.
                    try {
                        payload = transform(event);
                    } catch {
                        return;
                    }
                }

                if (payload === null || payload === undefined) {
                    return;
                }

                post(payload, context);
            } catch {
                // A synchronous throw in the transform/guard path must not break dispatch.
            }
        },
    };
};

/** Options for {@link sentrySink}. */
export interface SentrySinkOptions extends OnlyErrorsOption {
    /**
     * User-supplied capture callback. Wire this to your Sentry client, e.g.
     * `(event) => Sentry.captureMessage(...)` or `captureException`. Kept as an
     * injected callback so the runtime takes no dependency on `@sentry/*`.
     */
    capture: (event: ObservabilityEvent) => void;

    /**
     * Optional callback for `ctx.log` events. Wire it to Sentry's structured
     * logging or a breadcrumb, e.g. `(e) => Sentry.logger[e.level]?.(e.message,
     * e.fields)`. Omit it to leave `ctx.log` lines out of Sentry entirely
     * (capturing every log line would usually flood the project). Invoked inside
     * a try/catch so a throwing client can't break the handler.
     */
    captureLog?: (event: LogEvent) => void;
}

/**
 * A thin adapter that forwards events to an injected `capture` callback.
 *
 * Intentionally does NOT bundle `@sentry/*`: the user wires their own Sentry
 * client (`captureException` / `captureMessage`) into `capture`, giving Sentry
 * parity without a hard dependency. The callback is invoked inside a try/catch
 * so a throwing client can't break dispatch.
 * @param options Sink options: `capture` is invoked per forwarded event;
 * `onlyErrors` defaults to true (error events only) — pass `false` for all.
 */
export const sentrySink = (options: SentrySinkOptions): ObservabilitySink => {
    const { capture, captureLog } = options;
    // Sentry defaults to error-only — capturing every successful RPC as an
    // event would flood the project. Callers opt into all events explicitly.
    const onlyErrors = options.onlyErrors ?? true;

    return {
        // Only forward log lines when the caller wired `captureLog`; otherwise
        // `ctx.log` output stays out of Sentry.
        onLog: captureLog
            ? (event) => {
                  try {
                      captureLog(event);
                  } catch {
                      // A throwing capture callback must not break the handler.
                  }
              }
            : undefined,
        onRpc: (event) => {
            if (shouldSkip(event, onlyErrors)) {
                return;
            }

            try {
                capture(event);
            } catch {
                // A throwing capture callback must not break dispatch.
            }
        },
    };
};

/** One Analytics Engine data point — the structural subset {@link analyticsEngineSink} writes. */
export interface AnalyticsEngineDataPointLike {
    /** Free-form string dimensions (≤20, ≤5120 bytes total). */
    blobs?: (null | string)[];
    /** Numeric metrics (≤20). */
    doubles?: number[];
    /** Sampling key(s) — Analytics Engine accepts a single index (≤96 bytes). */
    indexes?: (null | string)[];
}

/**
 * The Cloudflare Analytics Engine dataset binding surface this sink needs — the
 * `env` binding declared in `wrangler.jsonc` under `analytics_engine_datasets`.
 * Typed structurally so the runtime takes no dependency on
 * `@cloudflare/workers-types`.
 */
export interface AnalyticsEngineDatasetLike {
    writeDataPoint: (point: AnalyticsEngineDataPointLike) => void;
}

/** Options for {@link analyticsEngineSink}. */
export interface AnalyticsEngineSinkOptions extends OnlyErrorsOption {
    /** The Analytics Engine dataset binding to write each event to. */
    dataset: AnalyticsEngineDatasetLike;
}

/**
 * A sink that writes each event to a Cloudflare Analytics Engine dataset.
 *
 * Analytics Engine is the platform's unbounded-cardinality, sampled time-series
 * store — the natural backing for high-volume RPC observability metrics, queried
 * later over SQL. Prefer it over rolling your own counters table for anything
 * that doesn't need to be exact. Each event maps to one data point.
 *
 * indexes: `[functionPath]` — the sampling key, so Analytics Engine samples per
 * function rather than globally.
 *
 * blobs (string dimensions): `[functionPath, ok-or-error, shardKey, error.code,
 * fanOut.table]` — group/filter dimensions; absent fields are the empty string.
 *
 * doubles (numeric metrics): `[durationMs, errorCount, fanOut.shards,
 * fanOut.failed]` where errorCount is 0 or 1 — so `SUM(double2)` is the error
 * count and `AVG(double1)` the latency.
 *
 * `writeDataPoint` is fire-and-forget on the platform; the call is still wrapped
 * in a try/catch so a missing/throwing binding can never break dispatch.
 * @param options Sink options: `dataset` is the AE binding; `onlyErrors` writes
 * only error events (defaults to all events).
 */
export const analyticsEngineSink = (options: AnalyticsEngineSinkOptions): ObservabilitySink => {
    const { dataset, onlyErrors } = options;

    return {
        onRpc: (event) => {
            if (shouldSkip(event, onlyErrors)) {
                return;
            }

            try {
                dataset.writeDataPoint({
                    blobs: [event.functionPath, event.ok ? "ok" : "error", event.shardKey ?? "", event.error?.code ?? "", event.fanOut?.table ?? ""],
                    doubles: [event.durationMs, event.ok ? 0 : 1, event.fanOut?.shards ?? 0, event.fanOut?.failed ?? 0],
                    indexes: [event.functionPath],
                });
            } catch {
                // A missing or throwing dataset binding must not break dispatch.
            }
        },
    };
};

/**
 * The Cloudflare Pipeline binding surface {@link pipelineLogSink} needs — the
 * `env` binding declared in `wrangler.jsonc` under `pipelines`. Typed
 * structurally (mirrors `@lunora/bindings/pipelines`' `PipelineBindingLike`) so
 * the runtime takes no dependency on `@lunora/bindings` or `@cloudflare/workers-types`.
 */
export interface PipelineLike {
    /** Durably ingest a batch of records (buffered to R2, read back later with R2 SQL). */
    send: (records: Record<string, unknown>[]) => Promise<void>;
}

/** Options for {@link pipelineLogSink}. */
export interface PipelineLogSinkOptions {
    /** The Cloudflare Pipeline binding each log record is durably sent to. */
    pipeline: PipelineLike;
}

/**
 * A sink that durably persists each `ctx.log` line to a Cloudflare Pipeline
 * (→ R2), so an app has a queryable log store WITHOUT the Cloud — read the
 * archived records back with R2 SQL. This is the durable counterpart to the
 * network {@link otlpSink}: where OTLP streams to a collector, this lands the
 * structured record (message, level, function path, fields, trace ids, shard,
 * user, timestamp) in object storage under the app's own account.
 *
 * Only `onLog` is implemented — RPC-span metrics belong in
 * {@link analyticsEngineSink}. `Pipeline.send` is durable/fire-and-forget on the
 * platform; the call is registered with the request's `context.waitUntil` when
 * present (the DO threads its `state.waitUntil`) so the send survives isolate
 * teardown, and every rejection is swallowed so a flaky pipeline never surfaces
 * to the caller.
 *
 * Privacy: the persisted record carries `message` + structured `fields` (not the
 * raw positional args). They may include user input — the R2 bucket is your own,
 * but treat it as a log store and gate PII upstream if that is a concern.
 * @param options Sink options: `pipeline` is the Cloudflare Pipeline binding.
 */
export const pipelineLogSink = (options: PipelineLogSinkOptions): ObservabilitySink => {
    const { pipeline } = options;

    return {
        onLog: (event, context) => {
            try {
                const record: Record<string, unknown> = {
                    functionPath: event.functionPath,
                    level: event.level,
                    message: event.message,
                    ts: event.ts,
                };

                if (event.fields) {
                    record.fields = event.fields;
                }

                if (event.shardKey !== undefined) {
                    record.shardKey = event.shardKey;
                }

                if (event.userId !== undefined) {
                    record.userId = event.userId;
                }

                if (event.traceId !== undefined) {
                    record.traceId = event.traceId;
                }

                if (event.spanId !== undefined) {
                    record.spanId = event.spanId;
                }

                // `.catch` swallows any rejection so a failed send can never reject
                // into the handler path.
                const sent = pipeline.send([record]).catch(() => {
                    // Delivery error — intentionally ignored.
                });

                if (context?.waitUntil) {
                    context.waitUntil(sent);
                }
            } catch {
                // A missing or throwing pipeline binding must not break the handler.
            }
        },
    };
};

/** Options for {@link otlpSink}. */
export interface OtlpSinkOptions extends OnlyErrorsOption {
    /**
     * The OTLP-over-HTTP collector base endpoint (e.g.
     * `https://collector.example.com`). Following the OTel base-endpoint
     * convention, the sink POSTs spans to `${endpoint}/v1/traces` and log
     * records to `${endpoint}/v1/logs`; a trailing slash is tolerated.
     */
    endpoint: string;

    /**
     * Extra headers merged onto every OTLP POST — typically an `Authorization`
     * bearer plus the `x-lunora-deployment` / `x-lunora-org` correlation headers
     * the platform injects at deploy. `Content-Type: application/json` is set by
     * default and may be overridden here.
     */
    headers?: Record<string, string>;

    /**
     * Value of the `service.name` resource attribute on every exported span and
     * log — the logical service the telemetry belongs to. Defaults to `lunora`.
     */
    serviceName?: string;

    /**
     * Convenience bearer token: when set, an `Authorization: Bearer` header
     * carrying it is added to every POST (overriding any authorization in
     * `headers`). Mirrors the container exporter so the platform can inject the
     * same `LUNORA_OTLP_TOKEN` into both. Leave unset for an unauthenticated collector.
     */
    token?: string;
}

/**
 * A fire-and-forget sink that exports telemetry over OTLP-over-HTTP (JSON).
 *
 * This is the single, standard wire contract both the worker and (via the
 * container exporter helper) container processes use, so telemetry from either
 * side lands in the same collector. Each RPC dispatch becomes one OTLP **span**
 * (`${endpoint}/v1/traces`) named after its `functionPath`, with start/end
 * derived from `durationMs` and status OK/ERROR; each `ctx.log.*` line becomes
 * one OTLP **log record** (`${endpoint}/v1/logs`). Spans and log records reuse
 * the dispatch's `traceId`/`spanId` (minted at dispatch entry and propagated to
 * the shard and any container as a `traceparent`), so a handler's logs, its RPC
 * span, and the container spans beneath it all stitch into one trace; ids are
 * only randomised on paths that carry no trace context.
 *
 * Like {@link webhookSink}, each export is its own `fetch`, registered with the
 * request's `context.waitUntil` when present so it survives isolate teardown,
 * and every rejection is swallowed so a flaky collector never surfaces to the
 * caller.
 *
 * Privacy: spans carry `error.type`/`error.message` and logs carry the rendered
 * `message`, which may include user input. Point `endpoint` only at a collector
 * you trust, and gate PII upstream if that is a concern.
 * @param options Sink options: `endpoint` is the collector base URL, `headers`
 * are merged onto every POST (auth + correlation), `serviceName` sets the
 * resource `service.name`, and `onlyErrors` exports error spans only.
 */
export const otlpSink = (options: OtlpSinkOptions): ObservabilitySink => {
    const { endpoint, headers, onlyErrors, token } = options;
    const serviceName = options.serviceName ?? "lunora";

    // Strip trailing slashes without a regex — a `/\/+$/`-style pattern trips
    // the ReDoS linter, and this runs once per sink construction anyway.
    let base = endpoint;

    while (base.endsWith("/")) {
        base = base.slice(0, -1);
    }

    const tracesUrl = `${base}/v1/traces`;
    const logsUrl = `${base}/v1/logs`;
    const metricsUrl = `${base}/v1/metrics`;
    // `token` is applied last (inside `mergeHeaders`) so it wins over any
    // authorization in `headers`, matching the container exporter's precedence.
    const mergedHeaders = mergeHeaders({ "content-type": "application/json" }, headers, token);

    return {
        onLog: (event, context) => {
            // Application log lines are exported whole; `onlyErrors` scopes the
            // RPC span stream, not the developer's `ctx.log` output.
            otlpPost(logsUrl, otlpLogBody(event, serviceName), mergedHeaders, context);
        },
        onMetric: (event, context) => {
            // Like logs and spans, a measurement the developer explicitly recorded
            // is never scoped by `onlyErrors`.
            otlpPost(metricsUrl, otlpMetricBody(event, serviceName), mergedHeaders, context);
        },
        onRpc: (event, context) => {
            if (shouldSkip(event, onlyErrors)) {
                return;
            }

            otlpPost(tracesUrl, otlpTraceBody(event, serviceName, Date.now()), mergedHeaders, context);
        },
        onSpan: (event, context) => {
            // `onlyErrors` scopes the RPC span stream; a handler that explicitly
            // instrumented a sub-operation always gets its span exported, the same
            // way `ctx.log` output is never scoped by it.
            otlpPost(tracesUrl, otlpSpanBody(event, serviceName), mergedHeaders, context);
        },
    };
};

/**
 * Combine several sinks into one that fans each event out to all of them.
 *
 * Each child sink is invoked in order; a throw from one does not prevent the
 * others from running (each call is individually guarded).
 * @param sinks The sinks to fan out to.
 */
export const combineSinks = (...sinks: ObservabilitySink[]): ObservabilitySink => {
    /**
     * Fan one event out to every child that implements `method`.
     *
     * One helper rather than four near-identical loops: "invoke each child in
     * order, isolate its throws, and forward the per-event context" is a single
     * policy, not a per-signal one, and there is no reason for the four to
     * diverge. Forwarding `context` matters — dropping the request's `waitUntil`
     * would silently degrade every wrapped network sink to fire-and-forget.
     */
    const fanOut = (method: "onLog" | "onMetric" | "onRpc" | "onSpan", event: unknown, context?: ObservabilitySinkContext): void => {
        for (const sink of sinks) {
            const handler = sink[method] as ((event: unknown, context?: ObservabilitySinkContext) => void) | undefined;

            if (!handler) {
                continue;
            }

            try {
                handler.call(sink, event, context);
            } catch {
                // Isolate failures so one bad sink doesn't starve the rest.
            }
        }
    };

    return {
        onLog: (event: LogEvent, context?: ObservabilitySinkContext) => {
            fanOut("onLog", event, context);
        },
        onMetric: (event: MetricEvent, context?: ObservabilitySinkContext) => {
            fanOut("onMetric", event, context);
        },
        onRpc: (event: ObservabilityEvent, context?: ObservabilitySinkContext) => {
            fanOut("onRpc", event, context);
        },
        onSpan: (event: SpanEvent, context?: ObservabilitySinkContext) => {
            fanOut("onSpan", event, context);
        },
    };
};
