/**
 * `@lunora/container/otel` — a zero-config OTLP exporter for container code.
 *
 * The in-container process (any JS runtime — Node, Bun, Deno) uses this to ship
 * its own spans and logs to the same OTLP collector the Worker's `otlpSink`
 * targets, so container and Worker telemetry land side by side. It reads the
 * collector endpoint + bearer the platform injects as container env
 * (`LUNORA_OTLP_ENDPOINT` / `LUNORA_OTLP_TOKEN`); with no endpoint configured it
 * degrades to a silent no-op, so a container never fails for want of telemetry.
 *
 * Pure `fetch` over OTLP-over-HTTP (JSON) — no `@opentelemetry/*` dependency and
 * no Cloudflare imports — so it runs in any container and is unit-testable with
 * an injected `fetch`. Each span/log is one fire-and-forget POST, bounded by a
 * per-request timeout (`timeoutMs`) so a hung collector can never pin a send in
 * flight; `flush()` awaits the in-flight sends before the process exits.
 * Reaching the collector still requires the container's egress allow-list to
 * include its host (declare it on `defineContainer({ allowedHosts })` or via
 * `handle.egress.allow(host)`).
 *
 * The OTLP/JSON wire encoding is shared with the worker `otlpSink` via
 * `shared/otlp.ts` — one contract, bundler-inlined into both packages.
 */
import {
    encodeAttribute,
    encodeAttributes,
    mergeHeaders,
    OTLP_SEVERITY,
    otlpRandomHex,
    otlpUnixNano,
    parseTraceparent,
    wrapResourceLogs,
    wrapResourceSpans,
} from "../../../shared/otlp";

/**
 * An attribute value carried on a span or log.
 * @experimental
 */
type ContainerAttributeValue = boolean | number | string;

/**
 * A `fetch` implementation — defaults to the runtime global. The exporter passes
 * an abort `signal` (for the per-request timeout) and, once the promise settles,
 * cancels the response `body` so Node/undici can release the socket for
 * keep-alive reuse instead of leaving it occupied by an unread stream. It reads
 * `ok`/`status` to detect a rejected export and nothing else from the response.
 * @experimental
 */
type OtelFetchLike = (
    input: string,
    init: { body: string; headers: Record<string, string>; method: string; signal?: AbortSignal },
) => Promise<{ body?: { cancel: () => Promise<void> } | null; ok: boolean; status: number }>;

/**
 * A single span the container process asks the exporter to record.
 * @experimental
 */
interface ContainerSpanInput {
    /** Attributes attached to the span (rendered under the OTLP `attributes` list). */
    attributes?: Record<string, ContainerAttributeValue>;
    /** Wall-clock millis when the operation ended. */
    endMs: number;
    /** When set, the span is marked errored with this message (and optional `error.type`). */
    error?: { message: string; type?: string };
    /** Span name — the operation being timed, e.g. `"transcode"`. */
    name: string;
    /** Wall-clock millis when the operation started. */
    startMs: number;
}

/**
 * A single log line the container process asks the exporter to record.
 * @experimental
 */
interface ContainerLogInput {
    /** Attributes attached to the log record. */
    attributes?: Record<string, ContainerAttributeValue>;
    /** Severity — defaults to `"info"`. */
    level?: "debug" | "error" | "info" | "warn";
    /** The log message body. */
    message: string;
    /** Wall-clock millis the line was emitted; defaults to now. */
    ts?: number;
}

/**
 * Options for {@link createContainerTelemetry}.
 * @experimental
 */
interface ContainerTelemetryOptions {
    /** Base OTLP collector endpoint; defaults to the `LUNORA_OTLP_ENDPOINT` env var. */
    endpoint?: string;
    /** Injectable `fetch` (tests / non-global runtimes). Defaults to `globalThis.fetch`. */
    fetch?: OtelFetchLike;
    /** Extra headers merged onto every POST — e.g. deployment/org correlation. `content-type` is set by default. */
    headers?: Record<string, string>;
    /** Called with any send failure so the caller can surface it; the export itself always swallows. */
    onError?: (error: unknown) => void;
    /** `service.name` resource attribute; defaults to the `LUNORA_SERVICE_NAME` env var then `"lunora-container"`. */
    serviceName?: string;
    /** Per-POST timeout in ms; a collector that never responds aborts after this so a stuck send can't stall `flush()`. Defaults to {@link DEFAULT_TIMEOUT_MS} (10s). */
    timeoutMs?: number;
    /** Bearer token sent as an `Authorization: Bearer` header; defaults to the `LUNORA_OTLP_TOKEN` env var. */
    token?: string;

    /**
     * W3C `traceparent` of the Worker RPC that invoked this container; defaults to
     * the `LUNORA_TRACEPARENT` env var. When present (and well-formed) every span
     * inherits its trace id and hangs off its span id, so container spans stitch
     * under the Worker's trace instead of forming a fresh, disconnected trace.
     *
     * `@lunora/container` stamps this trace context as the **`traceparent` request
     * header** on every proxied fetch (`ctx.containers.&lt;name>.…`), so a container
     * that serves many requests should read it per request and create a telemetry
     * instance scoped to that request — the trace context differs each call, so a
     * single process-lifetime instance can't carry it:
     *
     * ```ts
     * // inside the container's request handler
     * const telemetry = createContainerTelemetry({ traceparent: request.headers.get("traceparent") ?? undefined });
     * await telemetry.trace("transcode", () => transcode(job));
     * await telemetry.flush();
     * ```
     *
     * The `LUNORA_TRACEPARENT` env fallback fits a one-shot container that
     * processes a single job per start (the value is fixed for the process).
     */
    traceparent?: string;
}

/** Default {@link ContainerTelemetryOptions.timeoutMs} — the OTLP-exporter-conventional 10s. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The exporter handle {@link createContainerTelemetry} returns.
 * @experimental
 */
interface ContainerTelemetry {
    /** Record one log line (no-op when disabled). */
    emitLog: (log: ContainerLogInput) => void;
    /** Record one span (no-op when disabled). */
    emitSpan: (span: ContainerSpanInput) => void;
    /** True when an endpoint resolved and exports are actually sent. */
    readonly enabled: boolean;
    /** Await all in-flight sends — call before the process exits. */
    flush: () => Promise<void>;
    /** Time `run()`, recording a span named `name` (ok, or errored if it throws). Always runs `run()`, even when disabled. */
    trace: <T>(name: string, run: () => Promise<T>, attributes?: Record<string, ContainerAttributeValue>) => Promise<T>;
}

/**
 * Read an environment variable, tolerating runtimes without a `process` global
 * (e.g. Deno without node-compat) so the caller's explicit options still work.
 */
const readEnv = (name: string): string | undefined => {
    if (typeof process === "undefined") {
        return undefined;
    }

    return process.env[name];
};

/** Resolve the `fetch` to use: the injected one, else the runtime global, else undefined. */
const resolveFetch = (injected: OtelFetchLike | undefined): OtelFetchLike | undefined => {
    if (injected !== undefined) {
        return injected;
    }

    if (typeof globalThis.fetch === "function") {
        return globalThis.fetch;
    }

    return undefined;
};

/** Build the OTLP trace-export body for one container span. */
const traceBody = (span: ContainerSpanInput, serviceName: string, parent: { parentSpanId: string; traceId: string } | undefined): unknown => {
    const attributes = encodeAttributes(span.attributes);

    if (span.error?.type !== undefined) {
        attributes.push(encodeAttribute("error.type", span.error.type));
    }

    const otlpSpan = {
        attributes,
        endTimeUnixNano: otlpUnixNano(span.endMs),
        // SPAN_KIND_INTERNAL — the container's own work, not a server/client edge.
        kind: 1,
        name: span.name,
        // Always the span's own (child) id; with a parent, hang it off the parent
        // span and inherit the parent's trace id so the spans stitch into one trace.
        ...(parent === undefined ? {} : { parentSpanId: parent.parentSpanId }),
        spanId: otlpRandomHex(8),
        startTimeUnixNano: otlpUnixNano(span.startMs),
        // STATUS_CODE_OK (1) / STATUS_CODE_ERROR (2).
        status: span.error === undefined ? { code: 1 } : { code: 2, message: span.error.message },
        traceId: parent?.traceId ?? otlpRandomHex(16),
    };

    return wrapResourceSpans(otlpSpan, "@lunora/container", serviceName);
};

/** Build the OTLP log-export body for one container log line. */
const logBody = (log: ContainerLogInput, serviceName: string, nowMs: number): unknown => {
    const level = log.level ?? "info";

    const record = {
        attributes: encodeAttributes(log.attributes),
        body: { stringValue: log.message },
        severityNumber: OTLP_SEVERITY[level],
        severityText: level.toUpperCase(),
        timeUnixNano: otlpUnixNano(log.ts ?? nowMs),
    };

    return wrapResourceLogs(record, "@lunora/container", serviceName);
};

/**
 * Create a zero-config OTLP exporter for the container process.
 *
 * ```ts
 * const telemetry = createContainerTelemetry(); // reads LUNORA_OTLP_ENDPOINT / _TOKEN
 * await telemetry.trace("transcode", () => transcode(job), { jobId: job.id });
 * telemetry.emitLog({ level: "info", message: "done", attributes: { jobId: job.id } });
 * await telemetry.flush(); // before the process exits
 * ```
 *
 * With no endpoint resolvable the returned exporter is disabled (`enabled ===
 * false`): `emitSpan`/`emitLog` no-op and `trace` still runs its work but records
 * nothing — so the same code runs unchanged locally and in the cloud.
 * @param options Exporter options; every field falls back to a `LUNORA_*` env var.
 * @experimental
 */
const createContainerTelemetry = (options: ContainerTelemetryOptions = {}): ContainerTelemetry => {
    const endpoint = options.endpoint ?? readEnv("LUNORA_OTLP_ENDPOINT");
    const enabled = endpoint !== undefined && endpoint.length > 0;
    const token = options.token ?? readEnv("LUNORA_OTLP_TOKEN");
    const serviceName = options.serviceName ?? readEnv("LUNORA_SERVICE_NAME") ?? "lunora-container";
    const parent = parseTraceparent(options.traceparent ?? readEnv("LUNORA_TRACEPARENT"));
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchImpl = resolveFetch(options.fetch);
    const headers = mergeHeaders({ "content-type": "application/json" }, options.headers, token);

    // Strip trailing slashes without a regex (ReDoS-linter friendly).
    let base = endpoint ?? "";

    while (base.endsWith("/")) {
        base = base.slice(0, -1);
    }

    const tracesUrl = `${base}/v1/traces`;
    const logsUrl = `${base}/v1/logs`;
    const inflight = new Set<Promise<void>>();

    // Only reached from `emitSpan`/`emitLog`, which already gate on `enabled`, so
    // the disabled path never builds a body or touches `fetch`.
    const send = (url: string, body: unknown): void => {
        if (fetchImpl === undefined) {
            options.onError?.(new TypeError("createContainerTelemetry: no `fetch` available — pass `fetch` in options for this runtime."));

            return;
        }

        // `dispatch` catches its own errors (including a synchronous `fetch` throw on
        // e.g. an invalid URL), so the tracked chain never rejects and telemetry never
        // breaks the container.
        const dispatch = async (): Promise<void> => {
            try {
                // `AbortSignal.timeout` bounds the POST: a hung collector aborts
                // after `timeoutMs` instead of pinning this send in `inflight` and
                // stalling `flush()`. Its internal timer is unref'd, so it never
                // keeps the container process alive on its own.
                const response = await fetchImpl(url, { body: JSON.stringify(body), headers, method: "POST", signal: AbortSignal.timeout(timeoutMs) });

                // A non-2xx collector response (bad token, wrong base path, payload
                // too large, 5xx) is a real send failure the caller must be able to
                // see — `onError` is the container's only telemetry feedback channel.
                if (!response.ok) {
                    options.onError?.(new Error(`createContainerTelemetry: OTLP export to ${url} failed with status ${String(response.status)}.`));
                }

                // Cancel the response body so Node/undici can return the socket to
                // the keep-alive pool rather than leaving it occupied by an unread
                // stream over a long-lived container run. A rejecting `cancel()` is
                // not a send failure, so it is swallowed here rather than reported.
                try {
                    await response.body?.cancel();
                } catch {
                    // Best-effort socket release; ignore.
                }
            } catch (error) {
                options.onError?.(error);
            }
        };

        // Remove from the in-flight set once settled to bound memory over a long run.
        const settled: Promise<void> = dispatch().finally(() => {
            inflight.delete(settled);
        });

        inflight.add(settled);
    };

    const emitSpan = (span: ContainerSpanInput): void => {
        if (!enabled) {
            return;
        }

        send(tracesUrl, traceBody(span, serviceName, parent));
    };

    const emitLog = (log: ContainerLogInput): void => {
        if (!enabled) {
            return;
        }

        send(logsUrl, logBody(log, serviceName, Date.now()));
    };

    const trace = async <T>(name: string, run: () => Promise<T>, attributes?: Record<string, ContainerAttributeValue>): Promise<T> => {
        const startMs = Date.now();

        try {
            const result = await run();

            emitSpan({ attributes, endMs: Date.now(), name, startMs });

            return result;
        } catch (error) {
            emitSpan({
                attributes,
                endMs: Date.now(),
                error: { message: error instanceof Error ? error.message : String(error), type: error instanceof Error ? error.name : undefined },
                name,
                startMs,
            });

            throw error;
        }
    };

    const flush = async (): Promise<void> => {
        await Promise.allSettled(inflight);
    };

    return { emitLog, emitSpan, enabled, flush, trace };
};

export type { ContainerAttributeValue, ContainerLogInput, ContainerSpanInput, ContainerTelemetry, ContainerTelemetryOptions, OtelFetchLike };
export { createContainerTelemetry };
