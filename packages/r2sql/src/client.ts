/**
 * The R2 SQL client: `createR2Sql(config)` → a typed surface over Cloudflare's
 * R2 SQL REST endpoint.
 *
 * R2 SQL has **no Workers binding** — `query` POSTs `{ query }` to
 * `…/r2-sql/query/{bucket}` with the bearer token and normalises the Cloudflare
 * envelope (`{ success, result, errors }`) into an {@link R2SqlResult}. The
 * factory deliberately lives in `@lunora/r2sql` (not Studio) so the Studio data
 * panel and the `@lunora/advisor` runtime lints can share one client — mirroring
 * `createAnalyticsSqlClient` in `@lunora/analytics`.
 *
 * Surfaces: `query(sql)` / `explain(sql)` (raw escape hatches, typed rows);
 * `from&lt;Row>(table)` (the chainable {@link SelectBuilder} — window functions,
 * `DISTINCT`, `QUALIFY`, set operations); and `showDatabases()` /
 * `showTables(ns)` / `describe(table)` (Iceberg schema-discovery, the same
 * surface Studio uses to render tables).
 */

import SelectBuilder from "./builder";
import type { QueryExecutor } from "./query";
import type { Sql } from "./sql";
import { toText } from "./sql";
import type { R2SqlColumn, R2SqlConfig, R2SqlExplainOptions, R2SqlResult } from "./types";

/** Default public R2 SQL REST host. */
const API_BASE = "https://api.sql.cloudflarestorage.com/api/v1/accounts";

/** Shape of the Cloudflare R2 SQL JSON envelope (the fields we read). */
interface RawR2SqlResponse {
    data?: Record<string, unknown>[];
    errors?: unknown[];
    result?: Record<string, unknown>[];
    rows?: Record<string, unknown>[];
    schema?: R2SqlColumn[];
    success?: boolean;
}

/** Derive column descriptors from the first row's keys when the engine omits a schema block. */
const inferColumns = (rows: Record<string, unknown>[]): R2SqlColumn[] => {
    if (rows[0] === undefined) {
        return [];
    }

    return Object.keys(rows[0]).map((name) => {
        return { name };
    });
};

/**
 * Thrown when R2 SQL responds with a non-2xx status, an `success: false`
 * envelope, or an unparseable body; carries the HTTP `status` and the raw body
 * for the caller to surface.
 */
export class R2SqlError extends Error {
    public readonly status: number;

    public constructor(status: number, body: string) {
        super(`R2 SQL query failed (${String(status)}): ${body}`);
        this.name = "R2SqlError";
        this.status = status;
    }
}

/**
 * The typed R2 SQL surface bound to `ctx.r2sql` on **`ActionCtx` only**. This is
 * the exact type the generated ctx imports as
 * `import("@lunora/r2sql").R2SqlClient` — keep the name and shape stable.
 */
export interface R2SqlClient {
    /** Run `DESCRIBE namespace.table` — column names and Iceberg types. */
    describe: (table: string) => Promise<R2SqlResult>;
    /** Run `EXPLAIN [FORMAT JSON] sql` — the execution plan, without running the query. */
    explain: (statement: Sql | string, options?: R2SqlExplainOptions) => Promise<R2SqlResult>;
    /** Start a chainable `SELECT` over `table` (`namespace.table`), generic over the caller-declared `Row`. */
    from: <Row = Record<string, unknown>>(table: string) => SelectBuilder<Row>;
    /** Run a raw SQL statement (the escape hatch). Use the `sql` tag to bind values safely. */
    query: <Row = Record<string, unknown>>(statement: Sql | string) => Promise<R2SqlResult<Row>>;
    /** Run `SHOW DATABASES` — the available namespaces. */
    showDatabases: () => Promise<R2SqlResult>;
    /** Run `SHOW TABLES IN namespace` — the tables in a namespace. */
    showTables: (namespace: string) => Promise<R2SqlResult>;
}

/**
 * Build an {@link R2SqlClient}. Each query POSTs to the bucket's
 * `r2-sql/query/{bucket}` endpoint with the bearer token, then normalises the
 * envelope into {@link R2SqlResult}.
 */
export const createR2Sql = (config: R2SqlConfig): R2SqlClient => {
    const fetchImpl = config.fetch ?? globalThis.fetch;
    const base = config.endpoint ?? API_BASE;
    // Encode account id + bucket as single path segments so a value carrying URL
    // metacharacters can't redirect the bearer-token POST elsewhere on the origin.
    const endpoint = `${base}/${encodeURIComponent(config.accountId)}/r2-sql/query/${encodeURIComponent(config.bucket)}`;

    const exec: QueryExecutor = async (statement: string): Promise<R2SqlResult> => {
        const response = await fetchImpl(endpoint, {
            body: JSON.stringify({ query: statement }),
            headers: {
                Authorization: `Bearer ${config.apiToken}`,
                "Content-Type": "application/json",
            },
            method: "POST",
        });

        if (!response.ok) {
            throw new R2SqlError(response.status, await response.text());
        }

        let raw: unknown;

        try {
            raw = await response.json();
        } catch {
            // A 2xx with a non-JSON body (e.g. an HTML error page from an
            // intermediary) would surface as a bare SyntaxError; normalise it to
            // the R2SqlError callers already handle.
            throw new R2SqlError(response.status, "R2 SQL returned a non-JSON body.");
        }

        const body = raw as RawR2SqlResponse;

        // The envelope can report a logical failure with a 2xx HTTP status; treat
        // `success: false` (or a populated `errors` array) as an error.
        if (body.success === false || (body.errors !== undefined && body.errors.length > 0)) {
            throw new R2SqlError(response.status, JSON.stringify(body.errors ?? body));
        }

        const rows = body.result ?? body.rows ?? body.data ?? [];

        return {
            columns: body.schema ?? inferColumns(rows),
            rowCount: rows.length,
            rows,
        };
    };

    return {
        describe: async (table) => exec(`DESCRIBE ${table}`),
        explain: async (statement, options) => exec(`EXPLAIN ${options?.format === "json" ? "FORMAT JSON " : ""}${toText(statement)}`),
        from: <Row = Record<string, unknown>>(table: string) => new SelectBuilder<Row>(exec, table),
        query: async <Row = Record<string, unknown>>(statement: Sql | string) => exec(toText(statement)) as Promise<R2SqlResult<Row>>,
        showDatabases: async () => exec("SHOW DATABASES"),
        showTables: async (namespace) => exec(`SHOW TABLES IN ${namespace}`),
    };
};
