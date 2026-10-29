import { LunoraError } from "@lunora/errors";

import { capErrorBody } from "../../../../shared/cap-error-body";

/** What an {@link AnalyticsSqlQueryError} carries on `data`, so a client can decide to retry. */
interface AnalyticsSqlQueryErrorData {
    /** Whether repeating the same query may succeed (rate, concurrency or resource limits, transient outages). */
    retryable: boolean;
}

/**
 * A failed Analytics SQL query, from either transport: the binding rejecting
 * (its error's `retryable` flag is kept), or the REST endpoint answering
 * non-2xx (`429` / `500` / `503` / `507` are retryable, per Cloudflare's SQL
 * API error reference) or timing out (`504`, retryable).
 *
 * Neither transport retries. The message embeds at most a capped preview of the
 * upstream text, because `ANALYTICS_SQL_QUERY_ERROR` is client-safe and SQL API
 * errors quote the statement back; the full text stays on `cause`.
 */
class AnalyticsSqlQueryError extends LunoraError {
    public readonly retryable: boolean;

    public constructor(detail: string, options: { cause?: unknown; retryable: boolean; status?: number }) {
        const data: AnalyticsSqlQueryErrorData = { retryable: options.retryable };

        super("ANALYTICS_SQL_QUERY_ERROR", `Analytics SQL query failed: ${capErrorBody(detail)}`, {
            cause: options.cause ?? detail,
            data,
            name: "AnalyticsSqlQueryError",
            ...(options.status === undefined ? {} : { status: options.status }),
        });

        this.retryable = options.retryable;
    }
}

export { AnalyticsSqlQueryError };
export type { AnalyticsSqlQueryErrorData };
