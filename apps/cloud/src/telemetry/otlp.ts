/**
 * OTLP decode for the Cloud Observability ingest (`POST /v1/telemetry`). The
 * tenant Worker `otlpSink` and the `@lunora/container` OTLP exporter both POST an
 * OTLP-over-HTTP/JSON `ExportTraceServiceRequest`; this module walks that payload
 * and extracts the **error spans** as flat, normalized events the ingest mutation
 * can fingerprint. It is deliberately tolerant — a malformed or partial span is
 * skipped, never thrown on, so one bad record can't reject a whole batch.
 *
 * The wire contract is the one documented at `concepts/observability` (Phase 2):
 * error spans carry `status.code === 2`, `status.message` is the error message,
 * worker spans (scope `@lunora/runtime`) carry `lunora.function_path` +
 * `error.type`, and container spans (scope `@lunora/container`) identify the
 * container via the `service.name` resource attribute.
 */

/** OTLP `AnyValue` — only the variants Lunora emits are read. */
interface OtlpAnyValue {
    boolValue?: boolean;
    doubleValue?: number;
    intValue?: string;
    stringValue?: string;
}

interface OtlpKeyValue {
    key: string;
    value?: OtlpAnyValue;
}

interface OtlpSpan {
    attributes?: OtlpKeyValue[];
    endTimeUnixNano?: string;
    name?: string;
    parentSpanId?: string;
    spanId?: string;
    startTimeUnixNano?: string;
    status?: { code?: number; message?: string };
    traceId?: string;
}

interface OtlpScopeSpans {
    scope?: { name?: string };
    spans?: OtlpSpan[];
}

interface OtlpResourceSpans {
    resource?: { attributes?: OtlpKeyValue[] };
    scopeSpans?: OtlpScopeSpans[];
}

/** The subset of an OTLP `ExportTraceServiceRequest` the ingest reads. */
export interface OtlpTracePayload {
    resourceSpans?: OtlpResourceSpans[];
}

/** A normalized error event — the ingest mutation's `events[]` element. */
export interface TelemetryEvent {
    code?: string;
    container?: string;
    functionPath: string;
    instance?: string;
    kind: "container" | "error";
    message: string;
    ts: number;
}

/**
 * One decoded span, stored as an **observation** (the Traces model — a
 * Langfuse-style observation, cleanroom-shaped for our schema). Unlike
 * {@link TelemetryEvent}, this keeps EVERY span (not just errors) with its full
 * timing (`startedAt`/`endedAt` → `durationMs`) and identity
 * (`traceId`/`spanId`/`parentSpanId`), so the Traces waterfall can render real
 * durations and whatever nesting the emitter provides. (Today the runtime emits
 * one flat span per RPC — no `parentSpanId` — so trees are one level deep until
 * the framework ships `ctx.trace` child spans over OTLP.)
 */
export interface SpanObservation {
    /** Selected string span attributes (`lunora.shard_key`, `lunora.user_id`, …). */
    attributes?: Record<string, string>;
    /** `endedAt − startedAt`, in ms (≥ 0). */
    durationMs: number;
    /** Epoch-ms the span ended. */
    endedAt: number;
    /** The `&lt;file>:&lt;function>` (or `container:&lt;name>`) the span ran, when attributed. */
    functionPath?: string;
    /** Which instrumentation emitted it — the worker runtime or a container. */
    kind: "container" | "worker";
    /** `error` when the span's OTLP status is `STATUS_CODE_ERROR`, else `info`. */
    level: "error" | "info";
    /** Span display name (the RPC path, or the traced operation). */
    name: string;
    /** Parent span id, when the span nests under another; absent for a root span. */
    parentSpanId?: string;
    /** The `service.name` resource attribute, when set. */
    serviceName?: string;
    /** Hex span id. */
    spanId: string;
    /** Epoch-ms the span started. */
    startedAt: number;
    /** The OTLP `status.message`, when the span errored. */
    statusMessage?: string;
    /** Hex trace id linking the span to its trace. */
    traceId: string;
}

/** OTLP status code for an errored span (`STATUS_CODE_ERROR`). */
const STATUS_ERROR = 2;

/** Read a string-valued attribute from an OTLP `KeyValue[]`. */
const attributeString = (attributes: OtlpKeyValue[] | undefined, key: string): string | undefined =>
    attributes?.find((attribute) => attribute.key === key)?.value?.stringValue;

/**
 * OTLP `timeUnixNano` (decimal nanoseconds as a string) → epoch ms. Slicing the
 * last six digits keeps this exact without overflowing `Number` (ns since the
 * epoch exceeds `Number.MAX_SAFE_INTEGER`); a missing/short value falls back to
 * the wall clock so an event always carries a sane time.
 */
const epochMsFromNano = (nano: string | undefined): number => (nano && nano.length > 6 ? Number(nano.slice(0, -6)) : Date.now());

/**
 * Decode the error spans of an OTLP trace payload into normalized events. Worker
 * error spans become `kind: "error"`; container error spans (scope
 * `@lunora/container`) become `kind: "container"` with the container name from
 * `service.name`. Non-error spans and anything unparseable are dropped.
 */
export const decodeTelemetryEvents = (payload: OtlpTracePayload): TelemetryEvent[] => {
    const events: TelemetryEvent[] = [];

    for (const resourceSpans of payload.resourceSpans ?? []) {
        const serviceName = attributeString(resourceSpans.resource?.attributes, "service.name");

        for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
            const isContainer = (scopeSpans.scope?.name ?? "").includes("@lunora/container");

            for (const span of scopeSpans.spans ?? []) {
                if (span.status?.code !== STATUS_ERROR) {
                    continue;
                }

                const message = span.status.message ?? span.name ?? "";
                const code = attributeString(span.attributes, "error.type");
                const ts = epochMsFromNano(span.endTimeUnixNano);

                if (isContainer) {
                    const container = serviceName ?? "container";

                    events.push({
                        code,
                        container,
                        functionPath: `container:${container}`,
                        instance: attributeString(span.attributes, "lunora.instance"),
                        kind: "container",
                        message,
                        ts,
                    });
                } else {
                    events.push({
                        code,
                        functionPath: attributeString(span.attributes, "lunora.function_path") ?? span.name ?? "unknown",
                        kind: "error",
                        message,
                        ts,
                    });
                }
            }
        }
    }

    return events;
};

/** Collect `lunora.*` string attributes (minus `function_path`, which becomes `functionPath`) into a compact record. */
const lunoraAttributes = (attributes: OtlpKeyValue[] | undefined): Record<string, string> | undefined => {
    const out: Record<string, string> = {};

    for (const attribute of attributes ?? []) {
        const value = attribute.value?.stringValue;

        if (value !== undefined && attribute.key.startsWith("lunora.") && attribute.key !== "lunora.function_path") {
            out[attribute.key.slice("lunora.".length)] = value;
        }
    }

    return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * Decode EVERY span of an OTLP trace payload into a {@link SpanObservation} — the
 * Traces store's rows. Unlike {@link decodeTelemetryEvents} (which keeps only
 * error spans for Issue grouping), this keeps all spans with full timing and
 * identity, so the Traces view renders real durations (and whatever nesting the
 * emitter provides via `parentSpanId`). A span missing its `traceId`/`spanId` is
 * skipped (it can't be placed in a trace); everything else is tolerated — a
 * missing time falls back to the wall clock.
 */
export const decodeObservations = (payload: OtlpTracePayload): SpanObservation[] => {
    const observations: SpanObservation[] = [];

    for (const resourceSpans of payload.resourceSpans ?? []) {
        const serviceName = attributeString(resourceSpans.resource?.attributes, "service.name");

        for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
            const kind = (scopeSpans.scope?.name ?? "").includes("@lunora/container") ? "container" : "worker";

            for (const span of scopeSpans.spans ?? []) {
                if (span.traceId === undefined || span.traceId === "" || span.spanId === undefined || span.spanId === "") {
                    continue;
                }

                const startedAt = epochMsFromNano(span.startTimeUnixNano);
                const endedAt = epochMsFromNano(span.endTimeUnixNano);
                const errored = span.status?.code === STATUS_ERROR;
                const workerPath = attributeString(span.attributes, "lunora.function_path") ?? span.name;

                observations.push({
                    attributes: lunoraAttributes(span.attributes),
                    durationMs: Math.max(endedAt - startedAt, 0),
                    endedAt,
                    functionPath: kind === "container" ? `container:${serviceName ?? "container"}` : workerPath,
                    kind,
                    level: errored ? "error" : "info",
                    name: span.name ?? workerPath ?? "span",
                    parentSpanId: span.parentSpanId === "" ? undefined : span.parentSpanId,
                    serviceName,
                    spanId: span.spanId,
                    startedAt,
                    statusMessage: errored ? span.status?.message : undefined,
                    traceId: span.traceId,
                });
            }
        }
    }

    return observations;
};
