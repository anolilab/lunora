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

import type { MetricPoint, TelemetryEvent } from "./otlp";

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
    /** Record one ingest's issue/incident counts as an AE data point. */
    recordCounts: (counts: TelemetryCounts) => void;
    /** Write each `ctx.metrics.*` measurement to AE (`/v1/metrics`). No-op without the binding. */
    recordMetrics: (points: ReadonlyArray<MetricPoint>, organizationId: string) => void;
}

/** The telemetry bindings the store reads off the worker env (all optional). */
export interface TelemetryStoreEnv {
    TELEMETRY?: AnalyticsEngineDatasetLike;
    TELEMETRY_PIPELINE?: PipelineBindingLike;
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
