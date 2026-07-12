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
    status?: { code?: number; message?: string };
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
