/**
 * Telemetry store for the Cloud Observability pipeline (CLOUD-PLAN.md §
 * observability). Grouped issues/incidents are durable Lunora `.global()` rows
 * (written by `lunora/telemetry.ts`); this adapter owns the *non-relational* side
 * — fire-and-forget metrics (Analytics Engine) and raw-event archival (a
 * Pipeline → R2, read back later with R2 SQL). It is a thin domain layer over
 * `@lunora/bindings`, constructed directly (the control-plane worker is
 * hand-written, not codegen-emitted, so there is no `ctx.analytics`/`ctx.pipelines`).
 *
 * One interface, one Cloudflare-native impl: a higher-fidelity backend
 * (e.g. ClickHouse) can implement `TelemetryStore` later without touching the
 * ingest. Every method **no-ops when its binding is absent**, so ingest works
 * unchanged in local dev and wherever the telemetry bindings aren't provisioned.
 */
import type { AnalyticsEngineDatasetLike } from "@lunora/bindings/analytics";
import { createAnalytics } from "@lunora/bindings/analytics";
import type { PipelineBindingLike } from "@lunora/bindings/pipelines";
import { createPipelines } from "@lunora/bindings/pipelines";
import { createR2Sql, raw, sql, tableRef } from "@lunora/bindings/r2sql";

import { archiveRowToObservation, DEFAULT_SPAN_ARCHIVE_TABLE } from "./archive-read";
import type { MetricPoint, SpanObservation, TelemetryEvent } from "./otlp";

/** Per-ingest counts, recorded as one metric point for dashboards/alerts. */
export interface TelemetryCounts {
    incidents: number;
    issues: number;
    organizationId: string;
}

/** Max metric data points written to AE per ingest (bounds the fan-out). */
const MAX_METRIC_WRITES = 500;

/** The non-relational telemetry sink — metrics + raw archival. */
export interface TelemetryStore {
    /** Archive the raw decoded events (Pipeline → R2). No-op without the binding. */
    archiveEvents: (events: ReadonlyArray<TelemetryEvent>) => Promise<void>;
    /**
     * Tier spans to the columnar archive (Pipeline → R2/Iceberg), so the Traces
     * store scales past D1's hot 48 h window — read back with R2 SQL (an action,
     * 🌐). No-op without the binding. Each record is tagged `recordType: "span"`
     * and carries its `organizationId` so the archive is one queryable table.
     */
    archiveSpans: (observations: ReadonlyArray<SpanObservation>, organizationId: string) => Promise<void>;
    /**
     * Read one trace's spans back from the columnar archive (R2 SQL over Iceberg),
     * for traces older than D1's hot window. Returns `[]` when R2 SQL isn't
     * configured (no `R2_SQL_TOKEN`/bucket) or on any query failure — a best-effort
     * fallback, never a hard error. Requires the archive Pipeline to have landed
     * spans (🌐 per-cell provisioning).
     */
    readArchivedTrace: (input: { organizationId: string; traceId: string }) => Promise<SpanObservation[]>;
    /**
     * Read the archived spans in a `[from, to]` window (bounded by `limit`), so the
     * Traces list can fold older traces straight out of the columnar archive when
     * the browse window reaches past D1's hot retention. Same fail-open contract as
     * {@link readArchivedTrace}: `[]` when R2 SQL isn't configured or on any failure.
     */
    readArchivedSpansInWindow: (input: { from: number; limit: number; organizationId: string; to: number }) => Promise<SpanObservation[]>;
    /** Record one ingest's issue/incident counts as an AE data point. */
    recordCounts: (counts: TelemetryCounts) => void;
    /** Write each `ctx.metrics.*` measurement to AE (`/v1/metrics`). No-op without the binding. */
    recordMetrics: (points: ReadonlyArray<MetricPoint>, organizationId: string) => void;
}

/** Map a span observation to its flat archive record (the R2/Iceberg row shape). */
export const spanArchiveRecord = (observation: SpanObservation, organizationId: string): Record<string, unknown> => ({
    ...observation,
    organizationId,
    recordType: "span",
});

/** The telemetry bindings + config the store reads off the worker env (all optional). */
export interface TelemetryStoreEnv {
    /** Account id for the R2-SQL read-back endpoint. */
    CLOUDFLARE_ACCOUNT_ID?: string;
    /**
     * `fetch` implementation for the R2-SQL read-back. Defaults to the global
     * `fetch`; an action injects `ctx.fetch` (and tests inject a double), so the
     * archive read never touches the network in unit tests.
     */
    fetch?: typeof globalThis.fetch;
    /** Bearer token for R2 SQL (read the span archive). Absent → read-back no-ops. */
    R2_SQL_TOKEN?: string;
    TELEMETRY?: AnalyticsEngineDatasetLike;
    /** R2 bucket name backing the span archive's Iceberg table. */
    TELEMETRY_BUCKET_NAME?: string;
    TELEMETRY_PIPELINE?: PipelineBindingLike;
    /** Iceberg table the span archive lands in (`namespace.table`); defaults to `default.telemetry_spans`. */
    TELEMETRY_SPAN_TABLE?: string;
}

/**
 * Cloudflare-native {@link TelemetryStore}: metrics via Analytics Engine
 * (`blob1="telemetry.ingest"`, `blob2=org`, `double1=issues`, `double2=incidents`),
 * raw archival via a Pipeline. Both degrade to no-ops when their binding is
 * unset — the R2 bucket/Pipeline are provisioned only in the hosted cells.
 */
export const createCloudflareTelemetryStore = (env: TelemetryStoreEnv): TelemetryStore => {
    return {
        archiveEvents: async (events) => {
            if (!env.TELEMETRY_PIPELINE || events.length === 0) {
                return;
            }

            // TelemetryEvent is a fixed-shape record; the Pipeline stream stores it as JSON.
            await createPipelines({ binding: env.TELEMETRY_PIPELINE }).send(events as unknown as Record<string, unknown>[]);
        },
        archiveSpans: async (observations, organizationId) => {
            if (!env.TELEMETRY_PIPELINE || observations.length === 0) {
                return;
            }

            await createPipelines({ binding: env.TELEMETRY_PIPELINE }).send(observations.map((observation) => spanArchiveRecord(observation, organizationId)));
        },
        recordCounts: (counts) => {
            if (!env.TELEMETRY) {
                return;
            }

            createAnalytics(env.TELEMETRY).writeDataPoint({
                blobs: ["telemetry.ingest", counts.organizationId],
                doubles: [counts.issues, counts.incidents],
                indexes: [counts.organizationId],
            });
        },
        readArchivedTrace: async ({ organizationId, traceId }) => {
            if (!env.R2_SQL_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !env.TELEMETRY_BUCKET_NAME) {
                return [];
            }

            try {
                const client = createR2Sql({
                    accountId: env.CLOUDFLARE_ACCOUNT_ID,
                    apiToken: env.R2_SQL_TOKEN,
                    bucket: env.TELEMETRY_BUCKET_NAME,
                    ...(env.fetch ? { fetch: env.fetch } : {}),
                });
                // The table name is trusted config, but `tableRef` still validates it
                // (a `namespace.table` shape) before `raw` splices it verbatim — so a
                // fat-fingered env var throws here (caught below → D1-only fallback)
                // rather than forming odd SQL. Values stay bound via the escaping `sql` tag.
                const table = tableRef(env.TELEMETRY_SPAN_TABLE ?? DEFAULT_SPAN_ARCHIVE_TABLE);
                const result = await client.query(
                    sql`SELECT * FROM ${raw(table)} WHERE recordType = ${"span"} AND organizationId = ${organizationId} AND traceId = ${traceId} ORDER BY startedAt`,
                );

                return (result.rows ?? []).map((row) => archiveRowToObservation(row));
            } catch {
                // R2 SQL unreachable / table absent — degrade to the D1-only view.
                return [];
            }
        },
        readArchivedSpansInWindow: async ({ from, limit, organizationId, to }) => {
            if (!env.R2_SQL_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !env.TELEMETRY_BUCKET_NAME) {
                return [];
            }

            try {
                const client = createR2Sql({
                    accountId: env.CLOUDFLARE_ACCOUNT_ID,
                    apiToken: env.R2_SQL_TOKEN,
                    bucket: env.TELEMETRY_BUCKET_NAME,
                    ...(env.fetch ? { fetch: env.fetch } : {}),
                });
                const table = tableRef(env.TELEMETRY_SPAN_TABLE ?? DEFAULT_SPAN_ARCHIVE_TABLE);
                // Newest-first, bounded — the caller folds these into trace rollups.
                const result = await client.query(
                    sql`SELECT * FROM ${raw(table)} WHERE recordType = ${"span"} AND organizationId = ${organizationId} AND startedAt >= ${from} AND startedAt <= ${to} ORDER BY startedAt DESC LIMIT ${limit}`,
                );

                return (result.rows ?? []).map((row) => archiveRowToObservation(row));
            } catch {
                return [];
            }
        },
        recordMetrics: (points, organizationId) => {
            if (!env.TELEMETRY || points.length === 0) {
                return;
            }

            const analytics = createAnalytics(env.TELEMETRY);

            for (const point of points.slice(0, MAX_METRIC_WRITES)) {
                analytics.writeDataPoint({
                    blobs: [point.name, point.kind, point.functionPath ?? "", organizationId, point.serviceName ?? ""],
                    doubles: [point.value],
                    // Sample per metric name so AE keeps per-metric resolution.
                    indexes: [point.name],
                });
            }
        },
    };
};
