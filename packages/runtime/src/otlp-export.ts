/**
 * The OTLP-over-HTTP/JSON wire layer for `@lunora/runtime`: how a Lunora
 * observability event becomes an OTLP body, and how that body reaches a
 * collector.
 *
 * Split out of `observability-sinks.ts`, which is about *which sinks exist*
 * (console, webhook, Sentry, Analytics Engine, pipeline, OTLP) — a different
 * question from *how OTLP is spoken*. Only `otlpSink` consumes this module, so
 * the encoders can evolve against the OTLP spec without touching the sink
 * registry, and they are directly unit-testable without constructing a sink.
 *
 * The envelope encoding itself (`AnyValue`/`KeyValue`, severity numbers, the
 * `resourceSpans`/`resourceLogs`/`resourceMetrics` wrappers) lives one tier
 * further down in `shared/otlp.ts`, shared with `@lunora/container` so the worker
 * and container speak an identical wire format.
 */
import { coerceFieldValue } from "../../../shared/log-fields";
import type { OtlpAttribute, OtlpResourceAttributes } from "../../../shared/otlp";
import { encodeAttribute, OTLP_SEVERITY, otlpRandomHex, otlpUnixNano, wrapResourceLogs, wrapResourceMetrics, wrapResourceSpans } from "../../../shared/otlp";
import type { LogEvent, MetricEvent, ObservabilityEvent, ObservabilitySinkContext, SpanEvent } from "./observability";

/** Build the OTLP trace-export body for one RPC dispatch event. */
const otlpTraceBody = (event: ObservabilityEvent, serviceName: string, endMs: number, resourceAttributes?: OtlpResourceAttributes): unknown => {
    const attributes = [encodeAttribute("lunora.function_path", event.functionPath), encodeAttribute("lunora.ok", event.ok)];

    // HTTP server semantic conventions: the RPC endpoint is an HTTP handler from
    // the collector's point of view, so expose method/route/status even though
    // the transport path is fixed. `http.route` uses the Lunora function path
    // because that is the logical route being invoked.
    if (event.method !== undefined) {
        attributes.push(encodeAttribute("http.request.method", event.method));
    }

    if (event.path !== undefined) {
        attributes.push(encodeAttribute("url.path", event.path));
    }

    attributes.push(encodeAttribute("http.route", event.functionPath));

    if (event.scheme !== undefined) {
        attributes.push(encodeAttribute("url.scheme", event.scheme));
    }

    if (event.host !== undefined) {
        attributes.push(encodeAttribute("server.address", event.host));
    }

    if (event.port !== undefined) {
        attributes.push(encodeAttribute("server.port", event.port));
    }

    if (event.userAgent !== undefined) {
        attributes.push(encodeAttribute("user_agent.original", event.userAgent));
    }

    if (event.shardKey !== undefined) {
        attributes.push(encodeAttribute("lunora.shard_key", event.shardKey));
    }

    // HTTP response status code is present on every RPC span. Successful
    // dispatches carry no explicit status in the event, so we default to 200;
    // error events use the error's HTTP-ish status.
    attributes.push(encodeAttribute("http.response.status_code", event.error?.status ?? 200));

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

    const span: Record<string, unknown> = {
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

    if (event.parentSpanId !== undefined) {
        span.parentSpanId = event.parentSpanId;
    }

    if (event.traceFlags !== undefined) {
        span.flags = event.traceFlags;
    }

    // On error, record an OTel exception event with the standard `exception.*`
    // attributes. This gives collectors the canonical error representation.
    if (event.error) {
        span.events = [
            {
                attributes: [encodeAttribute("exception.type", event.error.code), encodeAttribute("exception.message", event.error.message)],
                name: "exception",
                timeUnixNano: otlpUnixNano(endMs),
            },
        ];
    }

    return wrapResourceSpans(span, "@lunora/runtime", serviceName, resourceAttributes);
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
const otlpSpanBody = (event: SpanEvent, serviceName: string, resourceAttributes?: OtlpResourceAttributes): unknown => {
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

    return wrapResourceSpans(span, "@lunora/runtime", serviceName, resourceAttributes);
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
const otlpMetricBody = (event: MetricEvent, serviceName: string, resourceAttributes?: OtlpResourceAttributes): unknown => {
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
        return wrapResourceMetrics({ gauge: { dataPoints: [dataPoint] }, name: event.name }, "@lunora/runtime", serviceName, resourceAttributes);
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
            resourceAttributes,
        );
    }

    return wrapResourceMetrics(
        { name: event.name, sum: { aggregationTemporality: 1, dataPoints: [dataPoint], isMonotonic: true } },
        "@lunora/runtime",
        serviceName,
        resourceAttributes,
    );
};

/** Build the OTLP log-export body for one application log line. */
const otlpLogBody = (event: LogEvent, serviceName: string, resourceAttributes?: OtlpResourceAttributes): unknown => {
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

    return wrapResourceLogs(logRecord, "@lunora/runtime", serviceName, resourceAttributes);
};

/** Above this serialized size, an OTLP body is gzipped; tiny single-span posts skip it (the CPU isn't worth the few saved bytes). */
const OTLP_GZIP_THRESHOLD = 1024;

/** Gzip a UTF-8 string to an `ArrayBuffer` (a `BodyInit`) via the platform `CompressionStream` (no dependency). */
const gzipEncode = async (text: string): Promise<ArrayBuffer> => {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));

    return new Response(stream).arrayBuffer();
};

/**
 * POST an OTLP payload fire-and-forget, keeping it alive past the response when a
 * request context is present. Bodies past {@link OTLP_GZIP_THRESHOLD} are gzipped
 * (`Content-Encoding: gzip`) — standard OTLP/HTTP, which every collector (and the
 * Lunora cloud ingest) decodes.
 */
const otlpPost = (url: string, body: unknown, headers: Record<string, string>, context?: ObservabilitySinkContext): void => {
    try {
        const json = JSON.stringify(body);
        // `.catch` swallows any rejection so a failed export can never reject
        // into the dispatch path.
        const sent = (
            json.length < OTLP_GZIP_THRESHOLD
                ? fetch(url, { body: json, headers, method: "POST" })
                : gzipEncode(json).then((gz) => fetch(url, { body: gz, headers: { ...headers, "content-encoding": "gzip" }, method: "POST" }))
        ).catch(() => {
            // Network error / non-OK response / gzip failure — intentionally ignored.
        });

        if (context?.waitUntil) {
            context.waitUntil(sent);
        }
    } catch {
        // `fetch` throwing synchronously (e.g. an invalid URL) must not break dispatch.
    }
};

export { encodeSignalAttributes, OTLP_GZIP_THRESHOLD, otlpLogBody, otlpMetricBody, otlpPost, otlpSpanBody, otlpTraceBody };
