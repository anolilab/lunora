/**
 * Read-side client over the Analytics Engine **SQL API**.
 *
 * AE has no binding-side read path — data is queried out-of-band through
 * Cloudflare's REST SQL endpoint:
 * `POST https://api.cloudflare.com/client/v4/accounts/{accountId}/analytics_engine/sql`
 * — body: SQL text (plain text, not JSON); headers: `Authorization: Bearer <token>`.
 *
 * The token is an **account-scoped API token with Analytics Engine read** — a
 * secret*, never a binding and never auto-scaffolded with a real value. The
 * caller provides `accountId` + `apiToken` from env/`.dev.vars`. This module is
 * deliberately placed in `@lunora/bindings/analytics` (not Studio) so both the Studio
 * read panel and `@lunora/advisor`'s runtime lints can import one client.
 */

import { LunoraError } from "@lunora/errors";

/** Shape of the AE SQL-API JSON body (the fields we read). */
interface RawSqlResponse {
    data?: Record<string, unknown>[];
    meta?: AnalyticsSqlColumnMeta[];
    rows?: number;
}

const SQL_API_BASE = "https://api.cloudflare.com/client/v4/accounts";

/**
 * Default for the config's `timeoutMs`: generous, because analytical scans
 * legitimately run tens of seconds — but bounded, because an unresponsive
 * endpoint would otherwise hold the calling action (or the Studio panel /
 * advisor lint importing this client) open to the platform limit.
 */
const DEFAULT_SQL_TIMEOUT_MS = 60_000;

/**
 * How much of the upstream body may be spliced into the error MESSAGE.
 *
 * `ANALYTICS_SQL_ERROR` is a catalogued, non-internal code, so `toErrorBody`
 * echoes its `message` verbatim to whoever called the action — an uncapped body
 * puts AE's SQL error text (which quotes the query) or a multi-KB HTML gateway
 * page on the wire to a browser. The full body is kept on `cause`, which
 * `toErrorBody` never serialises, so a server-side log still has all of it.
 */
const MAX_ERROR_BODY_CHARS = 256;

/** Trim `body` to {@link MAX_ERROR_BODY_CHARS}, marking that it was cut. */
const capErrorBody = (body: string): string => (body.length > MAX_ERROR_BODY_CHARS ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated)` : body);

/** Configuration for an {@link AnalyticsSqlClient}. */
export interface AnalyticsSqlConfig {
    /** Cloudflare account id that owns the dataset. */
    accountId: string;
    /** API token with Analytics Engine read scope. A secret — never a binding. */
    apiToken: string;

    /**
     * `fetch` implementation. Defaults to the global `fetch`; injected in tests
     * so the SQL path never touches the network.
     */
    fetch?: typeof globalThis.fetch;

    /**
     * Milliseconds before an in-flight query (the fetch AND its body read) is
     * aborted and surfaced as an `AnalyticsSqlError` with status 504. Defaults
     * to 60_000 — analytical scans legitimately run tens of seconds.
     * `undefined` means the default, not unbounded.
     *
     * The deadline is carried by the request's `signal`, so a custom `fetch`
     * (above) that ignores `signal` leaves the query unbounded.
     */
    timeoutMs?: number;
}

/**
 * One column descriptor in a SQL-API response's `meta` array: the column `name`
 * and the AE storage `type` (`String`, `Float64`, `DateTime`, …).
 */
export interface AnalyticsSqlColumnMeta {
    name: string;
    type: string;
}

/**
 * Parsed SQL-API result. AE returns `{ meta, data, rows, rows_before_limit_at_least }`;
 * we surface `columns` (from `meta`), the `rows` array of column→value records,
 * and the total `rowCount`.
 */
export interface AnalyticsSqlResult {
    columns: AnalyticsSqlColumnMeta[];
    rowCount: number;
    rows: Record<string, unknown>[];
}

/** Thrown when the SQL API responds with a non-2xx status; a `LunoraError` subclass carrying the HTTP `status` + a capped body preview, with the full body on `cause`. */
export class AnalyticsSqlError extends LunoraError {
    public constructor(status: number, body: string) {
        super("ANALYTICS_SQL_ERROR", `Analytics Engine SQL API returned ${String(status)}: ${capErrorBody(body)}`, {
            cause: body,
            name: "AnalyticsSqlError",
            status,
        });
    }
}

/** The read client: a single `query(sql)` over the AE SQL API. */
export interface AnalyticsSqlClient {
    query: (sql: string) => Promise<AnalyticsSqlResult>;
}

/**
 * Build an {@link AnalyticsSqlClient}. Each `query` POSTs the raw SQL text to
 * the account's `analytics_engine/sql` endpoint with the bearer token, then
 * normalises AE's `{ meta, data, rows }` body into {@link AnalyticsSqlResult}.
 */
export const createAnalyticsSqlClient = (config: AnalyticsSqlConfig): AnalyticsSqlClient => {
    const fetchImpl = config.fetch ?? globalThis.fetch;
    // Encode the account id as a single path segment so a value carrying URL
    // metacharacters (`/`, `?`, `#`, `..`) can't redirect the bearer-token POST
    // to a different endpoint on the API origin.
    const endpoint = `${SQL_API_BASE}/${encodeURIComponent(config.accountId)}/analytics_engine/sql`;

    const timeoutMs = config.timeoutMs ?? DEFAULT_SQL_TIMEOUT_MS;

    const query = async (sql: string): Promise<AnalyticsSqlResult> => {
        // Bound the fetch AND the body reads with one deadline — a hang after
        // headers is the harder failure — so a stalled endpoint can't hold the
        // caller open to the platform limit.
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort();
        }, timeoutMs);

        try {
            const response = await fetchImpl(endpoint, {
                body: sql,
                headers: {
                    Authorization: `Bearer ${config.apiToken}`,
                    "Content-Type": "text/plain",
                },
                method: "POST",
                signal: controller.signal,
            });

            if (!response.ok) {
                // The status is the diagnosis (401/403/429); the body is detail.
                // If the deadline fires mid-read, keep the status-derived error
                // rather than letting the outer handler mask it as a 504.
                throw new AnalyticsSqlError(
                    response.status,
                    await response.text().catch(() => "<error body unavailable: the request deadline fired before it was read>"),
                );
            }

            let raw: unknown;

            try {
                raw = await response.json();
            } catch (error) {
                // Let a timeout mid-read reach the outer 504 mapping instead of
                // being folded into the non-JSON-body normalisation below.
                if (controller.signal.aborted) {
                    throw error;
                }

                // A 2xx with a body that isn't JSON (e.g. an HTML error page from an
                // intermediary) would otherwise surface as a bare SyntaxError;
                // normalise it to the same AnalyticsSqlError callers already handle.
                throw new AnalyticsSqlError(response.status, "Analytics Engine SQL API returned a non-JSON body.");
            }

            const body = raw as RawSqlResponse;
            const rows = body.data ?? [];

            return {
                columns: body.meta ?? [],
                rowCount: body.rows ?? rows.length,
                rows,
            };
        } catch (error) {
            if (controller.signal.aborted && !(error instanceof AnalyticsSqlError)) {
                throw new AnalyticsSqlError(504, `query timed out after ${String(timeoutMs)}ms (AnalyticsSqlConfig.timeoutMs)`);
            }

            throw error;
        } finally {
            clearTimeout(timeout);
        }
    };

    return { query };
};
