/**
 * Public types for `@lunora/hyperdrive`.
 *
 * Hyperdrive points at a database **Lunora does not own**. Everything here is
 * deliberately structural (no hard dependency on `@cloudflare/workers-types` or
 * any SQL driver) so unit tests can pass plain-object doubles, exactly like the
 * `D1DatabaseLike` projection in `@lunora/d1`.
 *
 * The hard constraint, restated wherever this surface is used: Hyperdrive
 * queries are **non-deterministic** (forbidden in `query`/`mutation`, allowed
 * only in `action`s — see the `hyperdrive_outside_action` advisor lint), and
 * external writes are **invisible to Lunora live queries** — a subscription will
 * NOT re-run when an external Postgres/MySQL row changes.
 */

/**
 * Structural projection of the Cloudflare `Hyperdrive` binding (`env.HYPERDRIVE`).
 *
 * Mirrors the fields of the real `Hyperdrive` from `@cloudflare/workers-types`
 * but stays structural so a unit test can pass a plain object. At runtime only
 * `connectionString` is needed to construct a driver; the discrete connection
 * parts are surfaced for drivers that prefer a config object over a DSN.
 */
export interface HyperdriveLike {
    /** A connection string Hyperdrive routes through its pooled, cached edge connection. */
    connectionString: string;
    /** Database name component of the connection. */
    database: string;
    /** Host Hyperdrive presents to the driver (the local proxy, not your origin DB). */
    host: string;
    /** Password component of the connection. */
    password: string;
    /** Port Hyperdrive presents to the driver. */
    port: number;
    /** User component of the connection. */
    user: string;
}

/**
 * The connection config surfaced by {@link import("./create-hyperdrive").createHyperdrive | createHyperdrive}: the raw
 * `connectionString` plus the discrete parts, ready to hand to a driver.
 */
export interface HyperdriveConnection {
    /** Database name. */
    database: string;
    /** Host (Hyperdrive's local proxy). */
    host: string;
    /** Password. */
    password: string;
    /** Port. */
    port: number;
    /** User. */
    user: string;
}

/**
 * The driver-agnostic SQL surface bound to `ctx.sql` on **`ActionCtx` only**.
 *
 * This is the exact type the generated ctx imports as
 * `import("@lunora/hyperdrive").SqlClient`. Keep the name and shape stable — the
 * codegen ctx wiring (Phase 1) depends on it.
 *
 * It is intentionally minimal — a single parameterised `query` — so it maps onto
 * `postgres` (postgres.js), `pg` (node-postgres) and `mysql2` alike via the
 * {@link import("./create-hyperdrive").fromPostgresJs | fromPostgresJs} /
 * {@link import("./create-hyperdrive").fromNodePg | fromNodePg} /
 * {@link import("./create-hyperdrive").fromMysql2 | fromMysql2} adapters. Use
 * positional placeholders that match your driver (`$1, $2` for Postgres, `?` for
 * MySQL); the package does not rewrite SQL.
 *
 * Reminder (also on the emitted JSDoc): non-deterministic, action-only,
 * non-reactive — writes here are not tracked by Lunora live queries.
 */
export interface SqlClient {
    /**
     * Run a parameterised SQL statement and return the result rows.
     * @param text SQL text with driver-native positional placeholders.
     * @param params Bound parameter values, positionally matched to `text`.
     * @returns The rows the statement produced (empty for non-`SELECT`s that
     * return no rows).
     */
    query: <Row = Record<string, unknown>>(text: string, params?: ReadonlyArray<unknown>) => Promise<Row[]>;
}

/**
 * Structural projection of a `pg` (node-postgres) `Client`/`Pool`. Only the
 * `query` method `fromNodePg` calls is required, kept structural for testing.
 */
export interface NodePgLike {
    query: (text: string, params?: ReadonlyArray<unknown>) => Promise<{ rows: unknown[] }>;
}

/**
 * Structural projection of a `postgres` (postgres.js) tagged-template client.
 * The adapter uses the `.unsafe(text, params)` escape hatch so callers keep
 * full control of the parameter list.
 */
export interface PostgresJsLike {
    unsafe: (text: string, params?: ReadonlyArray<unknown>) => Promise<unknown>;
}

/**
 * Structural projection of a `mysql2/promise` connection/pool. `mysql2`'s
 * `execute` resolves to a `[rows, fields]` tuple; the adapter takes the first
 * element as the rows.
 */
export interface Mysql2Like {
    execute: (text: string, params?: ReadonlyArray<unknown>) => Promise<[unknown, unknown]>;
}
