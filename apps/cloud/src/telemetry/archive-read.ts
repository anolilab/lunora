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

/**
 * Map one archived row (the flat record `spanArchiveRecord` wrote) back to a
 * {@link SpanObservation}. Tolerant: a missing/mistyped column is dropped rather
 * than thrown on, and required fields fall back so a partial row still places on
 * the waterfall.
 */
export const archiveRowToObservation = (row: Record<string, unknown>): SpanObservation => {
    const startedAt = asNumber(row.startedAt) ?? 0;
    const endedAt = asNumber(row.endedAt) ?? startedAt;
    const kind = row.kind === "container" || row.kind === "generation" ? row.kind : "worker";

    return {
        ...(asNumber(row.completionTokens) === undefined ? {} : { completionTokens: asNumber(row.completionTokens) }),
        durationMs: asNumber(row.durationMs) ?? Math.max(endedAt - startedAt, 0),
        endedAt,
        ...(asString(row.functionPath) === undefined ? {} : { functionPath: asString(row.functionPath) }),
        ...(asString(row.input) === undefined ? {} : { input: asString(row.input) }),
        kind,
        level: row.level === "error" ? "error" : "info",
        ...(asString(row.model) === undefined ? {} : { model: asString(row.model) }),
        name: asString(row.name) ?? "span",
        ...(asString(row.output) === undefined ? {} : { output: asString(row.output) }),
        ...(asString(row.parentSpanId) === undefined ? {} : { parentSpanId: asString(row.parentSpanId) }),
        ...(asNumber(row.promptTokens) === undefined ? {} : { promptTokens: asNumber(row.promptTokens) }),
        ...(asString(row.serviceName) === undefined ? {} : { serviceName: asString(row.serviceName) }),
        spanId: asString(row.spanId) ?? "",
        startedAt,
        ...(asString(row.statusMessage) === undefined ? {} : { statusMessage: asString(row.statusMessage) }),
        traceId: asString(row.traceId) ?? "",
    };
};
