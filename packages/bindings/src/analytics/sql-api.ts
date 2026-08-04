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

/** Thrown when the SQL API responds with a non-2xx status; a `LunoraError` subclass carrying the HTTP `status` + body for the caller to surface. */
export class AnalyticsSqlError extends LunoraError {
    public constructor(status: number, body: string) {
        super("ANALYTICS_SQL_ERROR", `Analytics Engine SQL API returned ${String(status)}: ${body}`, { name: "AnalyticsSqlError", status });
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

    const query = async (sql: string): Promise<AnalyticsSqlResult> => {
        const response = await fetchImpl(endpoint, {
            body: sql,
            headers: {
                Authorization: `Bearer ${config.apiToken}`,
                "Content-Type": "text/plain",
            },
            method: "POST",
        });

        if (!response.ok) {
            throw new AnalyticsSqlError(response.status, await response.text());
        }

        let raw: unknown;

        try {
            raw = await response.json();
        } catch {
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
    };

    return { query };
};
