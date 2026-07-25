/**
 * Built-in {@link ObservabilitySink} adapters.
 *
 * These are concrete, dependency-free sinks that ship telemetry to common
 * destinations without forcing users to write their own adapter. Every sink
 * here is workerd-compatible: they use only the global Fetch API and `console`
 * — no bundled SDKs, no Node built-ins.
 *
 * This module is the sink *registry*: which destinations exist and how each maps
 * a Lunora event onto its wire format. The OTLP wire format itself — encoders and
 * the gzip/POST transport — lives in `./otlp-export`, and OTLP resource detection
 * in `./resource-detect`, so growing one never crowds the others.
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
import type { OtlpAttribute, OtlpResourceAttributes } from "../../../shared/otlp";
import {
    encodeAttribute,
    encodeAttributes,
    mergeHeaders,
    OTLP_SEVERITY,
    OTLP_SPAN_KIND,
    otlpRandomHex,
    otlpUnixNano,
    wrapResourceLogs,
    wrapResourceMetrics,
    wrapResourceSpans,
} from "../../../shared/otlp";
import type { KeepAlive } from "../../../shared/otlp-batch";
import { createSignalBatcher } from "../../../shared/otlp-batch";
import type { LogEvent, MetricEvent, ObservabilityEvent, ObservabilitySink, ObservabilitySinkContext, SpanEvent } from "./observability";
import { otlpLogBody, otlpMetricBody, otlpPost, otlpSpanBody, otlpTraceBody } from "./otlp-export";

/** Shared shape for sinks that can be limited to error events only. */
interface OnlyErrorsOption {
    /** When true, only events with `ok === false` are forwarded. */
    onlyErrors?: boolean;
}

/** Returns true when the event should be skipped under an `onlyErrors` filter. */
const shouldSkip = (event: ObservabilityEvent, onlyErrors: boolean | undefined): boolean => onlyErrors === true && event.ok;

/**
 * Encode one RPC dispatch event as an OTLP `Span`.
 *
 * Returns the bare span, not a wrapped `ExportTraceServiceRequest`: the exporter
 * batches an invocation's spans into ONE envelope, so wrapping has to happen at
 * the export boundary rather than per event.
 */
const encodeRpcSpan = (event: ObservabilityEvent, endMs: number): unknown => {
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

    return {
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
 * Encode one user-created `ctx.trace` span as an OTLP `Span`.
 *
 * The counterpart to {@link encodeRpcSpan}: that encodes the one SERVER span per
 * dispatch, this encodes the spans a handler creates beneath it. The span
 * carries a real `parentSpanId`, so a collector nests it under its parent
 * (another `ctx.trace`, or the dispatch's own RPC span) rather than showing a
 * flat list of orphans.
 *
 * Attribute precedence follows {@link encodeSignalAttributes}. `events` and
 * `links` are omitted entirely when empty rather than sent as `[]`, keeping the
 * common span byte-identical to what this encoder produced before they existed.
 */
const encodeUserSpan = (event: SpanEvent): unknown => {
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

    if (event.events !== undefined && event.events.length > 0) {
        span.events = event.events.map((point) => {
            return {
                attributes: encodeAttributes(Object.fromEntries(Object.entries(point.attributes ?? {}).map(([key, value]) => [key, coerceFieldValue(value)]))),
                name: point.name,
                timeUnixNano: otlpUnixNano(point.ts),
            };
        });
    }

    if (event.links !== undefined && event.links.length > 0) {
        span.links = event.links.map((link) => {
            return {
                attributes: encodeAttributes(Object.fromEntries(Object.entries(link.attributes ?? {}).map(([key, value]) => [key, coerceFieldValue(value)]))),
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
const encodeMetric = (event: MetricEvent): unknown => {
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

/**
 * Encode one application log line as an OTLP `LogRecord`.
 *
 * A `ctx.log.event(...)` call additionally sets OTel's `eventName` — the
 * standard marker distinguishing a *structured event* (a named, machine-readable
 * occurrence whose attributes are the payload) from an ordinary human-readable
 * log line. Both the top-level `eventName` field (opentelemetry-proto ≥ 1.5) and
 * the `event.name` attribute (how every collector recognised events before that)
 * are emitted, so the record is understood by old and new pipelines alike.
 */
const encodeLogRecord = (event: LogEvent): unknown => {
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
        // Both spellings, deliberately: `eventName` is the proto ≥ 1.5 field, and
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
 * `otlpPost` below is the thin wrapper over it.
 */
const otlpSend = async (url: string, body: unknown, headers: Record<string, string>, keepAlive?: KeepAlive): Promise<void> => {
    try {
        const json = JSON.stringify(body);
        // `.catch` swallows any rejection so a failed export can never reject
        // into the dispatch path.
        const sent = (
            json.length < OTLP_GZIP_THRESHOLD
                ? fetch(url, { body: json, headers, method: "POST" })
                : gzipEncode(json).then((gz) => fetch(url, { body: gz, headers: { ...headers, "content-encoding": "gzip" }, method: "POST" }))
        ).then(
            () => undefined,
            () => {
                // Network error / non-OK response / gzip failure — intentionally ignored.
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
 * request context is present. Bodies past {@link OTLP_GZIP_THRESHOLD} are gzipped
 * (`Content-Encoding: gzip`) — standard OTLP/HTTP, which every collector (and the
 * Lunora cloud ingest) decodes.
 */
const otlpPost = (url: string, body: unknown, headers: Record<string, string>, context?: ObservabilitySinkContext): void => {
    // Detached by design — the caller is on the dispatch path. `otlpSend` already
    // swallows every failure, so the `.catch` is belt-and-braces for the linter's
    // floating-promise rule rather than a real error path.
    otlpSend(url, body, headers, context?.waitUntil).catch(() => undefined);
};

/** One buffered event, tagged with the signal it belongs to so a flush can group it. */
type BufferedSignal =
    | { event: LogEvent; kind: "log" }
    | { event: MetricEvent; kind: "metric" }
    | { endMs: number; event: ObservabilityEvent; kind: "rpc" }
    | { event: SpanEvent; kind: "span" };

/** The trace id an event belongs to, or `undefined` when it carries no trace context. */
const traceIdOf = (signal: BufferedSignal): string | undefined => {
    if (signal.kind === "metric") {
        return undefined;
    }

    return signal.event.traceId;
};

/**
 * Group a flush window by trace and apply the tail sampler, returning only the
 * signals that survive.
 *
 * Events with no trace id (a fan-out aggregation, a metric) are never grouped
 * and never dropped: there is no trace for the sampler to judge, and silently
 * discarding them would lose the one signal the caller explicitly recorded.
 */
const applyTailSampler = (signals: BufferedSignal[], tailSampler: TailSampler | undefined): BufferedSignal[] => {
    if (tailSampler === undefined) {
        return signals;
    }

    const byTrace = new Map<string, BufferedSignal[]>();
    const untraced: BufferedSignal[] = [];

    for (const signal of signals) {
        const traceId = traceIdOf(signal);

        if (traceId === undefined) {
            untraced.push(signal);

            continue;
        }

        const bucket = byTrace.get(traceId);

        if (bucket === undefined) {
            byTrace.set(traceId, [signal]);
        } else {
            bucket.push(signal);
        }
    }

    const kept = [...untraced];

    for (const [traceId, bucket] of byTrace) {
        let verdict: boolean;

        try {
            verdict = tailSampler({
                logs: bucket.filter((s): s is { event: LogEvent; kind: "log" } => s.kind === "log").map((s) => s.event),
                rpc: bucket.filter((s): s is { endMs: number; event: ObservabilityEvent; kind: "rpc" } => s.kind === "rpc").map((s) => s.event),
                spans: bucket.filter((s): s is { event: SpanEvent; kind: "span" } => s.kind === "span").map((s) => s.event),
                traceId,
            });
        } catch {
            // A throwing sampler must not silently delete telemetry — fail open.
            verdict = true;
        }

        if (verdict) {
            kept.push(...bucket);
        }
    }

    return kept;
};

/**
 * Run one event through its post-processor hook. A throwing hook keeps the event
 * unmodified rather than dropping it — a redaction bug should not silently delete
 * a service's telemetry, and the failure is more useful visible as un-redacted
 * data than invisible as absence.
 */
const postProcess = <T>(event: T, hook: ((event: T) => T | undefined) | undefined): T | undefined => {
    if (hook === undefined) {
        return event;
    }

    try {
        return hook(event);
    } catch {
        return event;
    }
};

/**
 * Post-process and encode one buffered signal, tagged with the OTLP endpoint
 * bucket it belongs to. `undefined` when the post-processor dropped it.
 */
const encodeSignal = (
    signal: BufferedSignal,
    postProcessor: OtlpPostProcessor | undefined,
): { bucket: "logs" | "metrics" | "spans"; encoded: unknown } | undefined => {
    if (signal.kind === "rpc") {
        const processed = postProcess(signal.event, postProcessor?.rpc);

        return processed === undefined ? undefined : { bucket: "spans", encoded: encodeRpcSpan(processed, signal.endMs) };
    }

    if (signal.kind === "span") {
        const processed = postProcess(signal.event, postProcessor?.span);

        return processed === undefined ? undefined : { bucket: "spans", encoded: encodeUserSpan(processed) };
    }

    if (signal.kind === "log") {
        const processed = postProcess(signal.event, postProcessor?.log);

        return processed === undefined ? undefined : { bucket: "logs", encoded: encodeLogRecord(processed) };
    }

    const processed = postProcess(signal.event, postProcessor?.metric);

    return processed === undefined ? undefined : { bucket: "metrics", encoded: encodeMetric(processed) };
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

    /**
     * When true, `fields` is written as a **JSON string** (`JSON.stringify`)
     * rather than a nested object. Defaults to `false` for back-compatibility.
     *
     * Turn it on when the destination Iceberg table types `fields` as a `string`
     * column so the archive stays queryable (R2 SQL can `LIKE`/compare a string
     * column, but not index into an arbitrarily-shaped struct). The reader
     * (`createPipelineLogReader`) parses such a JSON string back to an object on
     * read. Leave it off when the table types `fields` as a native struct.
     */
    serializeFields?: boolean;
}

/**
 * A sink that durably persists each `ctx.log` line to a Cloudflare Pipeline
 * (→ R2), so an app has a queryable log store WITHOUT the Cloud — read the
 * archived records back with R2 SQL. This is the durable counterpart to the
 * network {@link otlpSink}: where OTLP streams to a collector, this lands the
 * structured record (message, level, function path, fields, trace ids, shard,
 * user, timestamp) in object storage under the app's own account.
 *
 * **Written-column contract.** Each record is a flat object; this is the exact
 * read-side schema `createPipelineLogReader` (`pipeline-log-reader.ts`) mirrors
 * in its `DEFAULT_LOG_COLUMNS`. Keep the two in lockstep — a column added here
 * must gain a default there:
 * - `functionPath` (string) — always present
 * - `level` (string severity) — always present
 * - `message` (string) — always present
 * - `ts` (number, epoch-millis) — always present
 * - `fields` (nested object, or a JSON string when `serializeFields`) — when set
 * - `shardKey` (string) — when set
 * - `userId` (string) — when set
 * - `traceId` (string) — when set
 * - `spanId` (string) — when set
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
 * @param options Sink options: `pipeline` is the Cloudflare Pipeline binding;
 * `serializeFields` stores `fields` as a queryable JSON string.
 */
export const pipelineLogSink = (options: PipelineLogSinkOptions): ObservabilitySink => {
    const { pipeline, serializeFields } = options;

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
                    // `serializeFields` lands `fields` as a queryable JSON string
                    // column; otherwise it stays a nested object (native struct).
                    record.fields = serializeFields === true ? JSON.stringify(event.fields) : event.fields;
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

/**
 * Everything the exporter buffered for one flush window, grouped so a
 * {@link TailSampler} can judge a trace as a whole.
 *
 * This is what makes it *tail* sampling rather than another head decision: by
 * flush time the trace's spans have all settled, so "keep it if anything in it
 * was slow or failed" is answerable — which it is not at the moment the first
 * span starts.
 */
export interface TailSamplerInput {
    /** Log records emitted under this trace. */
    logs: LogEvent[];
    /** RPC (SERVER) dispatch events belonging to this trace. */
    rpc: ObservabilityEvent[];
    /** `ctx.trace` spans belonging to this trace. */
    spans: SpanEvent[];
    /** The trace's id, or `undefined` for events that carried no trace context. */
    traceId: string | undefined;
}

/**
 * Decide whether a whole trace is exported. Return `false` to drop it — spans,
 * logs, and all.
 *
 * Composes with head sampling rather than replacing it: head sampling (see
 * `shared/sampling.ts`) cheaply discards most traces before they cost anything,
 * and this makes the final call on what survived. The canonical policy — "keep
 * errors and slow requests, drop the rest" — needs both.
 */
export type TailSampler = (input: TailSamplerInput) => boolean;

/**
 * Last-chance transforms applied to each event immediately before encoding.
 *
 * Return `undefined` from any hook to drop that event entirely. This is the
 * redaction seam: attributes, log messages, and error strings can all carry user
 * input, and once a payload leaves for a third-party collector it is out of your
 * control. Doing it here rather than at each call site means one auditable place
 * to prove PII cannot escape.
 */
export interface OtlpPostProcessor {
    log?: (event: LogEvent) => LogEvent | undefined;
    metric?: (event: MetricEvent) => MetricEvent | undefined;
    rpc?: (event: ObservabilityEvent) => ObservabilityEvent | undefined;
    span?: (event: SpanEvent) => SpanEvent | undefined;
}

/** Batching knobs for {@link otlpSink}; pass `batch: false` to export each event immediately. */
export interface OtlpBatchOptions {
    /**
     * Flush this long after the first buffered event, as a backstop for contexts
     * with no invocation boundary. Default 200ms.
     */
    maxDelayMs?: number;
    /** Flush as soon as this many events are buffered. Default 512. */
    maxItems?: number;
}

/** Options for {@link otlpSink}. */
export interface OtlpSinkOptions extends OnlyErrorsOption {
    /**
     * Buffer events and export them as one request per signal instead of one
     * request per event (the default). Pass `false` to restore per-event POSTs.
     *
     * Batching is on by default because the alternative is a correctness problem,
     * not just an efficiency one: a Worker is capped at 50 (free) / 1000 (paid)
     * subrequests per invocation, so a well-instrumented handler exporting one
     * `fetch` per span can exhaust the budget its own business logic needs.
     */
    batch?: OtlpBatchOptions | false;

    /**
     * `deployment.environment.name` resource attribute — `production`,
     * `preview`, … Set it: without one, a preview deployment's errors are
     * indistinguishable from production's in the same collector.
     */
    deploymentEnvironment?: string;

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
     * Redact or drop events just before they are encoded — see
     * {@link OtlpPostProcessor}.
     */
    postProcessor?: OtlpPostProcessor;

    /** Extra resource attributes (`cloud.region`, a tenant id, …), merged last. */
    resourceAttributes?: Record<string, boolean | number | string>;

    /** `service.instance.id` resource attribute — distinguishes replicas. */
    serviceInstanceId?: string;

    /**
     * Value of the `service.name` resource attribute on every exported span and
     * log — the logical service the telemetry belongs to. Defaults to `lunora`.
     */
    serviceName?: string;

    /** `service.namespace` resource attribute — groups related services. */
    serviceNamespace?: string;

    /**
     * `service.version` resource attribute — the deployed build. This is what
     * makes "did the error rate rise with the last deploy?" answerable.
     */
    serviceVersion?: string;

    /**
     * Decide per trace, at flush time, whether it is exported — see
     * {@link TailSampler}. Requires batching (the default); ignored when
     * `batch: false`, because an unbuffered exporter has no trace to judge.
     */
    tailSampler?: TailSampler;

    /**
     * Value of the `service.namespace` resource attribute, useful when multiple
     * services share the same `service.name` under a tenant or team boundary.
     */
    serviceNamespace?: string;

    /**
     * Value of the `service.version` resource attribute (e.g. a git sha or
     * release tag).
     */
    serviceVersion?: string;

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
 * **Batched by default.** Events are buffered and shipped as one request per
 * signal at the invocation boundary (the runtime calls `flush` at the end of
 * every `fetch`/`queue`/`scheduled`/DO dispatch), rather than one `fetch` per
 * event. On Workers that is a correctness matter as much as an efficiency one —
 * the platform caps an invocation at 50 (free) / 1000 (paid) subrequests, and a
 * well-instrumented handler can otherwise spend that budget on telemetry.
 * Batching also enables real tail sampling: by flush time a trace has settled,
 * so `tailSampler` can keep it on "anything failed or ran slow". Pass
 * `batch: false` for the previous per-event behaviour.
 *
 * Every rejection is swallowed so a flaky collector never surfaces to the
 * caller, and each export is registered with the request's `context.waitUntil`
 * when present so it survives isolate teardown.
 *
 * Privacy: spans carry `error.type`/`error.message` and logs carry the rendered
 * `message`, which may include user input. Point `endpoint` only at a collector
 * you trust, and use `postProcessor` to redact before anything leaves.
 * @param options See {@link OtlpSinkOptions}.
 */
export const otlpSink = (options: OtlpSinkOptions): ObservabilitySink => {
    const { batch, endpoint, headers, onlyErrors, postProcessor, tailSampler, token } = options;

    const serviceName = options.serviceName ?? "lunora";

    // The resource every exported envelope carries, built once per sink.
    //
    // Per-request resource detection was deliberately dropped when batching
    // landed: a batch ships N events under ONE `Resource`, so attributes that
    // vary per request have nowhere to attach without keying batches by
    // resource identity. Static configuration is the honest shape for a batched
    // exporter.
    const resourceAttributes: OtlpResourceAttributes = {
        "telemetry.sdk.language": "nodejs",
        "telemetry.sdk.name": "lunora",
        ...(options.serviceVersion === undefined ? {} : { "service.version": options.serviceVersion }),
        ...(options.serviceNamespace === undefined ? {} : { "service.namespace": options.serviceNamespace }),
        ...(options.deploymentEnvironment === undefined ? {} : { "deployment.environment.name": options.deploymentEnvironment }),
        ...(options.serviceInstanceId === undefined ? {} : { "service.instance.id": options.serviceInstanceId }),
        ...(options.resourceAttributes ?? {}),
    };

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

    /** Ship one flush window: tail-sample, encode by signal, and POST at most one request per signal. */
    const exportBatch = async (signals: BufferedSignal[]): Promise<void> => {
        const kept = applyTailSampler(signals, tailSampler);

        const spans: unknown[] = [];
        const logRecords: unknown[] = [];
        const metrics: unknown[] = [];

        for (const signal of kept) {
            const encoded = encodeSignal(signal, postProcessor);

            if (encoded === undefined) {
                continue;
            }

            if (encoded.bucket === "spans") {
                spans.push(encoded.encoded);
            } else if (encoded.bucket === "logs") {
                logRecords.push(encoded.encoded);
            } else {
                metrics.push(encoded.encoded);
            }
        }

        // Three independent POSTs at most — one per OTLP signal endpoint, since
        // the protocol has no combined envelope. Sent concurrently: they are
        // unrelated, and serialising them would add a round-trip of tail latency
        // to the `waitUntil` for no benefit.
        await Promise.all([
            spans.length === 0 ? undefined : otlpSend(tracesUrl, wrapResourceSpans(spans, "@lunora/runtime", serviceName, resourceAttributes), mergedHeaders),
            logRecords.length === 0 ? undefined : otlpSend(logsUrl, wrapResourceLogs(logRecords, "@lunora/runtime", serviceName, resourceAttributes), mergedHeaders),
            metrics.length === 0 ? undefined : otlpSend(metricsUrl, wrapResourceMetrics(metrics, "@lunora/runtime", serviceName, resourceAttributes), mergedHeaders),
        ]);
    };

    if (batch === false) {
        // Unbatched: encode and POST each event on arrival. `tailSampler` is
        // inapplicable here (there is no buffered trace to judge) and documented
        // as such; `postProcessor` still applies.
        return {
            onLog: (event, context) => {
                const processed = postProcess(event, postProcessor?.log);

                if (processed !== undefined) {
                    otlpPost(logsUrl, wrapResourceLogs(encodeLogRecord(processed), "@lunora/runtime", serviceName, resourceAttributes), mergedHeaders, context);
                }
            },
            onMetric: (event, context) => {
                const processed = postProcess(event, postProcessor?.metric);

                if (processed !== undefined) {
                    otlpPost(metricsUrl, wrapResourceMetrics(encodeMetric(processed), "@lunora/runtime", serviceName, resourceAttributes), mergedHeaders, context);
                }
            },
            onRpc: (event, context) => {
                if (shouldSkip(event, onlyErrors)) {
                    return;
                }

                const processed = postProcess(event, postProcessor?.rpc);

                if (processed !== undefined) {
                    otlpPost(tracesUrl, wrapResourceSpans(encodeRpcSpan(processed, Date.now()), "@lunora/runtime", serviceName, resourceAttributes), mergedHeaders, context);
                }
            },
            onSpan: (event, context) => {
                const processed = postProcess(event, postProcessor?.span);

                if (processed !== undefined) {
                    otlpPost(tracesUrl, wrapResourceSpans(encodeUserSpan(processed), "@lunora/runtime", serviceName, resourceAttributes), mergedHeaders, context);
                }
            },
        };
    }

    const batcher = createSignalBatcher<BufferedSignal>({
        export: exportBatch,
        ...(batch?.maxDelayMs === undefined ? {} : { maxDelayMs: batch.maxDelayMs }),
        ...(batch?.maxItems === undefined ? {} : { maxItems: batch.maxItems }),
    });

    return {
        flush: (context) => {
            // Detached: `waitUntil` (threaded into the batcher) owns the lifetime,
            // and the drain swallows its own failures.
            batcher.flush(context?.waitUntil).catch(() => undefined);
        },
        onLog: (event, context) => {
            // Application log lines are buffered whole; `onlyErrors` scopes the
            // RPC span stream, not the developer's `ctx.log` output.
            batcher.add({ event, kind: "log" }, context?.waitUntil);
        },
        onMetric: (event, context) => {
            // Like logs and spans, a measurement the developer explicitly recorded
            // is never scoped by `onlyErrors`.
            batcher.add({ event, kind: "metric" }, context?.waitUntil);
        },
        onRpc: (event, context) => {
            if (shouldSkip(event, onlyErrors)) {
                return;
            }

            // `endMs` is captured on arrival, not at flush: the span's end time is
            // when the dispatch finished, and deriving it from the flush clock
            // would stretch every span by however long it sat in the buffer.
            batcher.add({ endMs: Date.now(), event, kind: "rpc" }, context?.waitUntil);
        },
        onSpan: (event, context) => {
            // `onlyErrors` scopes the RPC span stream; a handler that explicitly
            // instrumented a sub-operation always gets its span exported, the same
            // way `ctx.log` output is never scoped by it.
            batcher.add({ event, kind: "span" }, context?.waitUntil);
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
     * Fan one call out to every child that implements `method`.
     *
     * One helper rather than five near-identical loops: "invoke each child in
     * order, isolate its throws, and forward the per-event context" is a single
     * policy, not a per-signal one, and there is no reason for them to diverge.
     * Forwarding `context` matters — dropping the request's `waitUntil` would
     * silently degrade every wrapped network sink to fire-and-forget.
     *
     * Args are passed as a list because `flush(context)` takes the context in the
     * FIRST position while the four `on*(event, context)` hooks take it second;
     * a fixed `(event, context)` shape would hand `flush` an undefined context
     * and quietly break batching under `combineSinks`.
     */
    const fanOut = (method: "flush" | "onLog" | "onMetric" | "onRpc" | "onSpan", arguments_: unknown[]): void => {
        for (const sink of sinks) {
            const handler = sink[method] as ((...arguments__: unknown[]) => void) | undefined;

            if (!handler) {
                continue;
            }

            try {
                handler.apply(sink, arguments_);
            } catch {
                // Isolate failures so one bad sink doesn't starve the rest.
            }
        }
    };

    return {
        flush: (context?: ObservabilitySinkContext) => {
            // A child without a `flush` is skipped by `fanOut`, so combining a
            // batching sink with non-batching ones needs no special casing.
            fanOut("flush", [context]);
        },
        onLog: (event: LogEvent, context?: ObservabilitySinkContext) => {
            fanOut("onLog", [event, context]);
        },
        onMetric: (event: MetricEvent, context?: ObservabilitySinkContext) => {
            fanOut("onMetric", [event, context]);
        },
        onRpc: (event: ObservabilityEvent, context?: ObservabilitySinkContext) => {
            fanOut("onRpc", [event, context]);
        },
        onSpan: (event: SpanEvent, context?: ObservabilitySinkContext) => {
            fanOut("onSpan", [event, context]);
        },
    };
};

/**
 * Resource attribute bag used by OTLP exporters. Re-exported from `shared/otlp`
 * because {@link OtlpSinkOptions.resourceAttributes} is part of the public
 * surface — without a name for it, a caller cannot hoist a shared attribute bag
 * into a typed constant.
 */
export type { OtlpResourceAttributes } from "../../../shared/otlp";
