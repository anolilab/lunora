import { AnalyticsSqlQueryError } from "./error";
import type { AnalyticsSql, AnalyticsSqlOptions, AnalyticsSqlParams, AnalyticsSqlQueryResult, AnalyticsSqlRawResult } from "./types";

/** Read the binding error's `retryable` flag; anything that does not carry one is treated as not retryable. */
const isRetryable = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable === true;

/** The binding error's message, for the capped preview in ours. */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Build the action-only {@link AnalyticsSql} client bound to `ctx.analyticsSql`.
 *
 * `binding` is the Analytics SQL binding (`env.ANALYTICS_SQL`, the wrangler
 * `analytics` key) or, in a worker without one, the API-token transport from
 * `createAnalyticsSqlRest`. Both speak the same Analytics SQL dialect, so a
 * statement written against one runs unchanged on the other; the binding derives
 * the account from the Worker, the REST transport sends it as `scope.accountTag`.
 *
 * ```ts
 * const analyticsSql = createAnalyticsSql({ binding: env.ANALYTICS_SQL });
 * const { rows } = await analyticsSql.query<{ calls: number }>(
 *     `SELECT COUNT(*) AS calls FROM events.analyticsEngine.app WHERE timestamp >= $since`,
 *     { since: new Date(Date.now() - 3_600_000).toISOString() },
 * );
 * ```
 *
 * A rejected query surfaces as an {@link AnalyticsSqlQueryError} carrying the
 * binding's `retryable` flag. Nothing is retried here.
 */
// eslint-disable-next-line import/prefer-default-export -- named export: the subpath barrel re-exports by name, per the repo's no-default-mixing convention
export const createAnalyticsSql = (options: AnalyticsSqlOptions): AnalyticsSql => {
    const { binding } = options;

    return {
        query: async <T extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            params?: AnalyticsSqlParams,
        ): Promise<AnalyticsSqlQueryResult<T>> => {
            let raw: AnalyticsSqlRawResult<T>;

            try {
                raw = await binding.query<T>({ query: sql, ...(params === undefined ? {} : { params }) });
            } catch (error: unknown) {
                if (error instanceof AnalyticsSqlQueryError) {
                    throw error;
                }

                throw new AnalyticsSqlQueryError(messageOf(error), { cause: error, retryable: isRetryable(error) });
            }

            return {
                rowCount: raw.rows,
                rows: raw.data,
                ...(raw.statistics === undefined ? {} : { statistics: raw.statistics }),
            };
        },
    };
};
