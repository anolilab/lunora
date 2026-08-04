/**
 * Public types for `@lunora/bindings/r2sql`.
 *
 * R2 SQL is Cloudflare's serverless, distributed query engine over **Apache
 * Iceberg** tables in [R2 Data Catalog](https://developers.cloudflare.com/r2/data-catalog/).
 * It has **no Workers binding** — every query is an HTTPS round-trip to the REST
 * endpoint (`POST …/r2-sql/query/{bucket}`). So, like Hyperdrive's `ctx.sql`, the
 * client is **non-deterministic external I/O**: it is wired onto `ActionCtx`
 * only (see the `r2sql_outside_action` advisor lint) and its reads are NOT
 * tracked by Lunora live queries.
 *
 * Everything here is deliberately structural (no hard dependency on
 * `@cloudflare/workers-types`) so unit tests can inject a plain `fetch` double
 * and never touch the network — mirroring `AnalyticsSqlConfig` in
 * `@lunora/bindings/analytics`.
 */

/**
 * Configuration for a {@link import("./client").R2SqlClient | R2SqlClient}.
 *
 * `apiToken` is a **secret** — a Cloudflare API token scoped to R2 SQL (read),
 * R2 Data Catalog, and R2 storage. It is never a binding and must never be
 * auto-scaffolded with a real value; the caller provides it from
 * env/`.dev.vars`.
 */
export interface R2SqlConfig {
    /** Cloudflare account id that owns the bucket/catalog. */
    accountId: string;
    /** API token with R2 SQL read + R2 Data Catalog + R2 storage scope. A secret — never a binding. */
    apiToken: string;
    /** The R2 bucket (warehouse) whose Data Catalog the queries run against. */
    bucket: string;

    /**
     * Override the REST base URL. Defaults to Cloudflare's public R2 SQL host
     * (`https://api.sql.cloudflarestorage.com/api/v1/accounts`). Injected in
     * tests, or pointed at a regional/preview host.
     */
    endpoint?: string;

    /**
     * `fetch` implementation. Defaults to the global `fetch`; injected in tests
     * so a query never touches the network.
     */
    fetch?: typeof globalThis.fetch;
}

/**
 * One column descriptor in a result's schema: the column `name` and, when the
 * engine reports it, the Iceberg storage `type` (`integer`, `string`,
 * `timestamp`, …). R2 SQL does not always echo a schema block, so `type` is
 * optional and `columns` may be derived from the first row's keys.
 */
export interface R2SqlColumn {
    name: string;
    type?: string;
}

/**
 * A parsed R2 SQL result. R2 SQL returns a Cloudflare envelope
 * (`{ success, result, errors }`); we surface the `rows` (the `result` array of
 * column→value records), the inferred/echoed `columns`, and the `rowCount`.
 *
 * `Row` defaults to an open record; supply it (`from<MyRow>(…)` /
 * `query<MyRow>(…)`) to get typed result fields — R2 SQL tables live in Iceberg,
 * not `defineSchema`, so the row type is caller-declared rather than inferred.
 */
export interface R2SqlResult<Row = Record<string, unknown>> {
    /** Column descriptors, echoed by the engine or inferred from the first row. */
    columns: R2SqlColumn[];
    /** Total rows returned. */
    rowCount: number;
    /** The result rows. */
    rows: Row[];
}

/** Options for {@link import("./client").R2SqlClient.explain | explain}. */
export interface R2SqlExplainOptions {
    /**
     * `"json"` runs `EXPLAIN FORMAT JSON` (structured plan); `"text"` (default)
     * runs a plain `EXPLAIN`.
     */
    format?: "json" | "text";
}
