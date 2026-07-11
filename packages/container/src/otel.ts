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
 * an injected `fetch`. Each span/log is one fire-and-forget POST; `flush()`
 * awaits in-flight sends before the process exits. Reaching the collector still
 * requires the container's egress allow-list to include its host (declare it on
 * `defineContainer({ allowedHosts })` or via `handle.egress.allow(host)`).
 */

/** An attribute value carried on a span or log. */
type ContainerAttributeValue = boolean | number | string;

/**
 * A `fetch` implementation — defaults to the runtime global. Only the promise's
 * settlement matters to the exporter; the response body is never read.
 */
type OtelFetchLike = (input: string, init: { body: string; headers: Record<string, string>; method: string }) => Promise<{ ok: boolean; status: number }>;

/** A single span the container process asks the exporter to record. */
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

/** A single log line the container process asks the exporter to record. */
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

/** Options for {@link createContainerTelemetry}. */
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
    /** Bearer token sent as an `Authorization: Bearer` header; defaults to the `LUNORA_OTLP_TOKEN` env var. */
    token?: string;
}

/** The exporter handle {@link createContainerTelemetry} returns. */
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

/** OTLP log severity numbers keyed by {@link ContainerLogInput.level}. */
const SEVERITY: Record<NonNullable<ContainerLogInput["level"]>, number> = {
    debug: 5, // DEBUG
    error: 17, // ERROR
    info: 9, // INFO
    warn: 13, // WARN
};

/** One OTLP `AnyValue` — the JSON encoding of a typed attribute value. */
type OtlpValue = { boolValue: boolean } | { doubleValue: number } | { intValue: string } | { stringValue: string };

/** One OTLP `KeyValue` attribute. */
interface OtlpAttribute {
    key: string;
    value: OtlpValue;
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

/**
 * Encode ms as an OTLP `*UnixNano` string. proto3 JSON represents uint64 as a
 * decimal string, and ms→ns is ×10^6, so the six trailing zeros are exact.
 */
const unixNano = (ms: number): string => `${String(Math.round(ms))}000000`;

/**
 * A random lowercase hex id of `bytes` length. OTLP/JSON encodes `trace_id`/
 * `span_id` as hex strings (the one documented exception to proto3 JSON's
 * base64 `bytes` encoding). Uses the Web Crypto global (present in Node ≥19,
 * Bun, Deno) — no Node built-in import.
 */
const randomHex = (bytes: number): string => {
    const buffer = new Uint8Array(bytes);

    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- the WebCrypto `crypto` global is stable in Node ≥19, Bun, Deno, and workerd; engines guarantee Node ≥22.15
    crypto.getRandomValues(buffer);

    let hex = "";

    for (const byte of buffer) {
        hex += byte.toString(16).padStart(2, "0");
    }

    return hex;
};

/** Encode one attribute, picking the OTLP value kind from the JS type. */
const encodeAttribute = (key: string, value: ContainerAttributeValue): OtlpAttribute => {
    if (typeof value === "boolean") {
        return { key, value: { boolValue: value } };
    }

    if (typeof value === "number") {
        // int64s are decimal strings in proto3 JSON; non-integers use doubleValue.
        return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
    }

    return { key, value: { stringValue: value } };
};

/** Encode an attribute bag into the OTLP `KeyValue` list. */
const encodeAttributes = (attributes: Record<string, ContainerAttributeValue> | undefined): OtlpAttribute[] => {
    if (attributes === undefined) {
        return [];
    }

    return Object.entries(attributes).map(([key, value]) => encodeAttribute(key, value));
};

/** Build the OTLP trace-export body for one container span. */
const traceBody = (span: ContainerSpanInput, serviceName: string): unknown => {
    const attributes = encodeAttributes(span.attributes);

    if (span.error?.type !== undefined) {
        attributes.push({ key: "error.type", value: { stringValue: span.error.type } });
    }

    const otlpSpan = {
        attributes,
        endTimeUnixNano: unixNano(span.endMs),
        // SPAN_KIND_INTERNAL — the container's own work, not a server/client edge.
        kind: 1,
        name: span.name,
        spanId: randomHex(8),
        startTimeUnixNano: unixNano(span.startMs),
        // STATUS_CODE_OK (1) / STATUS_CODE_ERROR (2).
        status: span.error === undefined ? { code: 1 } : { code: 2, message: span.error.message },
        traceId: randomHex(16),
    };

    return {
        resourceSpans: [
            {
                resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
                scopeSpans: [{ scope: { name: "@lunora/container" }, spans: [otlpSpan] }],
            },
        ],
    };
};

/** Build the OTLP log-export body for one container log line. */
const logBody = (log: ContainerLogInput, serviceName: string, nowMs: number): unknown => {
    const level = log.level ?? "info";

    const record = {
        attributes: encodeAttributes(log.attributes),
        body: { stringValue: log.message },
        severityNumber: SEVERITY[level],
        severityText: level.toUpperCase(),
        timeUnixNano: unixNano(log.ts ?? nowMs),
    };

    return {
        resourceLogs: [
            {
                resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
                scopeLogs: [{ logRecords: [record], scope: { name: "@lunora/container" } }],
            },
        ],
    };
};

/**
 * Case-insensitively build the POST headers: a default `content-type`, the
 * caller's `overrides` (deduped by lowercased name so a `Content-Type` override
 * replaces rather than duplicates the default), and a bearer `authorization`
 * from `token` (which wins over any caller-supplied authorization).
 */
const buildHeaders = (overrides: Record<string, string> | undefined, token: string | undefined): Record<string, string> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const seen = new Map<string, string>([["content-type", "content-type"]]);

    for (const [name, value] of Object.entries(overrides ?? {})) {
        const lower = name.toLowerCase();
        const existing = seen.get(lower);

        if (existing === undefined) {
            seen.set(lower, name);
            headers[name] = value;
        } else {
            headers[existing] = value;
        }
    }

    if (token !== undefined && token.length > 0) {
        headers[seen.get("authorization") ?? "authorization"] = `Bearer ${token}`;
    }

    return headers;
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
 */
const createContainerTelemetry = (options: ContainerTelemetryOptions = {}): ContainerTelemetry => {
    const endpoint = options.endpoint ?? readEnv("LUNORA_OTLP_ENDPOINT");
    const enabled = endpoint !== undefined && endpoint.length > 0;
    const token = options.token ?? readEnv("LUNORA_OTLP_TOKEN");
    const serviceName = options.serviceName ?? readEnv("LUNORA_SERVICE_NAME") ?? "lunora-container";
    const fetchImpl = resolveFetch(options.fetch);
    const headers = buildHeaders(options.headers, token);

    // Strip trailing slashes without a regex (ReDoS-linter friendly).
    let base = endpoint ?? "";

    while (base.endsWith("/")) {
        base = base.slice(0, -1);
    }

    const tracesUrl = `${base}/v1/traces`;
    const logsUrl = `${base}/v1/logs`;
    const inflight = new Set<Promise<void>>();

    const send = (url: string, body: unknown): void => {
        if (!enabled) {
            return;
        }

        const post = fetchImpl;

        if (post === undefined) {
            options.onError?.(new TypeError("createContainerTelemetry: no `fetch` available — pass `fetch` in options for this runtime."));

            return;
        }

        // `dispatch` catches its own errors (including a synchronous `fetch` throw on
        // e.g. an invalid URL), so the tracked chain never rejects and telemetry never
        // breaks the container.
        const dispatch = async (): Promise<void> => {
            try {
                await post(url, { body: JSON.stringify(body), headers, method: "POST" });
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
        send(tracesUrl, traceBody(span, serviceName));
    };

    const emitLog = (log: ContainerLogInput): void => {
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
