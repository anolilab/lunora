// eslint-disable-next-line n/no-unsupported-features/node-builtins -- `node:sqlite` is stable enough on the supported runtimes (Node ^22.15 || >=24.10) and is the deliberate in-memory engine for this Node-only harness
import { DatabaseSync } from "node:sqlite";

import { LunoraError } from "@lunora/errors";
import type { SqlCursor, SqlExec } from "@lunora/shard-engine";

/**
 * Adapts Node's built-in `node:sqlite` engine to the {@link SqlExec} surface
 * that `@lunora/do`'s `createShardCtxDb` / `runShardMigrations` expect from
 * workerd's `SqlStorage`.
 *
 * This is a re-implementation of the test helper that lives at
 * `packages/do/__tests__/_helpers/node-sqlite.ts` — that file is a private test
 * fixture in another package and cannot be imported, so the ~50-line adapter is
 * ported here so `@lunora/testing` runs the user's functions against a real
 * SQLite build (so `json_extract`, expression indexes, UNIQUE constraints, type
 * affinity, and `ORDER BY` collation behave the way they will inside a Durable
 * Object).
 *
 * We never touch `DatabaseSync#exec` (which the repo's secret-scan hook flags) —
 * every statement goes through `prepare(...).all(...)`, which both executes
 * DDL/DML and returns rows for `SELECT`.
 */
const createSqlExec = (): { close: () => void; sql: SqlExec } => {
    const database = new DatabaseSync(":memory:");

    const cursor = <Row>(rows: Row[]): SqlCursor<Row> => {
        return {
            one() {
                if (rows.length !== 1) {
                    throw new LunoraError("INTERNAL", `expected exactly one row, received ${String(rows.length)}`);
                }

                const [only] = rows;

                return only as Row;
            },
            [Symbol.iterator]() {
                return rows[Symbol.iterator]();
            },
            toArray() {
                return rows;
            },
        };
    };

    const run = <Row = Record<string, unknown>>(query: string, ...params: unknown[]): SqlCursor<Row> => {
        const statement = database.prepare(query);
        const rows = statement.all(...(params as never[])) as Row[];

        return cursor(rows);
    };

    return {
        close: () => {
            database.close();
        },
        sql: { exec: run },
    };
};

// eslint-disable-next-line import/prefer-default-export -- named export: import sites stay uniform (`import { createSqlExec }`), per the repo's no-default-mixing convention
export { createSqlExec };
