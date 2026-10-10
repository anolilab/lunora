/**
 * `GET /v1/platform/metrics?hours=24` — the platform's own metrics (GAPS.md E1):
 * dispatcher p50/p95 latency and outcomes per cell, build/deploy queue depth
 * over time, provisioning failures by step and reason.
 *
 * Operator-only: it sits in the router's admin table, whose `withAdminToken` guard
 * gates it on `LUNORA_ADMIN_TOKEN` before this runs.
 * Nothing here is org-scoped, so a session must never reach it.
 */
import { DEFAULT_PLATFORM_METRICS_DATASET, readPlatformMetrics } from "../../telemetry/platform-metrics-read";
import type { RouterEnv } from "./shared";
import { jsonError } from "./shared";

const DEFAULT_HOURS = 24;

/** AE keeps ~90 days; a month is the widest window worth one request. */
const MAX_HOURS = 24 * 31;

export const handlePlatformMetricsRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = environment;

    if (!accountId || !apiToken) {
        return jsonError(501, "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are needed to read Analytics Engine");
    }

    const requested = Number(new URL(request.url).searchParams.get("hours") ?? DEFAULT_HOURS);
    const hours = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_HOURS) : DEFAULT_HOURS;
    const to = Date.now();
    const from = to - hours * 60 * 60 * 1000;

    try {
        const snapshot = await readPlatformMetrics(
            { accountId, apiToken, dataset: environment.PLATFORM_METRICS_DATASET ?? DEFAULT_PLATFORM_METRICS_DATASET },
            { from, to },
        );

        return Response.json({ from, to, ...snapshot });
    } catch (error) {
        return jsonError(502, `Analytics Engine read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
};
