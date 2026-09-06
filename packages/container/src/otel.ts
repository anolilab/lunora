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
 * an injected `fetch`. Spans and logs are BATCHED per signal by
 * `shared/otlp-batch.ts` (the same buffer the worker `otlpSink` uses), so a job
 * emitting twenty spans and thirty log lines pays two round-trips rather than
 * fifty. Each POST is bounded by a per-request timeout (`timeoutMs`) so a hung
 * collector can never pin a send in flight; `flush()` drains both buffers and
 * awaits the in-flight sends, and MUST be called before the process exits — an
 * exit that skips it drops whatever is still buffered.
 * Reaching the collector still requires the container's egress allow-list to
 * include its host (declare it on `defineContainer({ allowedHosts })` or via
 * `handle.egress.allow(host)`).
 *
 * The OTLP/JSON wire encoding is shared with the worker `otlpSink` via
 * `shared/otlp.ts` — one contract, bundler-inlined into both packages.
 */
import { abortDeadline } from "../../../shared/abort-deadline";
import type { OtlpResourceAttributes } from "../../../shared/otlp";
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
import { createSignalBatcher } from "../../../shared/otlp-batch";
import { detectHostResource, detectServiceResource, mergeResourceAttributes } from "../../../shared/otlp-resource";

/**
 * An attribute value carried on a span or log.
 */
type ContainerAttributeValue = boolean | number | string;

/**
 * A `fetch` implementation — defaults to the runtime global. The exporter passes
 * an abort `signal` (for the per-request timeout) and, once the promise settles,
 * cancels the response `body` so Node/undici can release the socket for
 * keep-alive reuse instead of leaving it occupied by an unread stream. It reads
 * `ok`/`status` to detect a rejected export and nothing else from the response.
 */
type OtelFetchLike = (
    input: string,
    init: { body: string; headers: Record<string, string>; method: string; signal?: AbortSignal },
) => Promise<{ body?: { cancel: () => Promise<void> } | null; ok: boolean; status: number }>;

/**
 * A single span the container process asks the exporter to record.
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
 */
interface ContainerTelemetryOptions {
    /**
     * Value of the `deployment.environment` resource attribute. Falls back to
     * the `DEPLOYMENT_ENVIRONMENT` / `ENVIRONMENT` / `NODE_ENV` env vars **only
     * when {@link ContainerTelemetryOptions.detectResources} is `true`** —
     * unlike `serviceName`, env detection here is opt-in so a stray `NODE_ENV`
     * never silently labels a deployment.
     */
    deploymentEnvironment?: string;

    /**
     * When `true`, auto-detect OTLP resource attributes from the container
     * environment (`HOSTNAME`, `KUBERNETES_*`, `SERVICE_VERSION`, etc.).
     * Explicit options and `resourceAttributes` win on collision.
     */
    detectResources?: boolean;

    /** Base OTLP collector endpoint; defaults to the `LUNORA_OTLP_ENDPOINT` env var. */
    endpoint?: string;
    /** Injectable `fetch` (tests / non-global runtimes). Defaults to `globalThis.fetch`. */
    fetch?: OtelFetchLike;
    /** Extra headers merged onto every POST — e.g. deployment/org correlation. `content-type` is set by default. */
    headers?: Record<string, string>;
    /** Called with any send failure so the caller can surface it; the export itself always swallows. */
    onError?: (error: unknown) => void;
    /** Additional resource attributes merged onto every signal. */
    resourceAttributes?: Record<string, ContainerAttributeValue>;
    /** `service.name` resource attribute; defaults to the `LUNORA_SERVICE_NAME` env var then `"lunora-container"`. */
    serviceName?: string;

    /**
     * `service.version` resource attribute. Falls back to `SERVICE_VERSION` /
     * `CF_VERSION_METADATA` / `VERCEL_GIT_COMMIT_SHA` / `GITHUB_SHA` /
     * `COMMIT_SHA` env vars **only when
     * {@link ContainerTelemetryOptions.detectResources} is `true`**.
     */
    serviceVersion?: string;
    /** Per-POST timeout in ms; a collector that never responds aborts after this so a stuck send can't stall `flush()`. Defaults to {@link DEFAULT_TIMEOUT_MS} (10s). */
    timeoutMs?: number;
    /** Bearer token sent as an `Authorization: Bearer` header; defaults to the `LUNORA_OTLP_TOKEN` env var. */
    token?: string;

    /**
     * W3C `traceparent` of the Worker RPC that invoked this container; defaults to
     * the `LUNORA_TRACEPARENT` env var. When present (and well-formed) every span
     * inherits its trace id and hangs off its span id, so container spans stitch
     * under the Worker's trace instead of forming a fresh, disconnected trace, and
     * every log record is stamped with the same ids so a request's container logs
     * are reachable from its trace.
     *
     * It also carries the trace's settled **sampling verdict**, which this exporter
     * OBEYS rather than re-derives: a `traceparent` whose flags say the trace was
     * sampled out (`…-00`) suppresses span export, because the worker and shard
     * spans of that trace were dropped and shipping ours would leave the collector
     * holding the middle of a trace. Logs are never sampled and are unaffected.
     *
     * `@lunora/container` stamps this trace context as the **`traceparent` request
     * header** on every proxied fetch (`ctx.containers.<name>.…`), so a container
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

/** W3C `sampled` bit, the value OTLP's per-span/per-record `flags` field carries. */
const SAMPLED_TRACE_FLAG = 1;

/**
 * The exporter handle {@link createContainerTelemetry} returns.
 */
interface ContainerTelemetry {
    /** Record one log line (no-op when disabled). */
    emitLog: (log: ContainerLogInput) => void;
    /** Record one span (no-op when disabled). */
    emitSpan: (span: ContainerSpanInput) => void;
    /** True when an endpoint resolved and exports are actually sent. */
    readonly enabled: boolean;
    /** Drain the span/log buffers and await every in-flight send — call before the process exits, or buffered signals are lost. */
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

/**
 * Auto-detect OTLP resource attributes from the container environment.
 *
 * Composes the shared detectors this host can actually satisfy: service identity
 * (from CI/deploy env vars) and host/process identity (`HOSTNAME`,
 * `KUBERNETES_*`, pid). The Cloudflare placement detector is deliberately absent —
 * a container has no `request.cf`. The worker sink composes the complementary
 * pair from the same module, so both sides share one policy.
 */
const detectContainerResource = (): OtlpResourceAttributes => {
    const pid = typeof process === "undefined" || typeof process.pid !== "number" ? undefined : process.pid;

    return mergeResourceAttributes(detectServiceResource(readEnv), detectHostResource(readEnv, pid));
};

/** Resolve the `fetch` to use: the injected one, else the runtime global, else undefined. */
const resolveFetch = (injected: OtelFetchLike | undefined): OtelFetchLike | undefined =>
    injected ?? (typeof globalThis.fetch === "function" ? globalThis.fetch : undefined);

/**
 * Encode one container span as an OTLP span object. The `resourceSpans`
 * envelope is applied once per BATCH (see the exporter's span batcher), not
 * here, so several spans share one wrapper and one POST.
 */
const encodeSpan = (span: ContainerSpanInput, parent: { parentSpanId: string; sampled: boolean; traceId: string } | undefined): unknown => {
    const attributes = encodeAttributes(span.attributes);

    if (span.error?.type !== undefined) {
        attributes.push(encodeAttribute("error.type", span.error.type));
    }

    const otlpSpan: Record<string, unknown> = {
        attributes,
        endTimeUnixNano: otlpUnixNano(span.endMs),
        // W3C trace flags, mirroring the verdict this container inherited. Without
        // it a collector reading `flags` sees 0 (UNSAMPLED) on every span we ship,
        // including the ones it is meant to keep.
        flags: (parent?.sampled ?? true) ? SAMPLED_TRACE_FLAG : 0,
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

    // On error, record an OTel exception event with the standard `exception.*`
    // attributes.
    if (span.error) {
        otlpSpan.events = [
            {
                attributes: [encodeAttribute("exception.type", span.error.type ?? "Error"), encodeAttribute("exception.message", span.error.message)],
                name: "exception",
                timeUnixNano: otlpUnixNano(span.endMs),
            },
        ];
    }

    return otlpSpan;
};

/**
 * Encode one container log line as an OTLP log record. The `resourceLogs`
 * envelope is applied once per batch.
 *
 * Stamped with the inbound trace context when there is one. A log record carrying
 * no `traceId`/`spanId` is unreachable from the trace it belongs to — the whole
 * point of propagating a `traceparent` into the container is that one request
 * reads as one thing, and "show me this request's container logs" was a query
 * nobody could run. Logs are NOT sampled (only spans are), so this is stamped
 * whatever the verdict was; `flags` carries the verdict so a collector can tell.
 */
const encodeLogRecord = (log: ContainerLogInput, nowMs: number, parent: { parentSpanId: string; sampled: boolean; traceId: string } | undefined): unknown => {
    const level = log.level ?? "info";

    return {
        attributes: encodeAttributes(log.attributes),
        body: { stringValue: log.message },
        severityNumber: OTLP_SEVERITY[level],
        severityText: level.toUpperCase(),
        timeUnixNano: otlpUnixNano(log.ts ?? nowMs),
        ...(parent === undefined ? {} : { flags: parent.sampled ? SAMPLED_TRACE_FLAG : 0, spanId: parent.parentSpanId, traceId: parent.traceId }),
    };
};

/**
 * Create a zero-config OTLP exporter for the container process.
 *
 * ```ts
 * const telemetry = createContainerTelemetry(); // reads LUNORA_OTLP_ENDPOINT / _TOKEN
 * await telemetry.trace("transcode", () => transcode(job), { jobId: job.id });
 * telemetry.emitLog({ level: "info", message: "done", attributes: { jobId: job.id } });
 * await telemetry.flush(); // REQUIRED before the process exits — see below
 * ```
 *
 * `flush()` is mandatory, not an optimisation. Spans and log records are
 * BATCHED: nothing leaves the process until the batcher's timer elapses or
 * `flush()` drains it, so a job that finishes and exits inside that window
 * reports NOTHING without it. A long job between flushes can also reach the
 * batcher's item cap, which drops the OLDEST buffered records — flush at
 * checkpoints, not only at exit.
 *
 * With no endpoint resolvable the returned exporter is disabled (`enabled ===
 * false`): `emitSpan`/`emitLog` no-op and `trace` still runs its work but records
 * nothing — so the same code runs unchanged locally and in the cloud.
 * @param options Exporter options. Connection fields (`endpoint`, `token`,
 * `serviceName`, `traceparent`) always fall back to their `LUNORA_*` env var;
 * resource fields (`serviceVersion`, `deploymentEnvironment`) only do so under
 * `detectResources: true`.
 */
const createContainerTelemetry = (options: ContainerTelemetryOptions = {}): ContainerTelemetry => {
    const endpoint = options.endpoint ?? readEnv("LUNORA_OTLP_ENDPOINT");
    const enabled = endpoint !== undefined && endpoint.length > 0;
    const token = options.token ?? readEnv("LUNORA_OTLP_TOKEN");
    const serviceName = options.serviceName ?? readEnv("LUNORA_SERVICE_NAME") ?? "lunora-container";
    const parent = parseTraceparent(options.traceparent ?? readEnv("LUNORA_TRACEPARENT"));
    // The head decision was settled by the worker and propagated on the
    // `traceparent`; a container re-derives NOTHING, it reads the verdict. Exporting
    // regardless leaves the collector holding container spans for traces whose
    // worker and shard spans were dropped — the "middle of a trace" the sampling
    // model promises cannot happen. No inbound verdict (no traceparent, or a
    // malformed one) reads as keep, exactly like every other tier. Logs are not
    // sampled and keep flowing either way.
    const exportSpans = parent?.sampled !== false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchImpl = resolveFetch(options.fetch);
    const headers = mergeHeaders({ "content-type": "application/json" }, options.headers, token);

    // Build the OTLP resource bag: detected first, then explicit convenience
    // fields, then `resourceAttributes` (highest precedence). Resolved once here
    // — nothing it reads changes over the process lifetime.
    const detectedAttributes = options.detectResources === true ? detectContainerResource() : undefined;
    const staticAttributes: OtlpResourceAttributes = {};

    if (options.serviceVersion !== undefined) {
        staticAttributes["service.version"] = options.serviceVersion;
    }

    if (options.deploymentEnvironment !== undefined) {
        staticAttributes["deployment.environment"] = options.deploymentEnvironment;
    }

    if (options.resourceAttributes !== undefined) {
        Object.assign(staticAttributes, options.resourceAttributes);
    }

    const resource = mergeResourceAttributes(detectedAttributes, staticAttributes);

    // Strip trailing slashes without a regex (ReDoS-linter friendly).
    let base = endpoint ?? "";

    while (base.endsWith("/")) {
        base = base.slice(0, -1);
    }

    const tracesUrl = `${base}/v1/traces`;
    const logsUrl = `${base}/v1/logs`;
    const inflight = new Set<Promise<void>>();

    // Only reached from a batcher's `export`, which only runs for buffered items,
    // and `emitSpan`/`emitLog` gate on `enabled` before buffering — so the
    // disabled path never builds a body or touches `fetch`. Returns the tracked
    // send so the batcher (and therefore `flush()`) can await it.
    const send = (url: string, body: unknown): Promise<void> => {
        if (fetchImpl === undefined) {
            options.onError?.(new TypeError("createContainerTelemetry: no `fetch` available — pass `fetch` in options for this runtime."));

            return Promise.resolve();
        }

        // `dispatch` catches its own errors (including a synchronous `fetch` throw on
        // e.g. an invalid URL), so the tracked chain never rejects and telemetry never
        // breaks the container.
        const dispatch = async (): Promise<void> => {
            // The deadline bounds the POST: a hung collector aborts after
            // `timeoutMs` instead of pinning this send in `inflight` and
            // stalling `flush()`. `shared/abort-deadline.ts` (explicit
            // controller + timer, strongly held) rather than `AbortSignal.timeout`,
            // whose weakly-held signal can be collected and silently never fire —
            // see its docstring. `dispose()` in the `finally` clears the timer on
            // a fast send.
            const deadline = abortDeadline(
                undefined,
                timeoutMs,
                () => new DOMException(`OTLP export to ${url} timed out after ${String(timeoutMs)}ms`, "TimeoutError"),
            );

            try {
                const response = await fetchImpl(url, { body: JSON.stringify(body), headers, method: "POST", signal: deadline.signal });

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
            } finally {
                deadline.dispose();
            }
        };

        // Remove from the in-flight set once settled to bound memory over a long run.
        const settled: Promise<void> = dispatch().finally(() => {
            inflight.delete(settled);
        });

        inflight.add(settled);

        return settled;
    };

    // One buffer per signal — spans and logs go to different OTLP endpoints, so
    // they can never share a batch. `shared/otlp-batch.ts` is the same buffer the
    // worker `otlpSink` uses; the container has no `waitUntil`, so no `keepAlive`
    // is passed and the batcher's own timer is the backstop between `flush()`
    // calls. `export` returns `send`'s promise, which is what makes `flush()`
    // await the POST rather than just the drain.
    const spanBatch = createSignalBatcher<unknown>({
        export: (spans) => send(tracesUrl, wrapResourceSpans(spans, "@lunora/container", serviceName, resource)),
    });

    const logBatch = createSignalBatcher<unknown>({
        export: (records) => send(logsUrl, wrapResourceLogs(records, "@lunora/container", serviceName, resource)),
    });

    const emitSpan = (span: ContainerSpanInput): void => {
        if (!enabled || !exportSpans) {
            return;
        }

        spanBatch.add(encodeSpan(span, parent));
    };

    const emitLog = (log: ContainerLogInput): void => {
        if (!enabled) {
            return;
        }

        logBatch.add(encodeLogRecord(log, Date.now(), parent));
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
        // Drain both buffers first — `spanBatch.flush()` resolves with its own
        // POST, so the `inflight` sweep afterwards only picks up sends started
        // by an earlier timer-driven drain.
        await Promise.allSettled([spanBatch.flush(), logBatch.flush()]);
        await Promise.allSettled(inflight);
    };

    return { emitLog, emitSpan, enabled, flush, trace };
};

export type { ContainerAttributeValue, ContainerLogInput, ContainerSpanInput, ContainerTelemetry, ContainerTelemetryOptions, OtelFetchLike };
export { createContainerTelemetry };
