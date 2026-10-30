import toMysqlParams from "./mysql-params";
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
 * // Wire the client once, on the app builder — called per shard construction,
 * // not per request. `ctx.sql` is emitted `readonly`; it is never assigned.
 * const app = defineApp<Env>()
 *     .shard((env) => env.SHARD)
 *     .hyperdrive((env) => {
 *         const { connectionString } = createHyperdrive(env.HYPERDRIVE);
 *
 *         return fromPostgresJs(postgres(connectionString, { fetch_types: false, max: 5 }));
 *     })
 *     .build();
 *
 * // Then, inside an action (never a query/mutation):
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
 *
 * `prepare: true` because `.unsafe` defaults to `prepare: false`, which
 * Cloudflare warns against: under Hyperdrive's transaction pooling unnamed
 * statements can hang or fail intermittently, and each one costs a Describe
 * round trip before it executes. A client built with `prepare: false` still
 * wins. Prepared reads are cacheable by Hyperdrive, so a `.global()` store's
 * config must have caching disabled (see `@lunora/hyperdrive/global`).
 */
export const fromPostgresJs = (client: PostgresJsLike): SqlClient => {
    return {
        dbSystem: "postgresql",
        query: async <Row = Record<string, unknown>>(text: string, params: ReadonlyArray<unknown> = []): Promise<Row[]> => {
            const rows = await client.unsafe(text, params, { prepare: true });

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
        dbSystem: "postgresql",
        query: async <Row = Record<string, unknown>>(text: string, params: ReadonlyArray<unknown> = []): Promise<Row[]> => {
            const result = await client.query(text, params);

            return result.rows as Row[];
        },
    };
};

/**
 * Wrap a `mysql2/promise` connection or pool as a {@link SqlClient}.
 *
 * Use `?` placeholders (MySQL positional syntax). `mysql2`'s `query` resolves
 * to a `[rows, fields]` tuple; the adapter returns the first element. For a
 * non-`SELECT` (DML), `mysql2` yields a `ResultSetHeader` object rather than a
 * row array, so the adapter normalises that to `[]` — matching the empty-array
 * contract the postgres.js / node-postgres adapters already honour.
 */
export const fromMysql2 = (connection: Mysql2Like): SqlClient => {
    return {
        dbSystem: "mysql",
        query: async <Row = Record<string, unknown>>(text: string, params: ReadonlyArray<unknown> = []): Promise<Row[]> => {
            const [rows] = await connection.query(text, toMysqlParams(params));

            return Array.isArray(rows) ? (rows as Row[]) : [];
        },
    };
};
