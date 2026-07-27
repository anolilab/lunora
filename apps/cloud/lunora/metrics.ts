import { LunoraError } from "@lunora/server";

import type { StoredMetricPoint } from "../src/telemetry/metric-series";
import { foldMetricSeries } from "../src/telemetry/metric-series";
import type { MetricSeries } from "../src/telemetry/metrics-read";
import { createMetricsReader, DEFAULT_METRICS_WINDOW_MS } from "../src/telemetry/metrics-read";
import type { Id } from "./_generated/dataModel.js";
import { action, internalMutation, mutation, query, v } from "./_generated/server.js";
import { assertMember, authorizeTelemetryKey } from "./authz";

/**
 * Cloud metrics trend read (GAPS.md ring 3 "metrics trend UI"). Tenant
 * `ctx.metrics.*` measurements land in Analytics Engine (`store.ts`
 * `recordMetrics`) with no UI; this action reads them back as per-metric time
 * series for the dashboard Metrics tab's sparklines.
 *
 * An **action**, not a query: the read is a `fetch` over the AE SQL API, and the
 * account id / API token live in `ctx.env` (the `lunora/env.ts` contract) — both
 * action-only. Fails **open** to `[]` when AE creds aren't configured (the common
 * case until a cell provisions them) or on any read failure, so the tab shows an
 * empty state rather than erroring. The AE read is sampled + bucket-averaged (an
 * approximate trend, not exact points) — see `src/telemetry/metrics-read.ts` for
 * the honest limit. Members only.
 */

/** One metric series as the dashboard consumes it — mirrors {@link MetricSeries} locally so codegen inlines it. */
interface MetricSeriesView {
    firstValue: number;
    functionPath?: string;
    kind: string;
    lastValue: number;
    name: string;
    points: { t: number; value: number }[];
    trend: number;
}

/** The env keys this action reads off `ctx.env` (the validated `lunora/env.ts` contract). */
interface MetricsEnv {
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
    TELEMETRY_DATASET?: string;
}

/** Project the read-model series onto the wire view (identity + trend points). */
const toView = (series: MetricSeries): MetricSeriesView => ({
    firstValue: series.firstValue,
    functionPath: series.functionPath,
    kind: series.kind,
    lastValue: series.lastValue,
    name: series.name,
    points: series.points.map((point) => ({ t: point.t, value: point.value })),
    trend: series.trend,
});

/**
 * Per-metric trend series for the org over the `[from, to]` window (defaults to
 * the last {@link DEFAULT_METRICS_WINDOW_MS}). Empty when AE creds are absent or
 * the read fails — never throws on the dashboard's read path.
 */
export const list = action
    .input({
        from: v.optional(v.number()),
        organizationId: v.id("organizations"),
        to: v.optional(v.number()),
    })
    .action(async ({ ctx: context, args }): Promise<MetricSeriesView[]> => {
        await assertMember(context, args.organizationId);

        const environment = (context.env ?? {}) as MetricsEnv;

        // Fail open: no AE account creds → no metric series (the archive/metrics
        // read paths are 🌐-gated on per-cell provisioning, like the write side).
        if (!environment.CLOUDFLARE_ACCOUNT_ID || !environment.CLOUDFLARE_API_TOKEN) {
            return [];
        }

        const reader = createMetricsReader({
            accountId: environment.CLOUDFLARE_ACCOUNT_ID,
            apiToken: environment.CLOUDFLARE_API_TOKEN,
            dataset: environment.TELEMETRY_DATASET ?? "TELEMETRY",
            fetch: context.fetch,
        });

        const from = args.from ?? Date.now() - DEFAULT_METRICS_WINDOW_MS;

        try {
            const series = await reader.readSeries({ from, organizationId: args.organizationId, ...(args.to === undefined ? {} : { to: args.to }) });

            return series.map(toView);
        } catch {
            // AE SQL unreachable / dataset absent — degrade to an empty trend view.
            return [];
        }
    });

/** Batch cap on the metric points one ingest call may carry. */
const MAX_METRIC_POINTS = 1000;

/** One metric-point input row — the router flattens each OTLP data point to this. */
const metricPointInput = v.object({
    at: v.number(),
    functionPath: v.optional(v.string()),
    kind: v.string(),
    name: v.string(),
    serviceName: v.optional(v.string()),
    value: v.number(),
});

/**
 * Ingest exact metric points into D1 (deploy-key authorized — the tenant sink
 * holds an org deploy key). Mirrors `telemetry.ingest` for spans: the `/v1/metrics`
 * route flattens OTLP data points and calls this alongside the AE mirror, so the
 * Metrics UI can read exact per-bucket series from {@link series}.
 */
export const ingest = mutation
    .input({
        deployKey: v.string(),
        deploymentId: v.optional(v.id("deployments")),
        organizationId: v.id("organizations"),
        points: v.array(metricPointInput),
    })
    .mutation(async ({ ctx: context, args }): Promise<{ ingested: number }> => {
        await authorizeTelemetryKey(context, args.organizationId, args.deployKey);

        if (args.points.length > MAX_METRIC_POINTS) {
            throw new LunoraError("BAD_REQUEST", `batch too large (max ${String(MAX_METRIC_POINTS)} points)`);
        }

        const now = Date.now();

        for (const point of args.points) {
            // eslint-disable-next-line no-await-in-loop -- bounded batch; sequential keeps the writer simple
            await context.db.insert("metricPoints", { ...point, createdAt: now, deploymentId: args.deploymentId, organizationId: args.organizationId });
        }

        return { ingested: args.points.length };
    });

/** Recent metric points scanned before folding into exact series (bounds the read). */
const METRIC_SCAN_LIMIT = 5000;

/** One stored metric-point row, as {@link series} reads it. */
interface MetricPointRow extends StoredMetricPoint {
    _id: Id<"metricPoints">;
    organizationId: Id<"organizations">;
}

/**
 * Exact per-metric series from the D1 `metricPoints` store over `[from, to]` —
 * every stored point averaged per bucket (precise, not sampled like the AE
 * {@link list}). A plain **query** (D1 read); members only. The UI prefers this
 * for the hot window and falls back to {@link list} (AE) only for ranges older
 * than D1 retention.
 */
export const series = query
    .input({
        from: v.optional(v.number()),
        organizationId: v.id("organizations"),
        to: v.optional(v.number()),
    })
    .query(async ({ ctx: context, args }): Promise<MetricSeriesView[]> => {
        await assertMember(context, args.organizationId);

        const from = args.from ?? Date.now() - DEFAULT_METRICS_WINDOW_MS;
        const to = args.to ?? Date.now();

        const { page } = await context.db.metricPoints.findMany({
            limit: METRIC_SCAN_LIMIT,
            orderBy: [{ at: "desc" }],
            where: { organizationId: args.organizationId },
        });

        const points = (page as unknown as MetricPointRow[]).filter((row) => row.at >= from && row.at <= to);

        return foldMetricSeries(points).map(toView);
    });

/** Exact metric points older than this are pruned from D1's hot window (matches span observations). */
export const METRIC_POINT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** One stored metric point, for the retention scan. */
interface MetricRetentionRow {
    _id: Id<"metricPoints">;
    at: number;
}

/** Delete exact metric points past retention. SYSTEM only (cron dispatch). */
export const prune = internalMutation.mutation(async ({ ctx: context }): Promise<{ pruned: number }> => {
    const cutoff = Date.now() - METRIC_POINT_RETENTION_MS;
    const { page } = await context.db.metricPoints.findMany({});
    const stale = (page as unknown as MetricRetentionRow[]).filter((row) => row.at < cutoff);

    for (const row of stale) {
        // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
        await context.db.delete(row._id);
    }

    return { pruned: stale.length };
});
