/**
 * {@link SqlExec} adapters over a Hyperdrive-backed driver.
 *
 * The store core renders each statement for the target engine *before* it
 * reaches the exec — drizzle's dialect numbers Postgres `$1, $2, …` placeholders
 * and quotes identifiers per engine (`"…"` on Postgres, `` `…` `` on MySQL). So
 * these adapters just forward the rendered `{ sql, params }` to the driver; no
 * placeholder or identifier rewriting happens here.
 */
import { LunoraError } from "@lunora/errors";
import type { SqlExec, SqlRunResult } from "@lunora/sql-store";

import type { Mysql2Like, SqlClient } from "./types";

/**
 * The MySQL wire-protocol `CLIENT_FOUND_ROWS` capability flag — part of the protocol spec (same value for MySQL, MariaDB, PlanetScale, Vitess, …), not a `mysql2`-specific constant, so it's safe to hardcode rather than import.
 */
const CLIENT_FOUND_ROWS_FLAG = 0x00_00_00_02;

/**
 * Read the merged client-flags bitmask off a real `mysql2/promise` connection or pool (see {@link Mysql2Execute}), trying the single-connection shape first and falling back to the pool's nested shape. Returns `undefined` when neither is present — the driver (or test double) doesn't expose flag introspection.
 */
const readMysqlClientFlags = (connection: Mysql2Execute): number | undefined => {
    const direct = connection.config?.clientFlags;

    if (typeof direct === "number") {
        return direct;
    }

    const pooled = connection.pool?.config?.connectionConfig?.clientFlags;

    return typeof pooled === "number" ? pooled : undefined;
};

/**
 * Verify a MySQL connection/pool negotiated `CLIENT_FOUND_ROWS` — once, at `buildMysqlExec` construction, never per statement (an extra round trip per query would double the wire traffic for a static property of the connection). Reads the driver's own in-memory client-flags bitmask; no query, no I/O, no write, no permissions required.
 *
 * Determinately **absent** (flag bit unset) throws, naming the flag and the `mysql2` remedy. Determinately **present** returns silently. **Undeterminable** (the connection/pool exposes no flag bitmask at either shape) warns once and returns — throwing on "unknown" would break every driver that doesn't expose flag introspection.
 */
const assertFoundRows = (connection: Mysql2Execute): void => {
    const clientFlags = readMysqlClientFlags(connection);

    if (clientFlags === undefined) {
        // eslint-disable-next-line no-console -- intentional one-shot operational warning: the driver exposes no flag introspection, so this is the only signal the caller gets.
        console.warn(
            "@lunora/hyperdrive: could not determine whether this MySQL connection negotiated CLIENT_FOUND_ROWS " +
                '(the driver exposes no flag introspection). If it was NOT created with the `CLIENT_FOUND_ROWS` flag (mysql2: `createPool({ flags: ["FOUND_ROWS"] })`), ' +
                "an idempotent patch/replace that rewrites identical values may report 0 affectedRows and raise a spurious OCC ConflictError.",
        );

        return;
    }

    // eslint-disable-next-line no-bitwise -- CLIENT_FOUND_ROWS is a bit field; masking is the correct operation.
    if ((clientFlags & CLIENT_FOUND_ROWS_FLAG) === 0) {
        throw new LunoraError(
            "INTERNAL",
            "@lunora/hyperdrive: this MySQL connection was not created with the `CLIENT_FOUND_ROWS` flag " +
                '(mysql2: `createPool({ flags: ["FOUND_ROWS"] })`). Without it, `affectedRows` counts changed (not matched) rows, ' +
                "so an idempotent patch/replace that rewrites identical values reports 0 and the OCC guard raises a spurious conflict.",
        );
    }
};

/**
 * Minimal row-returning client (e.g. `@lunora/hyperdrive`'s `fromPostgresJs`/`fromNodePg`
 * result). Aliases {@link SqlClient} — the exec-facing name is kept so call sites read
 * intent, but the shape is the single source of truth in `./types` (no drift).
 */
export type RowClient = SqlClient;

/**
 * Minimal `mysql2/promise` connection/pool surface — `execute` resolves to `[rows | ResultSetHeader, fields]`. Aliases {@link Mysql2Like} so the /global entry's driver surface can never drift from the main entry's, widened with the (optional, structural) shape {@link assertFoundRows}'s `CLIENT_FOUND_ROWS` probe reads: a real `mysql2/promise` connection/pool exposes the merged client-flags bitmask synchronously, but at two different depths depending on which one it is — neither is in `mysql2`'s own `.d.ts` (whose `Pool extends Connection` signature claims a top-level `config`, but at runtime a `mysql2/promise` `Pool` has none; the real value lives one level down, on the core pool it wraps): a single `Connection`/`PoolConnection` exposes `connection.config.clientFlags`; a `Pool` (the docstring's own `createPool({ flags: ["FOUND_ROWS"] })` example) exposes `pool.pool.config.connectionConfig.clientFlags`. Both fields are optional so a minimal `Mysql2Like` test double (only `execute`) safely resolves to "undeterminable" instead of a `TypeError`.
 */
export type Mysql2Execute = Mysql2Like & {
    config?: { clientFlags?: number };
    pool?: { config?: { connectionConfig?: { clientFlags?: number } } };
};

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
 * non-atomic, at-least-once, and unordered between elements, same as the
 * sequential fallback minus the ordering — safe only for statements whose
 * effects don't depend on each other, which is what every current caller
 * batches (distinct-keyed companion rows).
 */
export const buildPgExec = (client: RowClient): SqlExec => {
    return {
        all: (sql, params) => client.query(sql, params),
        batch: async (statements) => {
            await Promise.all(statements.map((statement) => client.query(statement.sql, statement.params)));
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
 * same values reports 0 and the OCC guard raises a spurious conflict. Verified
 * once here at construction — see {@link assertFoundRows} — never per statement.
 *
 * `batch` dispatches every statement concurrently (`Promise.all`), same
 * rationale as {@link buildPgExec}'s `batch` — `Mysql2Like` only exposes a
 * single-statement `execute`, so this is "spread across a pool's connections"
 * rather than one wire-level multi-statement command; still non-atomic,
 * at-least-once, and unordered between elements, safe only for statements
 * with no cross-effect (what every current caller batches).
 */
export const buildMysqlExec = (connection: Mysql2Execute): SqlExec => {
    assertFoundRows(connection);

    return {
        all: async (sql, params) => {
            const [rows] = await connection.execute(sql, params);

            return rows as Record<string, unknown>[];
        },
        batch: async (statements) => {
            await Promise.all(statements.map((statement) => connection.execute(statement.sql, statement.params)));
        },
        run: async (sql, params): Promise<SqlRunResult> => {
            const [result] = await connection.execute(sql, params);

            return { rowsAffected: (result as { affectedRows?: number }).affectedRows ?? 0 };
        },
    };
};
