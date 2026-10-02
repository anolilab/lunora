/**
 * `ctx.analyticsSql` — read-only SQL over Cloudflare's Analytics SQL API, through
 * the Analytics SQL Workers binding (wrangler `analytics` key, ≥ 4.145.0) or the
 * API-token REST transport where there is no binding.
 */
export { createAnalyticsSql } from "./create-analytics-sql";
export type { AnalyticsSqlQueryErrorData } from "./error";
export { AnalyticsSqlQueryError } from "./error";
export { createAnalyticsSqlRest } from "./rest";
export type {
    AnalyticsSql,
    AnalyticsSqlBindingLike,
    AnalyticsSqlOptions,
    AnalyticsSqlParameter,
    AnalyticsSqlParams,
    AnalyticsSqlQueryResult,
    AnalyticsSqlRawResult,
    AnalyticsSqlRequest,
    AnalyticsSqlRestConfig,
    AnalyticsSqlStatistics,
} from "./types";
