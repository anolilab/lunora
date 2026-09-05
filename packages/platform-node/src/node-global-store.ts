/**
 * Node binding of the shared `@lunora/sql-store` core — the `.global()` table
 * backend for this target.
 *
 * `.global()` tables are the one part of the engine that does not live in a
 * shard: they are a single replicated SQL store every shard reads. On
 * Cloudflare that store is D1 (`@lunora/d1`); on PlanetScale it is Postgres or
 * MySQL through Hyperdrive (`@lunora/hyperdrive/global`). Both are the same
 * dialect-parameterized core (`createSqlCtxDb`) with a different
 * `SqlDialect` and a different exec bolted on.
 *
 * This module is the third such binding, and the cheapest: the engine that
 * already backs a Node shard *is* SQLite, so the dialect is the same one D1
 * injects, and the exec is `createNodeSqlExec`'s own wrap of a dedicated
 * `better-sqlite3` connection (below) — a separate connection from any shard's,
 * not `ShardHost.asyncSql` (which no engine path reads). The store lives in its
 * own database file rather than a shard's, because a global table shared by
 * every shard must not be inside any one of them.
 *
 * # Why this imports from `@lunora/d1`
 *
 * `sqliteDialect` is the reference dialect the store core was written against,
 * and it happens to live in `@lunora/d1` — the package's own docstring says it
 * is "kept as a separate module ... so the Postgres/MySQL dialects in
 * `@lunora/hyperdrive/global` have a concrete template to mirror". Nothing
 * about it is Cloudflare-bound (`@lunora/d1`'s dependencies are `@lunora/errors`,
 * `@lunora/platform`, `@lunora/shard-engine`, `@lunora/sql-store` and
 * `drizzle-orm` — the `@cloudflare/workers-types` reference is type-only and
 * erased), so importing it here is a naming awkwardness rather than a layering
 * violation: a Node host depends on a package called `d1`.
 *
 * The tidy fix is to move `sqliteDialect` down into `@lunora/sql-store`, beside
 * the `SqlDialect` contract it implements. That was not done here because it
 * also requires moving `sqlAffinityForKind` out of `@lunora/d1`'s `dialect.ts`,
 * which the CLI migration emitter imports — a three-package refactor with
 * nothing to do with this target. Filed in `plans/234-node-host-findings.md`.
 */

import { sqliteDialect } from "@lunora/d1";
import type { SchemaLike } from "@lunora/shard-engine";
import type { SqlCtxDbOptions, SqlCtxExec } from "@lunora/sql-store";
import {
    backfillSqlSearchIndexes,
    createSqlCtxDb,
    runSqlAggregateMigrations,
    runSqlCdcMigration,
    runSqlGlobalTableMigrations,
    runSqlRankMigrations,
    runSqlSearchMigrations,
} from "@lunora/sql-store";
import Database from "better-sqlite3";

/**
 * Per-connection cache of compiled statements, keyed by SQL text.
 *
 * `database.prepare(sql)` recompiles the statement on every call, and this
 * exec wraps every read and write the `.global()` table core issues through
 * `SqlCtxExec` — so the same SQL text would otherwise be recompiled repeatedly
 * on a hot path. The `WeakMap` key keeps a cache from ever pinning a closed
 * connection.
 */
const statementCache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

const preparedStatement = (database: Database.Database, statement: string): Database.Statement => {
    let cache = statementCache.get(database);

    if (cache === undefined) {
        cache = new Map();
        statementCache.set(database, cache);
    }

    let prepared = cache.get(statement);

    if (prepared === undefined) {
        prepared = database.prepare(statement);
        cache.set(statement, prepared);
    }

    return prepared;
};

/**
 * The Node store options — the shared store options minus the two this binding
 * owns. `dialect` is fixed (SQLite) and `exec` is the store's own connection;
 * letting a caller pass either would let them point the writer at a different
 * engine or a different database than the one `migrate` just provisioned.
 */
export type NodeGlobalContextDatabaseOptions = Omit<SqlCtxDbOptions, "dialect" | "exec">;

/**
 * Wrap a `better-sqlite3` connection as the async exec the store core consumes.
 *
 * `batch` is deliberately **not** implemented. The contract lets an exec that
 * omits it fall back to a sequential `run()` loop, and that fallback is already
 * optimal here: `batch` exists to collapse network round trips (D1 does it
 * atomically in one request; the Hyperdrive adapters dispatch concurrently over
 * a pool), and an embedded database has no round trip to collapse. Declaring it
 * would buy nothing and would opt this exec into the "MAY reorder or
 * parallelize" licence for no reason.
 */
export const createNodeSqlExec = (database: Database.Database): SqlCtxExec => {
    return {
        // eslint-disable-next-line @typescript-eslint/require-await -- the exec seam is async so a networked engine can await; better-sqlite3 is synchronous
        all: async (statement, parameters) => preparedStatement(database, statement).all(...(parameters as unknown[])) as Record<string, unknown>[],
        // eslint-disable-next-line @typescript-eslint/require-await -- see `all`
        run: async (statement, parameters) => {
            const result = preparedStatement(database, statement).run(...(parameters as unknown[]));

            return { rowsAffected: result.changes };
        },
    };
};

/** Options for {@link createNodeGlobalStore}. */
export interface NodeGlobalStoreOptions {
    /**
     * SQLite file backing the `.global()` tables. Defaults to `:memory:`.
     *
     * Deliberately a *separate* database from any shard's: a global table is
     * shared by every shard, so keeping it inside one shard's file would make
     * that shard's lifecycle (and its single-writer gate) the global store's
     * too.
     */
    path?: string;
}

/** A `.global()` store for the Node target, plus the handles to run it down. */
export interface NodeGlobalStore {
    /** The underlying connection, for callers that need to run migrations or inspect it. */
    database: Database.Database;
    /** Close the connection. Safe to call more than once. */
    dispose: () => void;
    /** The async exec the store core (and the migration helpers) consume. */
    exec: SqlCtxExec;

    /**
     * Create the schema's `.global()` tables and every companion table
     * (aggregate, rank, search) they need, then backfill the search indexes.
     * Idempotent — every statement is `CREATE TABLE IF NOT EXISTS`-shaped — so
     * it is safe to run on each boot, which is what a dev server does.
     */
    migrate: (schema: SchemaLike, options?: { cdc?: boolean }) => Promise<void>;
    /** Build a `.global()` writer bound to this store. */
    writer: (options: NodeGlobalContextDatabaseOptions) => ReturnType<typeof createSqlCtxDb>;
}

/**
 * Stand up the `.global()` backend for a Node target.
 *
 * The returned `writer` is the same `createSqlCtxDb` every other backend
 * returns, so the engine above it cannot tell which target it is running on —
 * which is the whole point of the dialect seam.
 */
export const createNodeGlobalStore = (options: NodeGlobalStoreOptions = {}): NodeGlobalStore => {
    const database = new Database(options.path ?? ":memory:");

    database.pragma("journal_mode = WAL");

    const exec = createNodeSqlExec(database);

    return {
        database,
        dispose: () => {
            if (database.open) {
                database.close();
            }
        },
        exec,
        migrate: async (schema, migrateOptions = {}) => {
            await runSqlGlobalTableMigrations(exec, schema, sqliteDialect);
            await runSqlAggregateMigrations(exec, schema, sqliteDialect);
            await runSqlRankMigrations(exec, schema, sqliteDialect);
            await runSqlSearchMigrations(exec, schema, sqliteDialect);
            await backfillSqlSearchIndexes(exec, schema, sqliteDialect);

            if (migrateOptions.cdc === true) {
                await runSqlCdcMigration(exec, sqliteDialect);
            }
        },
        // `exec` doubles as the provisioning scope: the host builds a writer per
        // request, and without a scope each one would re-run the whole
        // CREATE-IF-NOT-EXISTS sweep before its first `.global()` access.
        writer: (writerOptions) => createSqlCtxDb({ ...writerOptions, dialect: sqliteDialect, exec, provisionScope: exec }),
    };
};
