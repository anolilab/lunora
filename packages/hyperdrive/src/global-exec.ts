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

import { lazyValue } from "../../../shared/lazy-value";
import toMysqlParams from "./mysql-params";
import type { Mysql2Like, SqlClient } from "./types";

/**
 * The MySQL wire-protocol `CLIENT_FOUND_ROWS` capability flag — part of the protocol spec (same value for MySQL, MariaDB, PlanetScale, Vitess, …), not a `mysql2`-specific constant, so it's safe to hardcode rather than import.
 */
const CLIENT_FOUND_ROWS_FLAG = 0x00_00_00_02;

/**
 * Connections already warned about, so the "undeterminable" warning really is
 * once per connection rather than once per construction.
 *
 * `buildMysqlExec` is called by `createMysqlGlobalCtxDb`, which the generated
 * shard factory invokes through its `hyperdriveGlobal` thunk PER REQUEST — so
 * any driver that doesn't expose flag introspection (including the package's own
 * documented minimal `Mysql2Like`, which has only `query`) printed this on
 * every single request.
 */
const warnedConnections = new WeakSet<object>();

/** The undocumented driver internals {@link readMysqlClientFlags} probes; all optional. */
type FlagProbeShape = Mysql2Like & {
    config?: { clientFlags?: number };
    pool?: { config?: { connectionConfig?: { clientFlags?: number } } };
};

/**
 * Read the merged client-flags bitmask off a real `mysql2/promise` connection or pool (see {@link Mysql2Client}), trying the single-connection shape first and falling back to the pool's nested shape. Returns `undefined` when neither is present — the driver (or test double) doesn't expose flag introspection.
 */
const readMysqlClientFlags = (connection: Mysql2Client): number | undefined => {
    const probe = connection as FlagProbeShape;
    const direct = probe.config?.clientFlags;

    if (typeof direct === "number") {
        return direct;
    }

    const pooled = probe.pool?.config?.connectionConfig?.clientFlags;

    return typeof pooled === "number" ? pooled : undefined;
};

/**
 * Verify a MySQL connection/pool negotiated `CLIENT_FOUND_ROWS` — once, when
 * `buildMysqlExec`'s loader resolves, never per statement (an extra round trip per
 * query would double the wire traffic for a static property of the connection).
 * Reads the driver's own in-memory client-flags bitmask; no query, no I/O, no
 * write, no permissions required.
 *
 * Determinately **absent** (flag bit unset) throws, naming the flag and the
 * `mysql2` remedy — every time, since a caller that swallowed the first throw
 * must not be allowed to proceed on the second. Determinately **present**
 * returns silently. **Undeterminable** (the connection/pool exposes no flag
 * bitmask at either shape) warns once PER CONNECTION and returns — throwing on
 * "unknown" would break every driver that doesn't expose flag introspection.
 */
const assertFoundRows = (connection: Mysql2Client): void => {
    const clientFlags = readMysqlClientFlags(connection);

    if (clientFlags === undefined) {
        if (warnedConnections.has(connection)) {
            return;
        }

        warnedConnections.add(connection);

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

/** The `mysql2/promise` pool connection a transaction holds: the exec surface plus the transaction verbs. */
interface MysqlPoolConnectionLike {
    beginTransaction: () => Promise<void>;
    commit: () => Promise<void>;
    /** Close the connection instead of returning it to the pool. */
    destroy: () => void;
    release: () => void;
    rollback: () => Promise<void>;
}

/** A `mysql2/promise` pool: what lets one transaction hold one connection while the pool serves everything else. */
interface MysqlPoolLike {
    getConnection: () => Promise<Mysql2Like & MysqlPoolConnectionLike>;
}

/**
 * Run `work` on one connection taken from `pool`, inside `BEGIN` … `COMMIT`, through the exec `wrap` builds over
 * it. A connection whose rollback failed may still hold the open transaction, so it is destroyed rather than handed
 * back to the pool for the next caller to write into.
 */
const mysqlTransaction = async <T>(pool: MysqlPoolLike, wrap: (held: Mysql2Like) => SqlExec, work: (tx: SqlExec) => Promise<T>): Promise<T> => {
    const held = await pool.getConnection();
    let result: T;

    try {
        await held.beginTransaction();
        result = await work(wrap(held));
        await held.commit();
    } catch (error) {
        try {
            await held.rollback();
            held.release();
        } catch {
            held.destroy();
        }

        throw error;
    }

    held.release();

    return result;
};

const raiseNoTransaction = (needs: string): never => {
    throw new LunoraError(
        "GLOBAL_TRANSACTION_UNSUPPORTED",
        `@lunora/hyperdrive: a .global() write needs ${needs} to commit its row and companions together; the supplied driver cannot open a transaction. Pass ${needs}.`,
    );
};

/**
 * Minimal row-returning client (e.g. `@lunora/hyperdrive`'s `fromPostgresJs`/`fromNodePg`
 * result). Aliases {@link SqlClient} — the exec-facing name is kept so call sites read
 * intent, but the shape is the single source of truth in `./types` (no drift).
 */
export type RowClient = SqlClient;

/**
 * Minimal `mysql2/promise` connection/pool surface — `query` resolves to
 * `[rows | ResultSetHeader, fields]`. Aliases {@link Mysql2Like} so the /global
 * entry's driver surface can never drift from the main entry's, widened with the
 * (optional, structural) shape {@link assertFoundRows}'s `CLIENT_FOUND_ROWS`
 * probe reads.
 *
 * A real `mysql2/promise` connection/pool exposes the merged client-flags
 * bitmask synchronously, but at two different depths depending on which one it
 * is, and NEITHER is in `mysql2`'s own `.d.ts` — its `Pool extends Connection`
 * signature claims a top-level `config`, but at runtime a `mysql2/promise`
 * `Pool` has none; the real value lives one level down, on the core pool it
 * wraps:
 *
 * - a single `Connection`/`PoolConnection` → `connection.config.clientFlags`
 * - a `Pool` (the `createPool({ flags: ["FOUND_ROWS"] })` example above) →
 * `pool.pool.config.connectionConfig.clientFlags`
 *
 * Because those paths are undocumented driver internals, `global-dialect.test.ts`
 * pins them against a REAL `mysql2` pool (built without connecting) rather than
 * only against hand-written doubles — if a `mysql2` release relocates them, the
 * probe would otherwise degrade silently to the warn branch and the OCC guard
 * would go unchecked.
 *
 * The probe fields are typed `unknown` publicly: the paths are not in `mysql2`'s
 * typings, so spelling them out made a real `createPool(...)` fail to type-check
 * (TS2345, weak-type mismatch on `config`). {@link readMysqlClientFlags} reads
 * them through the internal `FlagProbeShape` instead, and a minimal test double
 * (only `query`) resolves to "undeterminable" rather than a `TypeError`.
 */
export type Mysql2Client = Mysql2Like & { config?: unknown; pool?: unknown };

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
 *
 * `transaction` is present when `client` has one (`fromPostgresJs`): the
 * store's row + companion writes then run on one reserved connection and
 * commit together.
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
        ...(client.transaction === undefined
            ? {}
            : {
                  transaction: async <T>(work: (tx: SqlExec) => Promise<T>): Promise<T> =>
                      // Called on `client`, not extracted: a driver may implement it as a method that reads `this`.
                      await (client.transaction as NonNullable<RowClient["transaction"]>)(async (tx) => await work(buildPgExec(tx))),
              }),
    };
};

/**
 * Wrap a `mysql2/promise` connection/pool, built by `load` on the first statement,
 * as a {@link SqlExec}. The core already renders backtick identifiers and `?`
 * placeholders for MySQL, so `all`/`run` forward verbatim. MySQL has no
 * `RETURNING`, so `run` surfaces `affectedRows` for the store's affected-rows
 * OCC guard.
 *
 * Statements go over as text with client-side escaping, so the server must not
 * run with `NO_BACKSLASH_ESCAPES` (see {@link Mysql2Like}).
 *
 * **The connection MUST be created with the `CLIENT_FOUND_ROWS` flag**
 * (mysql2: `createPool({ flags: ["FOUND_ROWS"] })`). Without it, `affectedRows`
 * counts *changed* rows, so an idempotent `patch`/`replace` that re-writes the
 * same values reports 0 and the OCC guard raises a spurious conflict. Verified
 * when the loader resolves — see {@link assertFoundRows} — never per statement. A
 * connection without the flag fails that statement and is not kept, so every
 * later statement fails the same way rather than running unguarded.
 *
 * `load` runs on the first statement, not here: `.hyperdriveGlobal`'s `exec(env)`
 * is built with the request's ctx, which can precede the mutation's input-gated
 * span. The `import("mysql2/promise")` inside the loader must start inside that
 * span and finish there, as `buildPgExec(fromPostgresJs(load))` does, so a load
 * begun outside the gate is never awaited inside it.
 *
 * Given a **pool** (anything with `getConnection`), `transaction` takes one
 * connection for the store's row + companion writes, so they commit together.
 * A single connection cannot hold one apart from other writers' statements, so
 * `transaction` is present but rejects with `GLOBAL_TRANSACTION_UNSUPPORTED`: a
 * write to a table with companions fails before it writes anything.
 *
 * `batch` dispatches every statement concurrently (`Promise.all`), same
 * rationale as {@link buildPgExec}'s `batch` — `Mysql2Like` only exposes a
 * single-statement `query`, so this is "spread across a pool's connections"
 * rather than one wire-level multi-statement command; still non-atomic,
 * at-least-once, and unordered between elements, safe only for statements
 * with no cross-effect (what every current caller batches).
 */
export const buildMysqlExec = (load: () => Mysql2Client | Promise<Mysql2Client>): SqlExec => {
    const connection = lazyValue(async () => {
        const loaded = await load();

        assertFoundRows(loaded);

        return loaded;
    });

    const exec: SqlExec = {
        // Always present: whether the driver is a pool is only known once it is loaded. The store treats a present
        // `transaction` as atomic, so a single connection (which cannot hold one apart from other writers) fails loudly
        // instead of committing a row and its companions separately.
        transaction: async <T>(work: (tx: SqlExec) => Promise<T>): Promise<T> => {
            const driver = await connection();
            const { getConnection } = driver as Partial<MysqlPoolLike>;

            return typeof getConnection === "function"
                ? await mysqlTransaction(driver as unknown as MysqlPoolLike, (held) => buildMysqlExec(() => held), work)
                : raiseNoTransaction("a mysql2 pool (`createPool`)");
        },
        all: async (sql, params) => {
            const driver = await connection();
            const [rows] = await driver.query(sql, toMysqlParams(params));

            // mysql2 hands back a `ResultSetHeader`, not a row array, for a
            // statement that returns no rows. Normalised to `[]` here the same
            // way `fromMysql2` (`create-hyperdrive.ts`) does — two adapters over
            // one driver that disagreed on the same shape is how one of them
            // ends up handing a caller a non-array it will index into.
            return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
        },
        batch: async (statements) => {
            const driver = await connection();

            await Promise.all(statements.map((statement) => driver.query(statement.sql, toMysqlParams(statement.params))));
        },
        run: async (sql, params): Promise<SqlRunResult> => {
            const driver = await connection();
            const [result] = await driver.query(sql, toMysqlParams(params));

            return { rowsAffected: (result as { affectedRows?: number }).affectedRows ?? 0 };
        },
    };

    return exec;
};
