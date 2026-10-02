/**
 * Structural types for the Analytics SQL read path.
 *
 * The real binding is workers-types' `AnalyticsSQLBinding` (the wrangler
 * `analytics` key, wrangler ≥ 4.145.0). It is mirrored **structurally**
 * (`AnalyticsSqlBindingLike`) rather than aliased, like every other bindings
 * subpath: an alias resolved against an older or absent workers-types install
 * would degrade to `any`, and plain-object test doubles satisfy a structural
 * contract without workerd. A type test pins that the real binding still
 * satisfies the mirror.
 */

/** A value bound to a `$1` / `$name` placeholder. */
export type AnalyticsSqlParameter = boolean | number | string | null;

/** Positional (`$1`, `$2`, …) or named (`$start`, …) placeholder values. */
export type AnalyticsSqlParams = Readonly<Record<string, AnalyticsSqlParameter>> | ReadonlyArray<AnalyticsSqlParameter>;

/** One Analytics SQL statement and its optional placeholder values. */
export interface AnalyticsSqlRequest {
    params?: AnalyticsSqlParams;
    query: string;
}

/** Execution statistics the SQL API reports for a query. */
export interface AnalyticsSqlStatistics {
    bytes_read: number;
    elapsed_ms: number;
    rows_read: number;
}

/**
 * The raw result body: `data` rows plus the `rows` count and `statistics`.
 * `statistics` is optional because the REST endpoint omits it for Log Explorer
 * datasets; the binding always sets it.
 */
export interface AnalyticsSqlRawResult<T extends Record<string, unknown> = Record<string, unknown>> {
    data: T[];
    rows: number;
    statistics?: AnalyticsSqlStatistics;
}

/**
 * Anything that answers `query({ query, params })` the way the Analytics SQL
 * binding does: the real `env.ANALYTICS_SQL` binding, or
 * `createAnalyticsSqlRest(...)`, the API-token transport over the same SQL API
 * for a worker with no binding.
 */
export interface AnalyticsSqlBindingLike {
    query: <T extends Record<string, unknown> = Record<string, unknown>>(request: AnalyticsSqlRequest) => Promise<AnalyticsSqlRawResult<T>>;
}

/** Options for `createAnalyticsSql`. */
export interface AnalyticsSqlOptions {
    /** The Analytics SQL binding (`env.ANALYTICS_SQL`), or the REST transport from `createAnalyticsSqlRest`. */
    binding: AnalyticsSqlBindingLike;
}

/** A parsed query result: the rows, their count, and the SQL API's execution statistics. */
export interface AnalyticsSqlQueryResult<T extends Record<string, unknown> = Record<string, unknown>> {
    /** The SQL API's row count (equal to `rows.length` for a complete result). */
    rowCount: number;
    rows: T[];
    /** Absent only when the REST transport queried a dataset that reports none (Log Explorer). */
    statistics?: AnalyticsSqlStatistics;
}

/**
 * The action-only client bound to `ctx.analyticsSql`: one read-only SQL
 * statement per call, in the **Analytics SQL** dialect
 * (`FROM events.analyticsEngine."<dataset>"`, a lower `timestamp` bound
 * required), with `$1` / `$name` placeholders bound from `params`.
 */
export interface AnalyticsSql {
    query: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: AnalyticsSqlParams) => Promise<AnalyticsSqlQueryResult<T>>;
}

/** Configuration for `createAnalyticsSqlRest`. */
export interface AnalyticsSqlRestConfig {
    /** The Cloudflare account id the queries are scoped to (sent as `scope.accountTag`). */
    accountId: string;
    /** API token with Account Analytics Read. A secret: never a binding, never shipped to a browser. */
    apiToken: string;

    /** `fetch` implementation. Defaults to the global `fetch`; injected in tests so the transport never touches the network. */
    fetch?: typeof globalThis.fetch;

    /**
     * Milliseconds before an in-flight query (the fetch AND its body read) is
     * aborted, surfacing as a retryable query error with status 504.
     * Defaults to 60_000. Carried by the request's `signal`, so a custom `fetch`
     * that ignores `signal` leaves the query unbounded.
     */
    timeoutMs?: number;
}
