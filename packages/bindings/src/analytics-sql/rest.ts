/**
 * The API-token transport over Cloudflare's **Analytics SQL API**, shaped like
 * the Analytics SQL binding so `createAnalyticsSql` can take either.
 *
 * `POST https://api.cloudflare.com/client/v4/analytics/sql` with a JSON body
 * `{ query, params, scope: { accountTag } }` and `Authorization: Bearer <token>`.
 * This is the same SQL API and dialect the binding fronts: the binding derives
 * the account from the Worker, this sends it as `scope.accountTag`.
 * @see https://developers.cloudflare.com/analytics/sql-api/query-api/
 */
import { sqlRestPost } from "../../../../shared/sql-rest-post";
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
 * Every failure is an {@link AnalyticsSqlQueryError}: a non-2xx (`429` / `500`
 * / `503` / `507` retryable), a malformed body (not retryable), the deadline
 * (`504`, retryable), or the request never reaching the API — DNS, a reset
 * connection — which is retryable too. Nothing is retried here.
 *
 * The token is a secret: read it from `env`, never from a browser.
 */
// eslint-disable-next-line import/prefer-default-export -- named export: the subpath barrel re-exports by name, per the repo's no-default-mixing convention
export const createAnalyticsSqlRest = (config: AnalyticsSqlRestConfig): AnalyticsSqlBindingLike => {
    const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const query = async <T extends Record<string, unknown> = Record<string, unknown>>(request: AnalyticsSqlRequest): Promise<AnalyticsSqlRawResult<T>> => {
        let outcome: Awaited<ReturnType<typeof sqlRestPost>>;

        try {
            outcome = await sqlRestPost({
                apiToken: config.apiToken,
                body: {
                    query: request.query,
                    ...(request.params === undefined ? {} : { params: request.params }),
                    scope: { accountTag: config.accountId },
                },
                fetch: fetchImpl,
                timeoutMs,
                url: SQL_API_ENDPOINT,
            });
        } catch (error) {
            // The request never got an answer: a network failure, not a verdict
            // on the query, so repeating it may succeed.
            throw new AnalyticsSqlQueryError(`the request did not reach the SQL API: ${String(error)}`, { cause: error, retryable: true, status: 502 });
        }

        if ("timedOut" in outcome) {
            throw new AnalyticsSqlQueryError(`query timed out after ${String(timeoutMs)}ms (AnalyticsSqlRestConfig.timeoutMs)`, {
                retryable: true,
                status: 504,
            });
        }

        if (!outcome.ok) {
            // Errors are usually a text/plain, customer-safe description; gateway
            // auth failures use the JSON envelope. Either way the status is the
            // diagnosis and the body is detail.
            throw new AnalyticsSqlQueryError(`${String(outcome.status)} ${outcome.text}`, {
                cause: outcome.text,
                retryable: RETRYABLE_STATUSES.has(outcome.status),
                status: outcome.status,
            });
        }

        const body = outcome.json as Partial<AnalyticsSqlRawResult<T>> | null;

        if (body === null || typeof body !== "object" || !Array.isArray(body.data)) {
            throw new AnalyticsSqlQueryError("the SQL API returned a body without a data array", { cause: outcome.json, retryable: false, status: 502 });
        }

        return {
            data: body.data,
            rows: typeof body.rows === "number" ? body.rows : body.data.length,
            ...(body.statistics === undefined ? {} : { statistics: body.statistics }),
        };
    };

    return { query };
};
