/**
 * Platform metering source (CLOUD-PLAN.md §4). The dispatcher emits one data
 * point per tenant request to a Cloudflare **Analytics Engine** dataset — the
 * cheap, fire-and-forget, request-path metering source. A control-plane rollup
 * reads the dataset back through the AE SQL API (`AnalyticsUsageReader`) and
 * folds it into the `platformUsage` ledger. Both sides are seams: the writer
 * no-ops when the binding is absent, and the reader is a port with an HTTP impl
 * so the rollup is unit-testable with a fake.
 */

/** The subset of Cloudflare's Analytics Engine binding we use. */
export interface AnalyticsEngineDataset {
    writeDataPoint: (event: { blobs?: string[]; doubles?: number[]; indexes?: string[] }) => void;
}

/** Emit one request data point: `blob1=script`, `blob2=plan`, `double1=count`. */
export const recordRequestUsage = (dataset: AnalyticsEngineDataset | undefined, input: { plan: string; scriptName: string }): void => {
    dataset?.writeDataPoint({ blobs: [input.scriptName, input.plan], doubles: [1], indexes: [input.scriptName] });
};

/** A row read back from the AE dataset, summed per script over a window. */
export interface AnalyticsUsageRow {
    organizationId?: string;
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
    fetch?: typeof fetch;
}

interface AnalyticsSqlResponse {
    data?: { requests?: number | string; scriptName?: string }[];
}

/**
 * HTTP `AnalyticsUsageReader` over the Analytics Engine SQL API. Runs at the
 * edge (needs the account API token); the SQL groups request counts per script
 * over the window.
 */
export const createHttpAnalyticsReader = (options: AnalyticsReaderOptions): AnalyticsUsageReader => {
    const fetchImpl = options.fetch ?? fetch;

    return {
        readRequestUsage: async (sinceMs) => {
            const sinceSeconds = Math.floor(sinceMs / 1000);
            const sql = `SELECT blob1 AS scriptName, SUM(double1) AS requests FROM ${options.dataset} WHERE timestamp > toDateTime(${String(sinceSeconds)}) GROUP BY scriptName`;
            const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/analytics_engine/sql`, {
                body: sql,
                headers: { authorization: `Bearer ${options.apiToken}` },
                method: "POST",
            });

            if (!response.ok) {
                throw new Error(`analytics read failed: ${String(response.status)}`);
            }

            const payload: AnalyticsSqlResponse = await response.json();

            return (payload.data ?? []).map((row) => {
                return { requests: Number(row.requests ?? 0), scriptName: row.scriptName ?? "" };
            });
        },
    };
};
