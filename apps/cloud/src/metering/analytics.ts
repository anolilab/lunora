/**
 * Platform metering source (CLOUD-PLAN.md §4) — a thin domain layer over
 * `@lunora/analytics`. The dispatcher emits one request data point per tenant
 * request to a Cloudflare Analytics Engine dataset (the cheap, fire-and-forget
 * request-path source); a control-plane rollup reads it back through the AE SQL
 * API and folds it into the `platformUsage` ledger. The write helper no-ops when
 * the binding is absent; the reader is a port with an HTTP impl (built on
 * `createAnalyticsSqlClient`) so the rollup is unit-testable with a fake fetch.
 */
import type { AnalyticsEngineDatasetLike } from "@lunora/analytics";
import { createAnalytics, createAnalyticsSqlClient } from "@lunora/analytics";

export type { AnalyticsEngineDatasetLike } from "@lunora/analytics";

/** Emit one request data point: `blob1=script`, `blob2=plan`, `double1=count`. */
export const recordRequestUsage = (dataset: AnalyticsEngineDatasetLike | undefined, input: { plan: string; scriptName: string }): void => {
    if (!dataset) {
        return;
    }

    createAnalytics(dataset).writeDataPoint({ blobs: [input.scriptName, input.plan], doubles: [1], indexes: [input.scriptName] });
};

/** A row read back from the AE dataset, summed per script over a window. */
export interface AnalyticsUsageRow {
    requests: number;
    scriptName: string;
}

/** Port: read aggregated request usage since `sinceMs` from the metering source. */
export interface AnalyticsUsageReader {
    readRequestUsage: (sinceMs: number) => Promise<AnalyticsUsageRow[]>;
}

interface AnalyticsReaderOptions {
    accountId: string;
    apiToken: string;
    /** AE dataset name the dispatcher writes to. */
    dataset: string;
    fetch?: typeof globalThis.fetch;
}

/**
 * HTTP `AnalyticsUsageReader` over the Analytics Engine SQL API (via
 * `@lunora/analytics`'s read client). Runs at the edge (needs the account API
 * token); the SQL groups request counts per script over the window.
 */
export const createHttpAnalyticsReader = (options: AnalyticsReaderOptions): AnalyticsUsageReader => {
    const sql = createAnalyticsSqlClient({ accountId: options.accountId, apiToken: options.apiToken, fetch: options.fetch });

    return {
        readRequestUsage: async (sinceMs) => {
            const sinceSeconds = Math.floor(sinceMs / 1000);
            const result = await sql.query(
                `SELECT blob1 AS scriptName, SUM(double1) AS requests FROM ${options.dataset} WHERE timestamp > toDateTime(${String(sinceSeconds)}) GROUP BY scriptName`,
            );

            return result.rows.map((row) => {
                return {
                    requests: typeof row.requests === "number" ? row.requests : Number(row.requests ?? 0),
                    scriptName: typeof row.scriptName === "string" ? row.scriptName : "",
                };
            });
        },
    };
};
