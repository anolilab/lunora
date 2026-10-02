/**
 * The API-token transport over Cloudflare's **Analytics SQL API**, shaped like
 * the Analytics SQL binding so `createAnalyticsSql` can take either.
 *
 * `POST https://api.cloudflare.com/client/v4/analytics/sql` with a JSON body
 * `{ query, params, scope: { accountTag } }` and `Authorization: Bearer <token>`.
 * This is the same SQL API and dialect the binding fronts (the binding derives
 * the account from the Worker; this sends it as `scope.accountTag`). It is NOT
 * the older Workers Analytics Engine SQL API that `createAnalyticsSqlClient` in
 * `@lunora/bindings/analytics` calls, whose dialect differs.
 * @see https://developers.cloudflare.com/analytics/sql-api/query-api/
 */
import { AnalyticsSqlQueryError } from "./error";
import type { AnalyticsSqlBindingLike, AnalyticsSqlRawResult, AnalyticsSqlRequest, AnalyticsSqlRestConfig } from "./types";

const SQL_API_ENDPOINT = "https://api.cloudflare.com/client/v4/analytics/sql";

/** Default for `timeoutMs`: analytical scans legitimately run tens of seconds, but an unresponsive endpoint must not hold an action open. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** The statuses Cloudflare's SQL API error reference says may be retried: rate/resource limits and transient outages. */
const RETRYABLE_STATUSES = new Set([429, 500, 503, 507]);

/**
 * Build an {@link AnalyticsSqlBindingLike} that runs each query over the REST
 * endpoint with an account API token (Account Analytics Read). Use it where the
 * Worker has no `analytics` binding — a wrangler older than 4.145.0, or a host
 * that is not a Worker — and hand it to `createAnalyticsSql({ binding })` or
 * `defineApp().analyticsSql((env) => createAnalyticsSqlRest({ … }))`.
 *
 * The token is a secret: read it from `env`, never from a browser.
 */
// eslint-disable-next-line import/prefer-default-export -- named export: the subpath barrel re-exports by name, per the repo's no-default-mixing convention
export const createAnalyticsSqlRest = (config: AnalyticsSqlRestConfig): AnalyticsSqlBindingLike => {
    const fetchImpl = config.fetch ?? globalThis.fetch;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const query = async <T extends Record<string, unknown> = Record<string, unknown>>(request: AnalyticsSqlRequest): Promise<AnalyticsSqlRawResult<T>> => {
        // One deadline bounds the fetch AND the body read: a hang after the
        // headers is the harder failure to notice.
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort();
        }, timeoutMs);

        try {
            const response = await fetchImpl(SQL_API_ENDPOINT, {
                body: JSON.stringify({
                    query: request.query,
                    ...(request.params === undefined ? {} : { params: request.params }),
                    scope: { accountTag: config.accountId },
                }),
                headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
                method: "POST",
                signal: controller.signal,
            });

            if (!response.ok) {
                // Errors are usually a text/plain, customer-safe description;
                // gateway auth failures use the JSON envelope. Either way the
                // status is the diagnosis and the body is detail.
                const body = await response.text().catch(() => "<error body unavailable>");

                throw new AnalyticsSqlQueryError(`${String(response.status)} ${body}`, {
                    cause: body,
                    retryable: RETRYABLE_STATUSES.has(response.status),
                    status: response.status,
                });
            }

            let raw: unknown;

            try {
                raw = await response.json();
            } catch (error) {
                if (controller.signal.aborted) {
                    throw error;
                }

                throw new AnalyticsSqlQueryError("the SQL API returned a non-JSON body", { cause: error, retryable: false, status: 502 });
            }

            const body = raw as Partial<AnalyticsSqlRawResult<T>> | null;

            if (body === null || typeof body !== "object" || !Array.isArray(body.data)) {
                throw new AnalyticsSqlQueryError("the SQL API returned a body without a data array", { cause: raw, retryable: false, status: 502 });
            }

            return {
                data: body.data,
                rows: typeof body.rows === "number" ? body.rows : body.data.length,
                ...(body.statistics === undefined ? {} : { statistics: body.statistics }),
            };
        } catch (error) {
            if (controller.signal.aborted && !(error instanceof AnalyticsSqlQueryError)) {
                throw new AnalyticsSqlQueryError(`query timed out after ${String(timeoutMs)}ms (AnalyticsSqlRestConfig.timeoutMs)`, {
                    cause: error,
                    retryable: true,
                    status: 504,
                });
            }

            throw error;
        } finally {
            clearTimeout(timeout);
        }
    };

    return { query };
};
