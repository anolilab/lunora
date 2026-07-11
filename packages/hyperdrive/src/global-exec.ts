/**
 * {@link SqlExec} adapters over a Hyperdrive-backed driver.
 *
 * The store core renders each statement for the target engine *before* it
 * reaches the exec — drizzle's dialect numbers Postgres `$1, $2, …` placeholders
 * and quotes identifiers per engine (`"…"` on Postgres, `` `…` `` on MySQL). So
 * these adapters just forward the rendered `{ sql, params }` to the driver; no
 * placeholder or identifier rewriting happens here.
 */
import type { SqlExec, SqlRunResult } from "@lunora/sql-store";

import type { Mysql2Like, SqlClient } from "./types";

/**
 * Minimal row-returning client (e.g. `@lunora/hyperdrive`'s `fromPostgresJs`/`fromNodePg`
 * result). Aliases {@link SqlClient} — the exec-facing name is kept so call sites read
 * intent, but the shape is the single source of truth in `./types` (no drift).
 */
export type RowClient = SqlClient;

/**
 * Minimal `mysql2/promise` connection/pool surface — `execute` resolves to
 * `[rows | ResultSetHeader, fields]`. Aliases {@link Mysql2Like} so the /global entry's
 * driver surface can never drift from the main entry's.
 */
export type Mysql2Execute = Mysql2Like;

/**
 * Wrap a Postgres row-client (from `@lunora/hyperdrive`'s `fromPostgresJs` /
 * `fromNodePg`) as a {@link SqlExec}. The core already renders `$N` placeholders
 * for Postgres, so `all`/`run` forward verbatim. Postgres uses `RETURNING` for
 * OCC (read via `all`), so `run` reports no affected-row count.
 */
export const buildPgExec = (client: RowClient): SqlExec => {
    return {
        all: (sql, params) => client.query(sql, params),
        run: async (sql, params): Promise<SqlRunResult> => {
            await client.query(sql, params);

            // Postgres' OCC goes through `RETURNING` (read via `all`, supportsReturning:true),
            // so the store never consumes `rowsAffected` on the PG path — report 0.
            return { rowsAffected: 0 };
        },
    };
};

/**
 * Wrap a `mysql2/promise` connection/pool as a {@link SqlExec}. The core already
 * renders backtick identifiers and `?` placeholders for MySQL, so `all`/`run`
 * forward verbatim. MySQL has no `RETURNING`, so `run` surfaces `affectedRows`
 * for the store's affected-rows OCC guard.
 *
 * **The connection MUST be created with the `CLIENT_FOUND_ROWS` flag**
 * (mysql2: `createPool({ flags: ["FOUND_ROWS"] })`). Without it, `affectedRows`
 * counts *changed* rows, so an idempotent `patch`/`replace` that re-writes the
 * same values reports 0 and the OCC guard raises a spurious conflict.
 */
export const buildMysqlExec = (connection: Mysql2Execute): SqlExec => {
    return {
        all: async (sql, params) => {
            const [rows] = await connection.execute(sql, params);

            return rows as Record<string, unknown>[];
        },
        run: async (sql, params): Promise<SqlRunResult> => {
            const [result] = await connection.execute(sql, params);

            return { rowsAffected: (result as { affectedRows?: number }).affectedRows ?? 0 };
        },
    };
};
