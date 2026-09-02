/**
 * The R2 SQL client: `createR2Sql(config)` → a typed surface over Cloudflare's
 * R2 SQL REST endpoint.
 *
 * R2 SQL has **no Workers binding** — `query` POSTs `{ query }` to
 * `…/r2-sql/query/{bucket}` with the bearer token and normalises the Cloudflare
 * envelope (`{ success, result, errors }`) into an {@link R2SqlResult}. The
 * factory deliberately lives in `@lunora/bindings/r2sql` (not Studio) so the Studio data
 * panel and the `@lunora/advisor` runtime lints can share one client — mirroring
 * `createAnalyticsSqlClient` in `@lunora/bindings/analytics`.
 *
 * Surfaces: `query(sql)` / `explain(sql)` (raw escape hatches, typed rows);
 * `from<Row>(table)` (the chainable {@link SelectBuilder} — window functions,
 * `DISTINCT`, `QUALIFY`, set operations); and `showDatabases()` /
 * `showTables(ns)` / `describe(table)` (Iceberg schema-discovery, the same
 * surface Studio uses to render tables).
 */

import { LunoraError } from "@lunora/errors";

import SelectBuilder from "./builder";
import type { QueryExecutor } from "./query";
import type { Sql } from "./sql";
import { ident, toText } from "./sql";
import type { R2SqlColumn, R2SqlConfig, R2SqlExplainOptions, R2SqlResult } from "./types";

/** Default public R2 SQL REST host. */
const API_BASE = "https://api.sql.cloudflarestorage.com/api/v1/accounts";

/**
 * Default `R2SqlConfig.timeoutMs`: generous, because analytical scans
 * legitimately run tens of seconds — but bounded, because `ctx.r2sql` is
 * ActionCtx-mounted, so an unresponsive endpoint would otherwise hold the
 * action (and its shard request) open to the platform limit.
 */
const DEFAULT_SQL_TIMEOUT_MS = 60_000;

/**
 * Shape of the Cloudflare R2 SQL JSON envelope (the fields we read), matching
 * the contract the official `wrangler r2 sql query` client parses: a
 * `{ success, errors, messages, result }` wrapper where the **rows and schema
 * are nested under `result`** (not the top level).
 */
interface RawR2SqlResponse {
    errors?: { code?: number; message?: string }[];
    messages?: string[];
    result?: {
        request_id?: string;
        rows?: Record<string, unknown>[];
        schema?: R2SqlColumn[];
    };
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
 * How much of the upstream body may be spliced into the error MESSAGE.
 *
 * `R2_SQL_ERROR` is a catalogued, non-internal code, so `toErrorBody` echoes its
 * `message` verbatim to whoever called the action — an uncapped body puts the
 * engine's SQL error text (which quotes the query) or a multi-KB HTML gateway
 * page on the wire to a browser. The full body is kept on `cause`, which
 * `toErrorBody` never serialises, so a server-side log still has all of it.
 */
const MAX_ERROR_BODY_CHARS = 256;

/** Trim `body` to {@link MAX_ERROR_BODY_CHARS}, marking that it was cut. */
const capErrorBody = (body: string): string => (body.length > MAX_ERROR_BODY_CHARS ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated)` : body);

/**
 * Thrown when R2 SQL responds with a non-2xx status, an `success: false`
 * envelope, or an unparseable body; carries the HTTP `status` and a capped body
 * preview for the caller to surface, with the full body on `cause`.
 */
export class R2SqlError extends LunoraError {
    public constructor(status: number, body: string) {
        super("R2_SQL_ERROR", `R2 SQL query failed (${String(status)}): ${capErrorBody(body)}`, { cause: body, name: "R2SqlError", status });
    }
}

/**
 * The typed R2 SQL surface bound to `ctx.r2sql` on **`ActionCtx` only**. This is
 * the exact type the generated ctx imports as
 * `import("@lunora/bindings/r2sql").R2SqlClient` — keep the name and shape stable.
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
    // The catalog warehouse name is `<accountId>_<bucket>` — the official client
    // sends it in the body alongside the query, so we match that contract.
    const warehouse = `${config.accountId}_${config.bucket}`;

    const timeoutMs = config.timeoutMs ?? DEFAULT_SQL_TIMEOUT_MS;

    const exec: QueryExecutor = async (statement: string): Promise<R2SqlResult> => {
        // Bound the fetch AND the body reads with one deadline — a hang after
        // headers is the harder failure — so a stalled endpoint can't hold the
        // calling action open to the platform limit.
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort();
        }, timeoutMs);

        try {
            const response = await fetchImpl(endpoint, {
                body: JSON.stringify({ query: statement, warehouse }),
                headers: {
                    Authorization: `Bearer ${config.apiToken}`,
                    "Content-Type": "application/json",
                },
                method: "POST",
                signal: controller.signal,
            });

            if (!response.ok) {
                // The status is the diagnosis (401/403/429); the body is detail.
                // If the deadline fires mid-read, keep the status-derived error
                // rather than letting the outer handler mask it as a 504.
                throw new R2SqlError(
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

            // Rows and schema are nested under `result` (`{ result: { rows, schema } }`).
            const rows = body.result?.rows ?? [];

            return {
                columns: body.result?.schema ?? inferColumns(rows),
                rowCount: rows.length,
                rows,
            };
        } catch (error) {
            if (controller.signal.aborted && !(error instanceof R2SqlError)) {
                throw new R2SqlError(504, `query timed out after ${String(timeoutMs)}ms (R2SqlConfig.timeoutMs)`);
            }

            throw error;
        } finally {
            clearTimeout(timeout);
        }
    };

    return {
        describe: async (table) => exec(`DESCRIBE ${ident(table)}`),
        explain: async (statement, options) => exec(`EXPLAIN ${options?.format === "json" ? "FORMAT JSON " : ""}${toText(statement)}`),
        // `SelectBuilder`'s constructor validates the table reference (allowing an
        // optional `[AS] alias`), so no pre-validation here.
        from: <Row = Record<string, unknown>>(table: string) => new SelectBuilder<Row>(exec, table),
        query: async <Row = Record<string, unknown>>(statement: Sql | string) => exec(toText(statement)) as Promise<R2SqlResult<Row>>,
        showDatabases: async () => exec("SHOW DATABASES"),
        showTables: async (namespace) => exec(`SHOW TABLES IN ${ident(namespace)}`),
    };
};
