/**
 * Read-back of tiered spans from the columnar archive (R2 SQL over the Iceberg
 * table `archiveSpans` writes). This is the read half of the tiering that lets the
 * Traces view reach past D1's hot window. The **query + row mapping** live here as
 * pure, tested functions; the live query itself is gated on the R2-SQL config
 * (`R2_SQL_TOKEN` + the catalog), so it no-ops to `[]` until a cell provisions
 * them — the same posture as the raw-event archive.
 */
import type { SpanObservation } from "./otlp";

/** Default Iceberg table the span archive Pipeline lands in; override via env. */
export const DEFAULT_SPAN_ARCHIVE_TABLE = "default.telemetry_spans";

/** Coerce an archive cell to a finite number (Iceberg may hand back a number or a numeric string). */
const asNumber = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);

        return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
};

/** Coerce an archive cell to a non-empty string. */
const asString = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** Drop keys whose value is `undefined` so optional fields are omitted, not set to `undefined` (exactOptionalPropertyTypes). */
const compact = <T extends Record<string, unknown>>(record: T): T => {
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(record)) {
        if (value !== undefined) {
            out[key] = value;
        }
    }

    return out as T;
};

/**
 * Map one archived row (the flat record `spanArchiveRecord` wrote) back to a
 * {@link SpanObservation}. Tolerant: a missing/mistyped column is dropped rather
 * than thrown on, and required fields fall back so a partial row still places on
 * the waterfall. Each cell is coerced exactly once, then {@link compact} strips
 * the optional fields that came back `undefined`.
 */
export const archiveRowToObservation = (row: Record<string, unknown>): SpanObservation => {
    const startedAt = asNumber(row.startedAt) ?? 0;
    const endedAt = asNumber(row.endedAt) ?? startedAt;
    const kind = row.kind === "container" || row.kind === "generation" ? row.kind : "worker";

    return compact({
        completionTokens: asNumber(row.completionTokens),
        durationMs: asNumber(row.durationMs) ?? Math.max(endedAt - startedAt, 0),
        endedAt,
        functionPath: asString(row.functionPath),
        input: asString(row.input),
        kind,
        level: row.level === "error" ? "error" : "info",
        model: asString(row.model),
        name: asString(row.name) ?? "span",
        output: asString(row.output),
        parentSpanId: asString(row.parentSpanId),
        promptTokens: asNumber(row.promptTokens),
        serviceName: asString(row.serviceName),
        spanId: asString(row.spanId) ?? "",
        startedAt,
        statusMessage: asString(row.statusMessage),
        traceId: asString(row.traceId) ?? "",
    }) as SpanObservation;
};
