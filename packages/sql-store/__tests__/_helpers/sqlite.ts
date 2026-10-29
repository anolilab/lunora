import { DatabaseSync } from "node:sqlite";

import { sql } from "drizzle-orm";

import type { SqlCtxExec } from "../../src/ctx-db";
import type { SqlDialect } from "../../src/dialect";
import renderFor from "./render-for";

/**
 * The node-only SQLite harness the sql-store suites share: a minimal reference dialect over
 * `node:sqlite`, and an exec on top of it. Kept out of the workerd suites, which use a real D1 binding.
 */

/** Both workerd and `node:sqlite` phrase a UNIQUE-index breach as "UNIQUE constraint failed". */
const UNIQUE_VIOLATION_RE = /unique constraint failed/iu;

const sqlAffinityForKind = (kind: string | undefined): string => {
    switch (kind) {
        case "bigint": {
            return "TEXT";
        }
        case "boolean": {
            return "INTEGER";
        }
        case "number": {
            return "REAL";
        }
        default: {
            return "TEXT";
        }
    }
};

/** A minimal reference SQLite dialect, mirroring `@lunora/d1`'s sqliteDialect (kept local so sql-store has no dependency on a downstream package). */

/**
 * Does this runtime's `node:sqlite` have the FTS5 module compiled in?
 *
 * It is a property of the RUNTIME, not of the dialect: Node 24 bundles a SQLite
 * with FTS5, Node 22 does not. Hard-coding `supportsFts5: true` made these
 * tests pass on one CI matrix leg and fail on the other with
 * `no such module: fts5`.
 *
 * Probing keeps both legs meaningful rather than skipping: where FTS5 exists
 * the suite exercises the `fts5` search layout, and where it does not it
 * exercises the portable `inverted` layout — which is exactly the split the
 * store already models for backends without FTS5.
 */
const RUNTIME_HAS_FTS5 = ((): boolean => {
    const probe = new DatabaseSync(":memory:");

    try {
        probe.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)");

        return true;
    } catch {
        return false;
    } finally {
        probe.close();
    }
})();

export const makeSqliteDialect = (name: SqlDialect["name"] = "sqlite"): SqlDialect => {
    return {
        columnType: (kind) => sqlAffinityForKind(kind),
        companionTypes: {
            autoincrementPrimaryKey: "INTEGER PRIMARY KEY AUTOINCREMENT",
            integer: "INTEGER",
            key: "TEXT",
            real: "REAL",
            text: "TEXT",
        },
        maxTableColumns: 100,
        frameworkColumns: () => [
            { name: "id", type: "TEXT PRIMARY KEY" },
            { name: "_creationTime", type: "REAL NOT NULL" },
        ],
        isUniqueViolation: (error) => error instanceof Error && UNIQUE_VIOLATION_RE.test(error.message),
        render: renderFor(name),
        name,
        supportsFts5: RUNTIME_HAS_FTS5,
        supportsReturning: true,
        tableExists: (table) => sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
    };
};

export const createSqliteHarness = (): { close: () => void; exec: SqlCtxExec } => {
    const database = new DatabaseSync(":memory:");

    const all = (query: string, parameters: ReadonlyArray<unknown>): Record<string, unknown>[] => database.prepare(query).all(...(parameters as never[]));

    return {
        close: () => {
            database.close();
        },
        exec: {
            all: (query, parameters) => Promise.resolve(all(query, parameters)),
            run: (query, parameters) => {
                all(query, parameters);

                return Promise.resolve();
            },
        },
    };
};

/**
 * A `node:sqlite` exec WITH `batch`, shaped like D1's: the statements run in order inside one transaction, and a
 * failure rolls the whole array back. Exposes the database so a test can read the catalog directly, and `trips`
 * counts every call into the exec (a `batch` is one), which is the number that costs a network round trip on D1.
 */
export const createSqliteBatchHarness = (): { close: () => void; database: DatabaseSync; exec: SqlCtxExec; trips: () => number } => {
    const database = new DatabaseSync(":memory:");
    let trips = 0;

    const all = (query: string, parameters: ReadonlyArray<unknown>): Record<string, unknown>[] => database.prepare(query).all(...(parameters as never[]));

    return {
        close: () => {
            database.close();
        },
        database,
        exec: {
            all: (query, parameters) => {
                trips += 1;

                return Promise.resolve(all(query, parameters));
            },
            batch: (statements) => {
                trips += 1;
                database.exec("BEGIN");

                try {
                    for (const statement of statements) {
                        all(statement.sql, statement.params);
                    }

                    database.exec("COMMIT");

                    return Promise.resolve();
                } catch (error) {
                    database.exec("ROLLBACK");

                    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
                }
            },
            run: (query, parameters) => {
                trips += 1;
                all(query, parameters);

                return Promise.resolve();
            },
        },
        trips: () => trips,
    };
};
