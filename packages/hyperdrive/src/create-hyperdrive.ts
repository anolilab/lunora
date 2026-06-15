import type { HyperdriveConnection, HyperdriveLike, Mysql2Like, NodePgLike, PostgresJsLike, SqlClient } from "./types";

/**
 * Surface a Cloudflare Hyperdrive binding as a connection ready to feed a
 * user-supplied SQL driver.
 *
 * `@lunora/hyperdrive` deliberately **bundles no driver** — `postgres`, `pg` and
 * `mysql2` are heavy and the choice is the user's (they are `optional`
 * `peerDependencies`, never `dependencies`). This factory's only job is to lift
 * the binding's connection details out; the user constructs their own driver
 * from `connectionString` and wraps it with one of the {@link fromPostgresJs} /
 * {@link fromNodePg} / {@link fromMysql2} adapters to get a {@link SqlClient}.
 * @example
 * ```ts
 * import { createHyperdrive, fromPostgresJs } from "@lunora/hyperdrive";
 * import postgres from "postgres";
 *
 * // inside an action (never a query/mutation):
 * const { connectionString } = createHyperdrive(env.HYPERDRIVE);
 * ctx.sql = fromPostgresJs(postgres(connectionString));
 * const rows = await ctx.sql.query("select id from users where org = $1", [orgId]);
 * ```
 * @remarks
 * Hyperdrive talks to an **external** database Lunora has no visibility into.
 * Queries through `ctx.sql` are non-deterministic (action-only — enforced by the
 * `hyperdrive_outside_action` advisor lint) and external writes are NOT tracked
 * by Lunora live queries: subscriptions will not re-run when external rows
 * change. Use Hyperdrive to *integrate* an existing DB from an action; if you
 * want that data to be reactive, write a projection of it into a `defineSchema`
 * DO/D1 table.
 * @param binding The `env.HYPERDRIVE` binding (or a structural double).
 * @returns The raw `connectionString` plus the discrete connection parts.
 */
export const createHyperdrive = (binding: HyperdriveLike): { config: HyperdriveConnection; connectionString: string } => {
    const config: HyperdriveConnection = {
        database: binding.database,
        host: binding.host,
        password: binding.password,
        port: binding.port,
        user: binding.user,
    };

    return { config, connectionString: binding.connectionString };
};

/**
 * Wrap a `postgres` (postgres.js) client as a {@link SqlClient}.
 *
 * Uses the driver's `.unsafe(text, params)` escape hatch so the caller supplies
 * a plain SQL string with `$1, $2, …` placeholders and a positional params
 * array. postgres.js's `.unsafe` resolves to a row array.
 */
export const fromPostgresJs = (client: PostgresJsLike): SqlClient => {
    return {
        query: async <Row = Record<string, unknown>>(text: string, params: ReadonlyArray<unknown> = []): Promise<Row[]> => {
            const rows = await client.unsafe(text, params);

            return rows as Row[];
        },
    };
};

/**
 * Wrap a `pg` (node-postgres) `Client` or `Pool` as a {@link SqlClient}.
 *
 * node-postgres returns a result object whose `rows` field holds the row array.
 */
export const fromNodePg = (client: NodePgLike): SqlClient => {
    return {
        query: async <Row = Record<string, unknown>>(text: string, params: ReadonlyArray<unknown> = []): Promise<Row[]> => {
            const result = await client.query(text, params);

            return result.rows as Row[];
        },
    };
};

/**
 * Wrap a `mysql2/promise` connection or pool as a {@link SqlClient}.
 *
 * Use `?` placeholders (MySQL positional syntax). `mysql2`'s `execute` resolves
 * to a `[rows, fields]` tuple; the adapter returns the first element.
 */
export const fromMysql2 = (connection: Mysql2Like): SqlClient => {
    return {
        query: async <Row = Record<string, unknown>>(text: string, params: ReadonlyArray<unknown> = []): Promise<Row[]> => {
            const [rows] = await connection.execute(text, params);

            return rows as Row[];
        },
    };
};
