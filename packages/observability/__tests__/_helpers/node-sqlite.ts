import { DatabaseSync } from "node:sqlite";

import type { SqlCursor, SqlExec } from "@lunora/shard-engine";

/**
 * Adapts Node's built-in `node:sqlite` engine to the `SqlExec` surface the
 * ctx-db adapter expects from workerd's `SqlStorage`.
 *
 * This runs statements through a real SQLite build — so `json_extract`,
 * expression indexes, UNIQUE constraints, type affinity, and `ORDER BY`
 * collation all behave the way they will inside a Durable Object. Every DO
 * ctx-db suite uses this harness; the old hand-rolled regex SQL emulator it
 * replaced is gone (only the `messages-schema` fixture survives it).
 *
 * We never touch `DatabaseSync#exec` (which the repo's secret-scan hook
 * flags) — every statement goes through `prepare(...).all(...)`, which both
 * executes DDL/DML and returns rows for `SELECT`.
 */
const createSqliteExec = (): {
    close: () => void;
    raw: (query: string, ...params: unknown[]) => Record<string, unknown>[];
    sql: SqlExec;
} => {
    const database = new DatabaseSync(":memory:");

    const cursor = <Row>(rows: Row[]): SqlCursor<Row> => {
        return {
            one() {
                if (rows.length !== 1) {
                    throw new Error(`expected exactly one row, received ${String(rows.length)}`);
                }

                return rows[0]!;
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
        raw: (query, ...params) => run(query, ...params).toArray(),
        sql: { exec: run },
    };
};

export default createSqliteExec;
