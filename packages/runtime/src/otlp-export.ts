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
import type { OtlpAttribute } from "../../../shared/otlp";
import { encodeAttribute, encodeAttributes, LUNORA_ATTR, OTLP_SEVERITY, OTLP_SPAN_KIND, otlpRandomHex, otlpUnixNano } from "../../../shared/otlp";
import type { KeepAlive } from "../../../shared/otlp-batch";
import type { LogEvent, MetricEvent, ObservabilityEvent, ObservabilitySinkContext, SpanEvent } from "./observability";

/** Build the OTLP trace-export body for one RPC dispatch event. */
const otlpTraceBody = (event: ObservabilityEvent, endMs: number): unknown => {
    const attributes = [encodeAttribute(LUNORA_ATTR.functionPath, event.functionPath), encodeAttribute(LUNORA_ATTR.ok, event.ok)];

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
        attributes.push(encodeAttribute(LUNORA_ATTR.shardKey, event.shardKey));
    }

    // HTTP response status code is present on every RPC span. Successful
    // dispatches carry no explicit status in the event, so we default to 200;
    // error events use the error's HTTP-ish status.
    attributes.push(encodeAttribute("http.response.status_code", event.error?.status ?? 200));

    if (event.error) {
        // `error.type` is the OTel semantic-convention key; keep the numeric
        // HTTP-ish status under the lunora namespace.
        attributes.push(encodeAttribute(LUNORA_ATTR.errorType, event.error.code), encodeAttribute("lunora.error_status", event.error.status));
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
        kind: OTLP_SPAN_KIND.server,
        name: event.functionPath,
        // Set only when the worker joined an upstream trace; omitted otherwise, so
        // a self-originated dispatch stays the root rather than dangling off a
        // parent that was never exported.
        ...(event.parentSpanId === undefined ? {} : { parentSpanId: event.parentSpanId }),
        // Reuse the dispatch's trace context when the runtime set it (so this span
        // shares the id it propagated as `traceparent`); else mint fresh ids.
        spanId: event.spanId ?? otlpRandomHex(8),
        startTimeUnixNano: otlpUnixNano(endMs - event.durationMs),
        // STATUS_CODE_OK (1) / STATUS_CODE_ERROR (2).
        status: event.ok ? { code: 1 } : { code: 2, message: event.error?.message ?? "" },
        traceId: event.traceId ?? otlpRandomHex(16),
    };

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

    return span;
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
    const byKey = new Map<string, OtlpAttribute>([[LUNORA_ATTR.functionPath, encodeAttribute(LUNORA_ATTR.functionPath, reserved.functionPath)]]);

    if (reserved.shardKey !== undefined) {
        byKey.set(LUNORA_ATTR.shardKey, encodeAttribute(LUNORA_ATTR.shardKey, reserved.shardKey));
    }

    if (reserved.userId !== undefined) {
        byKey.set(LUNORA_ATTR.userId, encodeAttribute(LUNORA_ATTR.userId, reserved.userId));
    }

    if (reserved.errorType !== undefined) {
        // `error.type` is the OTel semantic-convention key.
        byKey.set(LUNORA_ATTR.errorType, encodeAttribute(LUNORA_ATTR.errorType, reserved.errorType));
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
const otlpSpanBody = (event: SpanEvent): unknown => {
    const span: Record<string, unknown> = {
        attributes: encodeSignalAttributes(
            { errorType: event.error?.type, functionPath: event.functionPath, shardKey: event.shardKey, userId: event.userId },
            event.attributes,
        ),
        endTimeUnixNano: otlpUnixNano(event.startTs + event.durationMs),
        // Defaults to SPAN_KIND_INTERNAL — right for the vast majority of
        // `ctx.trace` spans — but honours an explicit kind so a call OUT to another
        // service can be CLIENT and a queue hop PRODUCER/CONSUMER. That is what a
        // collector builds its service map from.
        kind: OTLP_SPAN_KIND[event.kind ?? "internal"],
        name: event.name,
        parentSpanId: event.parentSpanId,
        spanId: event.spanId,
        startTimeUnixNano: otlpUnixNano(event.startTs),
        // STATUS_CODE_OK (1) / STATUS_CODE_ERROR (2).
        status: event.ok ? { code: 1 } : { code: 2, message: event.error?.message ?? "" },
        traceId: event.traceId,
    };

    // Coerce each span event/link attribute value to a wire-safe scalar before encoding.
    const coercedAttributes = (bag: Record<string, unknown> | undefined): ReturnType<typeof encodeAttributes> =>
        encodeAttributes(Object.fromEntries(Object.entries(bag ?? {}).map(([key, value]) => [key, coerceFieldValue(value)])));

    if (event.events !== undefined && event.events.length > 0) {
        span.events = event.events.map((point) => {
            return {
                attributes: coercedAttributes(point.attributes),
                name: point.name,
                timeUnixNano: otlpUnixNano(point.ts),
            };
        });
    }

    if (event.links !== undefined && event.links.length > 0) {
        span.links = event.links.map((link) => {
            return {
                attributes: coercedAttributes(link.attributes),
                spanId: link.spanId,
                traceId: link.traceId,
            };
        });
    }

    return span;
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
const otlpMetricBody = (event: MetricEvent): unknown => {
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
        return { gauge: { dataPoints: [dataPoint] }, name: event.name };
    }

    if (event.kind === "histogram") {
        return {
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
        };
    }

    return { name: event.name, sum: { aggregationTemporality: 1, dataPoints: [dataPoint], isMonotonic: true } };
};

/** Build the OTLP log-export body for one application log line. */
const otlpLogBody = (event: LogEvent): unknown => {
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

    if (event.eventName !== undefined) {
        // Both spellings, deliberately: `eventName` is the proto >= 1.5 field, and
        // the `event.name` attribute is how every collector recognised events
        // before it. Emitting one or the other silently loses the event's identity
        // on half the pipelines in the wild.
        logRecord.eventName = event.eventName;
        (logRecord.attributes as OtlpAttribute[]).push(encodeAttribute("event.name", event.eventName));
    }

    return logRecord;
};

/** Above this serialized size, an OTLP body is gzipped; tiny single-span posts skip it (the CPU isn't worth the few saved bytes). */
const OTLP_GZIP_THRESHOLD = 1024;

/** How many rejected OTLP posts one isolate reports before it goes quiet. */
const MAX_OTLP_REJECTION_REPORTS = 5;

/** Rejections already reported by {@link reportOtlpRejection} in this isolate. */
let otlpRejectionReports = 0;

/**
 * Surface a collector that is REFUSING the export, at most
 * {@link MAX_OTLP_REJECTION_REPORTS} times per isolate.
 *
 * Mirrors the rate-limited `console.error` `otlpSink` already uses for a
 * throwing `tailSampler`, and for the same reason: without it, a wrong token
 * (401), a wrong path (404), or a collector rejecting the body (422) is
 * indistinguishable from a working pipeline — every post "succeeds", nothing is
 * ever logged, and the only symptom is telemetry that never arrives, on every
 * isolate, forever. Rate-limited because the failure is by definition on every
 * export, and an unbounded `console.error` in a Workers runtime is the noise
 * loop the batching pipeline exists to avoid.
 *
 * Only the status and the endpoint HOST are reported — never the response body
 * or the URL's path/query, either of which can echo credentials or user data
 * back into the platform log.
 */
const reportOtlpRejection = (url: string, status: number): void => {
    if (otlpRejectionReports >= MAX_OTLP_REJECTION_REPORTS) {
        return;
    }

    otlpRejectionReports += 1;

    let host: string;

    try {
        host = new URL(url).host;
    } catch {
        host = "<unparseable endpoint>";
    }

    const silencing = otlpRejectionReports === MAX_OTLP_REJECTION_REPORTS ? " Further OTLP rejections are silenced until the isolate restarts." : "";

    // eslint-disable-next-line no-console
    console.error(`[lunora:otlp] collector ${host} rejected the export with HTTP ${String(status)}; the batch is DROPPED (there is no retry).${silencing}`);
};

/** Gzip a UTF-8 string to an `ArrayBuffer` (a `BodyInit`) via the platform `CompressionStream` (no dependency). */
const gzipEncode = async (text: string): Promise<ArrayBuffer> => {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));

    return new Response(stream).arrayBuffer();
};

/**
 * POST an OTLP payload, gzipping bodies past {@link OTLP_GZIP_THRESHOLD}, and
 * never reject.
 *
 * The batcher needs the promise (its drain awaits the export before settling the
 * window it handed to `waitUntil`), while the unbatched paths only need
 * fire-and-forget — so this promise-returning form is the primitive and
 * {@link otlpPost} is the thin wrapper over it.
 *
 * **There is no retry, by design.** A Workers isolate can vanish between the
 * buffer and the network, so a retry queue would trade bounded, understandable
 * data loss for unbounded memory inside the request path; durability is the
 * collector's problem. A dropped batch is therefore permanently dropped — which
 * is exactly why a REJECTED post (a non-2xx status: bad token, wrong path,
 * unacceptable body) is reported once per isolate through
 * {@link reportOtlpRejection} rather than swallowed. A transport error stays
 * silent: it is the ordinary, self-healing failure, and it cannot be told apart
 * from a collector that is offline for a moment.
 */
const otlpSend = async (url: string, body: unknown, headers: Record<string, string>, keepAlive?: KeepAlive): Promise<void> => {
    try {
        const json = JSON.stringify(body);
        // Measure the UTF-8 byte length, not `json.length` (UTF-16 code units):
        // non-ASCII text (common in `error.message`) can exceed the threshold in
        // bytes while its code-unit count stays under, so a byte-length check is
        // what actually decides whether the wire body is worth gzipping.
        const { byteLength } = new TextEncoder().encode(json);
        const sent = (
            byteLength < OTLP_GZIP_THRESHOLD
                ? fetch(url, { body: json, headers, method: "POST" })
                : gzipEncode(json).then((gz) => fetch(url, { body: gz, headers: { ...headers, "content-encoding": "gzip" }, method: "POST" }))
        ).then(
            (response) => {
                if (!response.ok) {
                    reportOtlpRejection(url, response.status);
                }

                return undefined;
            },
            () => {
                // Network error / gzip failure — intentionally ignored: transient,
                // self-healing, and indistinguishable from a collector that is
                // offline for a moment. A REJECTION (handled above) is the durable
                // misconfiguration worth a line in the log.
            },
        );

        keepAlive?.(sent);

        await sent;
    } catch {
        // `fetch` throwing synchronously (e.g. an invalid URL) must not break dispatch.
    }
};

/**
 * POST an OTLP payload fire-and-forget, keeping it alive past the response when a
 * request context is present.
 */
const otlpPost = (url: string, body: unknown, headers: Record<string, string>, context?: ObservabilitySinkContext): void => {
    // Detached by design — the caller is on the dispatch path. `otlpSend` already
    // swallows every failure, so the `.catch` is for the floating-promise rule.
    otlpSend(url, body, headers, context?.waitUntil).catch(() => undefined);
};

export { encodeSignalAttributes, OTLP_GZIP_THRESHOLD, otlpLogBody, otlpMetricBody, otlpPost, otlpSend, otlpSpanBody, otlpTraceBody };
