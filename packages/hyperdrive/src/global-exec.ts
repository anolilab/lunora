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
 *
 * `batch` dispatches every statement concurrently (`Promise.all`) over `client`
 * rather than awaiting each `query` call in turn — `RowClient` only exposes a
 * single-statement `query`, so there is no wire-level multi-statement command
 * to reach for. When `client` is backed by a pool (the common production
 * shape), this genuinely spreads the statements across multiple physical
 * connections instead of serializing one full round trip at a time; against a
 * single connection it still removes the sequential *await*, though the
 * underlying driver may itself queue the sends. Either way it stays
 * non-atomic and at-least-once, same as the sequential fallback — safe only
 * for statements whose effects don't depend on each other, which is what
 * every current caller batches (distinct-keyed companion rows).
 */
export const buildPgExec = (client: RowClient): SqlExec => {
    return {
        all: (sql, params) => client.query(sql, params),
        batch: async (statements) => {
            await Promise.all(statements.map((statement) => client.query(statement.sql, statement.params)));

            // Same reporting contract as `run`: PG's OCC goes through
            // `RETURNING` (read via `all`), so no caller consumes these counts.
            return statements.map(() => {
                return { rowsAffected: 0 };
            });
        },
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
 *
 * `batch` dispatches every statement concurrently (`Promise.all`), same
 * rationale as {@link buildPgExec}'s `batch` — `Mysql2Like` only exposes a
 * single-statement `execute`, so this is "spread across a pool's connections"
 * rather than one wire-level multi-statement command; still non-atomic and
 * at-least-once, safe only for statements with no cross-effect (what every
 * current caller batches).
 */
export const buildMysqlExec = (connection: Mysql2Execute): SqlExec => {
    return {
        all: async (sql, params) => {
            const [rows] = await connection.execute(sql, params);

            return rows as Record<string, unknown>[];
        },
        batch: async (statements) => {
            const results = await Promise.all(statements.map((statement) => connection.execute(statement.sql, statement.params)));

            return results.map(([result]) => {
                return { rowsAffected: (result as { affectedRows?: number }).affectedRows ?? 0 };
            });
        },
        run: async (sql, params): Promise<SqlRunResult> => {
            const [result] = await connection.execute(sql, params);

            return { rowsAffected: (result as { affectedRows?: number }).affectedRows ?? 0 };
        },
    };
};
