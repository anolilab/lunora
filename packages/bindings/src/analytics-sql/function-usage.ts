/**
 * The fixed usage queries behind Studio's Analytics tab, built **server-side**.
 *
 * The host's Studio runner sends only a {@link FunctionUsagePanel} key; the
 * action that answers it builds the statement here and runs it through
 * `ctx.analyticsSql`. An action that ran caller-supplied SQL instead would let
 * anyone who can call it read every dataset in the account.
 *
 * The columns are `@lunora/bindings/analytics`'s `track()` layout — `blob1` the
 * event name, `blob2` the function path, `blob3` the shard, `double1` the handler
 * duration — so these read the data points `ctx.analytics.track("function_call", …)`
 * emits.
 */
import type { AnalyticsSqlRequest } from "./types";

/** The Studio usage panels, in display order. */
const FUNCTION_USAGE_PANELS = ["volume", "latency", "hotShards"] as const;

/** One Studio usage panel. */
type FunctionUsagePanel = (typeof FUNCTION_USAGE_PANELS)[number];

/** Options for {@link functionUsageQuery}. */
interface FunctionUsageQueryOptions {
    /** The Analytics Engine dataset (`analytics_engine_datasets[].dataset`). Defaults to `ANALYTICS`, the one reconcile writes. */
    dataset?: string;
    /** Lower `timestamp` bound, an ISO-8601 string. Defaults to 24 hours before now. The dialect requires one. */
    since?: string;
}

/** Default lookback when no `since` is given. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Each panel's statement over the quoted `events.analyticsEngine` table; `$since` is bound, never spliced. */
const PANEL_SQL: Readonly<Record<FunctionUsagePanel, (table: string) => string>> = {
    hotShards: (table) =>
        `SELECT blob3 AS shard, COUNT(*) AS calls FROM ${table} WHERE timestamp >= $since AND blob1 = 'function_call' GROUP BY shard ORDER BY calls DESC LIMIT 25`,
    // The SQL API sample-weights COUNT on its own; quantileWeighted takes the weight explicitly.
    latency: (table) =>
        `SELECT blob2 AS fn, quantileWeighted(0.50, double1, sampleInterval) AS p50, quantileWeighted(0.95, double1, sampleInterval) AS p95 FROM ${table} WHERE timestamp >= $since AND blob1 = 'function_call' GROUP BY fn ORDER BY p95 DESC LIMIT 25`,
    volume: (table) =>
        `SELECT blob2 AS fn, COUNT(*) AS calls FROM ${table} WHERE timestamp >= $since AND blob1 = 'function_call' GROUP BY fn ORDER BY calls DESC LIMIT 25`,
};

/** Whether `value` names a {@link FunctionUsagePanel} — for validating the key an action receives. */
const isFunctionUsagePanel = (value: unknown): value is FunctionUsagePanel =>
    typeof value === "string" && (FUNCTION_USAGE_PANELS as ReadonlyArray<string>).includes(value);

/**
 * The statement and `$since` parameter for one Studio usage panel, to run with
 * `ctx.analyticsSql.query(request.query, request.params)`.
 *
 * The dataset is quoted as an identifier (embedded `"` doubled). It comes from
 * your code, not from the caller.
 */
const functionUsageQuery = (panel: FunctionUsagePanel, options: FunctionUsageQueryOptions = {}): AnalyticsSqlRequest & { params: { since: string } } => {
    const dataset = options.dataset ?? "ANALYTICS";
    const since = options.since ?? new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString();

    return { params: { since }, query: PANEL_SQL[panel](`events.analyticsEngine."${dataset.replaceAll('"', '""')}"`) };
};

export { FUNCTION_USAGE_PANELS, functionUsageQuery, isFunctionUsagePanel };
export type { FunctionUsagePanel, FunctionUsageQueryOptions };
