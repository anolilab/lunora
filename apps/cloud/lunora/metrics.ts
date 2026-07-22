import type { MetricSeries } from "../src/telemetry/metrics-read";
import { createMetricsReader, DEFAULT_METRICS_WINDOW_MS } from "../src/telemetry/metrics-read";
import { action, v } from "./_generated/server.js";
import { assertMember } from "./authz";

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
