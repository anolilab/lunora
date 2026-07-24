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
import { mergeHeaders } from "../../../shared/otlp";
import { mergeResourceAttributes } from "../../../shared/otlp-resource";
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

/** Options for {@link otlpSink}. */
export interface OtlpSinkOptions extends OnlyErrorsOption {
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
    const { deploymentEnvironment, detectResources, endpoint, headers, onlyErrors, resourceAttributes, serviceNamespace, serviceVersion, token } = options;
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

    return {
        onLog: (event, context) => {
            // Application log lines are exported whole; `onlyErrors` scopes the
            // RPC span stream, not the developer's `ctx.log` output.
            otlpPost(logsUrl, otlpLogBody(event, serviceName, resourceAttributesFor(context)), mergedHeaders, context);
        },
        onMetric: (event, context) => {
            // Like logs and spans, a measurement the developer explicitly recorded
            // is never scoped by `onlyErrors`.
            otlpPost(metricsUrl, otlpMetricBody(event, serviceName, resourceAttributesFor(context)), mergedHeaders, context);
        },
        onRpc: (event, context) => {
            if (shouldSkip(event, onlyErrors)) {
                return;
            }

            otlpPost(tracesUrl, otlpTraceBody(event, serviceName, Date.now(), resourceAttributesFor(context)), mergedHeaders, context);
        },
        onSpan: (event, context) => {
            // `onlyErrors` scopes the RPC span stream; a handler that explicitly
            // instrumented a sub-operation always gets its span exported, the same
            // way `ctx.log` output is never scoped by it.
            otlpPost(tracesUrl, otlpSpanBody(event, serviceName, resourceAttributesFor(context)), mergedHeaders, context);
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

/**
 * Resource attribute bag used by OTLP exporters. Re-exported from `shared/otlp`
 * because {@link OtlpSinkOptions.resourceAttributes} is part of the public
 * surface — without a name for it, a caller cannot hoist a shared attribute bag
 * into a typed constant.
 */
export type { OtlpResourceAttributes } from "../../../shared/otlp";
