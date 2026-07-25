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
import type { OtlpResourceAttributes } from "../../../shared/otlp";
import { mergeHeaders, wrapResourceLogs, wrapResourceMetrics, wrapResourceSpans } from "../../../shared/otlp";
import { createSignalBatcher } from "../../../shared/otlp-batch";
import { mergeResourceAttributes } from "../../../shared/otlp-resource";
import type { LogEvent, MetricEvent, ObservabilityEvent, ObservabilitySink, ObservabilitySinkContext, SpanEvent } from "./observability";
import { otlpLogBody, otlpMetricBody, otlpPost, otlpSend, otlpSpanBody, otlpTraceBody } from "./otlp-export";

/** Shared shape for sinks that can be limited to error events only. */
interface OnlyErrorsOption {
    /** When true, only events with `ok === false` are forwarded. */
    onlyErrors?: boolean;
}

/** Returns true when the event should be skipped under an `onlyErrors` filter. */
const shouldSkip = (event: ObservabilityEvent, onlyErrors: boolean | undefined): boolean => onlyErrors === true && event.ok;

/** One buffered event, tagged with its signal and the resource bag it was captured under. */
type BufferedSignal = (
    | { event: LogEvent; kind: "log" }
    | { event: MetricEvent; kind: "metric" }
    | { endMs: number; event: ObservabilityEvent; kind: "rpc" }
    | { event: SpanEvent; kind: "span" }
) & { resource: OtlpResourceAttributes };

/** The trace id an event belongs to, or `undefined` when it carries no trace context. */
const traceIdOf = (signal: BufferedSignal): string | undefined => (signal.kind === "metric" ? undefined : signal.event.traceId);

/**
 * Split a flush window into per-trace buckets plus the signals that carry no
 * trace context at all (a fan-out aggregation, a metric).
 */
const groupByTrace = (signals: BufferedSignal[]): { byTrace: Map<string, BufferedSignal[]>; untraced: BufferedSignal[] } => {
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

    return { byTrace, untraced };
};

/**
 * How many tail-sampler failures one sink instance reports before going quiet.
 *
 * A sampler that throws usually throws on every flush window, so an unbounded
 * warning would turn one bad predicate into a log stream of its own — the exact
 * cost tail sampling exists to control, and on a hot Worker it would outweigh
 * the telemetry it is complaining about. Five is enough to be unmissable in a
 * tail without ever being the loudest thing there; the count lives on the sink,
 * so a fresh isolate reports again and a persistently broken sampler stays
 * visible over time rather than being silenced permanently by the first burst.
 */
const MAX_TAIL_SAMPLER_FAILURE_REPORTS = 5;

/**
 * Group a flush window by trace and apply the tail sampler, returning only the
 * signals that survive.
 *
 * Events with no trace id are never grouped and never dropped: there is no trace
 * for the sampler to judge, and silently discarding them would lose the one
 * signal the caller explicitly recorded.
 *
 * `onFailure` is called at most once per flush window — with the first error and
 * how many traces it affected — when the sampler threw. Reporting is the
 * caller's job so the bound on it can live with the sink instance rather than
 * with this pure function.
 */
const applyTailSampler = (
    signals: BufferedSignal[],
    tailSampler: TailSampler | undefined,
    onFailure: (error: unknown, traces: number) => void,
): BufferedSignal[] => {
    if (tailSampler === undefined) {
        return signals;
    }

    const { byTrace, untraced } = groupByTrace(signals);
    const kept = [...untraced];
    let failures = 0;
    let firstFailure: unknown;

    for (const [traceId, bucket] of byTrace) {
        let verdict: boolean;

        try {
            verdict = tailSampler({
                logs: bucket.filter((entry) => entry.kind === "log").map((entry) => entry.event),
                rpc: bucket.filter((entry) => entry.kind === "rpc").map((entry) => entry.event),
                spans: bucket.filter((entry) => entry.kind === "span").map((entry) => entry.event),
                traceId,
            });
        } catch (error) {
            // Fails OPEN, deliberately — and deliberately the opposite of
            // `postProcess` above. The two hooks guard different things: a broken
            // `postProcessor` can leak PII, so silence is the safer failure; a
            // broken `tailSampler` can only mis-judge volume, and dropping the
            // trace would delete the evidence of whatever the sampler choked on.
            // Fail-closed here would also make a sampler that throws on exactly
            // the pathological traces (a cyclic attribute, a huge error message)
            // erase precisely the traces worth keeping.
            //
            // The cost is bounded and visible rather than silent: the failure is
            // reported to `onFailure` (rate-limited by the caller), so an operator
            // relying on `tailSampler` for volume control learns that the policy
            // has stopped applying instead of only seeing the collector bill.
            failures += 1;

            if (failures === 1) {
                firstFailure = error;
            }

            verdict = true;
        }

        if (verdict) {
            kept.push(...bucket);
        }
    }

    if (failures > 0) {
        onFailure(firstFailure, failures);
    }

    return kept;
};

/**
 * Run one event through its post-processor hook, dropping the event if the hook
 * throws.
 *
 * Fails **closed**, deliberately. An earlier version returned the event
 * unmodified on a throw, reasoning that visible un-redacted data beats silent
 * absence — which is right for observability in general and wrong for this hook
 * in particular. `postProcessor` exists to strip PII before telemetry leaves for
 * a third-party collector, and `error.message` routinely carries user input. A
 * dropped span is a monitoring gap you notice; a leaked payload is an incident
 * you cannot retract. So a broken redaction rule loses telemetry rather than
 * exporting secrets.
 */
const postProcess = <T>(event: T, hook: ((event: T) => T | undefined) | undefined): T | undefined => {
    if (hook === undefined) {
        return event;
    }

    try {
        return hook(event);
    } catch {
        return undefined;
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

        return processed === undefined ? undefined : { bucket: "spans", encoded: otlpTraceBody(processed, signal.endMs) };
    }

    if (signal.kind === "span") {
        const processed = postProcess(signal.event, postProcessor?.span);

        return processed === undefined ? undefined : { bucket: "spans", encoded: otlpSpanBody(processed) };
    }

    if (signal.kind === "log") {
        const processed = postProcess(signal.event, postProcessor?.log);

        return processed === undefined ? undefined : { bucket: "logs", encoded: otlpLogBody(processed) };
    }

    const processed = postProcess(signal.event, postProcessor?.metric);

    return processed === undefined ? undefined : { bucket: "metrics", encoded: otlpMetricBody(processed) };
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
 * Composes with head sampling rather than replacing it: head sampling cheaply
 * discards most traces before they cost anything, and this makes the final call
 * on what survived. The canonical policy — "keep errors and slow requests, drop
 * the rest" — needs both.
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
 *
 * A hook that THROWS also drops the event. Redaction is a privacy control, so it
 * fails closed — losing a span beats exporting the thing the hook existed to
 * remove.
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
     * Value of the `deployment.environment` resource attribute (e.g.
     * `"production"`, `"staging"`, `"development"`).
     */
    deploymentEnvironment?: string;

    /**
     * When `true`, the sink attaches the resource attributes the **host** detected
     * for the current request, merged *under* any explicit option so those always
     * win on collision. In a Worker that is `service.version`,
     * `deployment.environment`, `cloud.provider`, and `cloud.region` (the colo).
     *
     * The sink never inspects `env` or the request itself — detection happens once
     * per request in the runtime and arrives pre-resolved on the sink context (see
     * `LogSinkContext.resourceAttributes`), so no sink is ever handed raw bindings.
     *
     * Events that originate inside a shard (`ctx.log`, `ctx.trace`, `ctx.metrics`)
     * carry no host-detected attributes today — the shard has no `env` of its own —
     * so they export with the explicit options only. Set the values you need
     * explicitly if you require them to match across worker and shard spans of the
     * same trace.
     */
    detectResources?: boolean;

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
     * {@link OtlpPostProcessor}. A hook that throws drops the event (fail-closed);
     * see {@link postProcess}.
     */
    postProcessor?: OtlpPostProcessor;

    /**
     * Additional resource attributes to attach to every exported signal. These
     * ride alongside the built-in `service.name` and any convenience fields
     * (`serviceVersion`, `deploymentEnvironment`, etc.). A key that collides with
     * a built-in resource attribute wins; use this for custom dimensions like
     * `deployment.region`, `host.name`, or `service.instance.id`.
     */
    resourceAttributes?: OtlpResourceAttributes;

    /**
     * Value of the `service.name` resource attribute on every exported span and
     * log — the logical service the telemetry belongs to. Defaults to `lunora`.
     */
    serviceName?: string;

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
     * Decide per trace, at flush time, whether it is exported — see
     * {@link TailSampler}. Requires batching (the default); ignored when
     * `batch: false`, because an unbuffered exporter has no trace to judge.
     *
     * A sampler that throws **keeps** the trace (fail-open) and the failure is
     * reported to `console.error`, rate-limited per sink. Treat this hook as a
     * cost control, not a guarantee: if a bounded export volume is a hard
     * requirement, enforce it at the collector, which cannot be bypassed by a bug
     * in this predicate.
     */
    tailSampler?: TailSampler;

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
    const {
        batch,
        deploymentEnvironment,
        detectResources,
        endpoint,
        headers,
        onlyErrors,
        postProcessor,
        resourceAttributes,
        serviceNamespace,
        serviceVersion,
        tailSampler,
        token,
    } = options;
    const serviceName = options.serviceName ?? "lunora";

    // The explicit half of the resource, built once per sink. Convenience fields
    // first, then `resourceAttributes`, so a caller can override anything.
    const staticAttributes: OtlpResourceAttributes = {
        ...(serviceVersion === undefined ? {} : { "service.version": serviceVersion }),
        ...(serviceNamespace === undefined ? {} : { "service.namespace": serviceNamespace }),
        ...(deploymentEnvironment === undefined ? {} : { "deployment.environment": deploymentEnvironment }),
        ...resourceAttributes,
    };

    // Per-request memo of the merged bag. Every log line, metric, and span of one
    // request shares a sink context, and both halves of the merge are fixed for
    // that request — so this runs at most once per request instead of once per
    // event on the hot dispatch path.
    const mergedByContext = new WeakMap<ObservabilitySinkContext, OtlpResourceAttributes>();

    /**
     * The resource bag for one event: host-detected attributes merged *under* the
     * static options, so explicit configuration always wins on collision.
     *
     * With `detectResources` off — the default — this is the static bag by
     * reference, so the common case allocates nothing at all.
     */
    const resourceAttributesFor = (context?: ObservabilitySinkContext): OtlpResourceAttributes => {
        if (detectResources !== true || context?.resourceAttributes === undefined) {
            return staticAttributes;
        }

        const memoized = mergedByContext.get(context);

        if (memoized !== undefined) {
            return memoized;
        }

        const merged = mergeResourceAttributes(context.resourceAttributes(), staticAttributes);

        mergedByContext.set(context, merged);

        return merged;
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

    /** Failures already reported by {@link reportTailSamplerFailure} on this sink. */
    let tailSamplerFailureReports = 0;

    /**
     * Surface a throwing `tailSampler`, at most
     * {@link MAX_TAIL_SAMPLER_FAILURE_REPORTS} times per sink instance and at most
     * once per flush window. Without this a broken sampler is indistinguishable
     * from a permissive one: every trace is kept either way, and the only symptom
     * is an export volume nobody can explain.
     */
    const reportTailSamplerFailure = (error: unknown, traces: number): void => {
        if (tailSamplerFailureReports >= MAX_TAIL_SAMPLER_FAILURE_REPORTS) {
            return;
        }

        tailSamplerFailureReports += 1;

        const silencing =
            tailSamplerFailureReports === MAX_TAIL_SAMPLER_FAILURE_REPORTS
                ? " Further tailSampler failures from this sink are silenced until the isolate restarts."
                : "";

        // eslint-disable-next-line no-console
        console.error(
            `[lunora:otlp] tailSampler threw for ${String(traces)} trace(s) in this flush window; keeping them (fail-open), so the sampling policy did NOT apply.${silencing}`,
            error,
        );
    };

    /**
     * Ship one flush window: tail-sample, encode by signal, then POST at most one
     * request per signal endpoint.
     *
     * Events are grouped by their RESOURCE bag before wrapping. With
     * `detectResources` on, two requests in the same flush window can legitimately
     * carry different host attributes, and one envelope has exactly one resource —
     * so mixing them would silently mis-attribute half the batch.
     */
    const exportBatch = async (signals: BufferedSignal[]): Promise<void> => {
        const kept = applyTailSampler(signals, tailSampler, reportTailSamplerFailure);
        const groups = new Map<OtlpResourceAttributes, { logs: unknown[]; metrics: unknown[]; spans: unknown[] }>();

        for (const signal of kept) {
            const encoded = encodeSignal(signal, postProcessor);

            if (encoded === undefined) {
                continue;
            }

            let group = groups.get(signal.resource);

            if (group === undefined) {
                group = { logs: [], metrics: [], spans: [] };
                groups.set(signal.resource, group);
            }

            group[encoded.bucket].push(encoded.encoded);
        }

        const sends: Promise<void>[] = [];

        for (const [resource, group] of groups) {
            if (group.spans.length > 0) {
                sends.push(otlpSend(tracesUrl, wrapResourceSpans(group.spans, "@lunora/runtime", serviceName, resource), mergedHeaders));
            }

            if (group.logs.length > 0) {
                sends.push(otlpSend(logsUrl, wrapResourceLogs(group.logs, "@lunora/runtime", serviceName, resource), mergedHeaders));
            }

            if (group.metrics.length > 0) {
                sends.push(otlpSend(metricsUrl, wrapResourceMetrics(group.metrics, "@lunora/runtime", serviceName, resource), mergedHeaders));
            }
        }

        // Concurrent: the signal endpoints are unrelated, and serialising them
        // would add a round-trip of tail latency to the `waitUntil` for no benefit.
        await Promise.all(sends);
    };

    if (batch === false) {
        // Unbatched: encode and POST each event on arrival. `tailSampler` is
        // inapplicable here (there is no buffered trace to judge) and documented
        // as such; `postProcessor` still applies.
        return {
            onLog: (event, context) => {
                const processed = postProcess(event, postProcessor?.log);

                if (processed !== undefined) {
                    otlpPost(
                        logsUrl,
                        wrapResourceLogs(otlpLogBody(processed), "@lunora/runtime", serviceName, resourceAttributesFor(context)),
                        mergedHeaders,
                        context,
                    );
                }
            },
            onMetric: (event, context) => {
                const processed = postProcess(event, postProcessor?.metric);

                if (processed !== undefined) {
                    otlpPost(
                        metricsUrl,
                        wrapResourceMetrics(otlpMetricBody(processed), "@lunora/runtime", serviceName, resourceAttributesFor(context)),
                        mergedHeaders,
                        context,
                    );
                }
            },
            onRpc: (event, context) => {
                if (shouldSkip(event, onlyErrors)) {
                    return;
                }

                const processed = postProcess(event, postProcessor?.rpc);

                if (processed !== undefined) {
                    otlpPost(
                        tracesUrl,
                        wrapResourceSpans(otlpTraceBody(processed, Date.now()), "@lunora/runtime", serviceName, resourceAttributesFor(context)),
                        mergedHeaders,
                        context,
                    );
                }
            },
            onSpan: (event, context) => {
                const processed = postProcess(event, postProcessor?.span);

                if (processed !== undefined) {
                    otlpPost(
                        tracesUrl,
                        wrapResourceSpans(otlpSpanBody(processed), "@lunora/runtime", serviceName, resourceAttributesFor(context)),
                        mergedHeaders,
                        context,
                    );
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
            batcher.add({ event, kind: "log", resource: resourceAttributesFor(context) }, context?.waitUntil);
        },
        onMetric: (event, context) => {
            // Like logs and spans, a measurement the developer explicitly recorded
            // is never scoped by `onlyErrors`.
            batcher.add({ event, kind: "metric", resource: resourceAttributesFor(context) }, context?.waitUntil);
        },
        onRpc: (event, context) => {
            if (shouldSkip(event, onlyErrors)) {
                return;
            }

            // `endMs` is captured on arrival, not at flush: the span's end time is
            // when the dispatch finished, and deriving it from the flush clock
            // would stretch every span by however long it sat in the buffer.
            batcher.add({ endMs: Date.now(), event, kind: "rpc", resource: resourceAttributesFor(context) }, context?.waitUntil);
        },
        onSpan: (event, context) => {
            // `onlyErrors` scopes the RPC span stream; a handler that explicitly
            // instrumented a sub-operation always gets its span exported, the same
            // way `ctx.log` output is never scoped by it.
            batcher.add({ event, kind: "span", resource: resourceAttributesFor(context) }, context?.waitUntil);
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

    /**
     * Fan one call out to every child that implements `method`.
     *
     * One helper rather than five near-identical loops: "invoke each child in
     * order, isolate its throws, and forward the per-event context" is a single
     * policy, not a per-signal one. Forwarding `context` matters — dropping the
     * request's `waitUntil` would silently degrade every wrapped network sink to
     * fire-and-forget.
     *
     * Args are passed as a list because `flush(context)` takes the context in the
     * FIRST position while the four `on*(event, context)` hooks take it second; a
     * fixed `(event, context)` shape would hand `flush` an undefined context and
     * quietly break batching under `combineSinks` — which is the documented way to
     * pair a batching network sink with a console one.
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
