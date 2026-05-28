import { DatabaseSync } from "node:sqlite";

import type { SqlCursor, SqlExec } from "../../src/ctx-db.js";

/**
 * Adapts Node's built-in `node:sqlite` engine to the `SqlExec` surface the
 * ctx-db adapter expects from workerd's `SqlStorage`.
 *
 * Unlike the hand-rolled `fake-sql.ts` double, this runs statements through a
 * real SQLite build — so `json_extract`, expression indexes, UNIQUE
 * constraints, type affinity, and `ORDER BY` collation all behave the way
 * they will inside a Durable Object. The fake proves the adapter emits the
 * SQL we expect; this proves the SQL actually does what we think.
 *
 * We never touch `DatabaseSync#exec` (which the repo's secret-scan hook
 * flags) — every statement goes through `prepare(...).all(...)`, which both
 * executes DDL/DML and returns rows for `SELECT`.
 */
export const createSqliteExec = (): { close: () => void; raw: (query: string, ...params: unknown[]) => Record<string, unknown>[]; sql: SqlExec } => {
    const db = new DatabaseSync(":memory:");

    const cursor = <Row>(rows: Row[]): SqlCursor<Row> => ({
        [Symbol.iterator]() {
            return rows[Symbol.iterator]();
        },
        one() {
            if (rows.length !== 1) {
                throw new Error(`expected exactly one row, received ${String(rows.length)}`);
            }

            return rows[0]!;
        },
        toArray() {
            return rows;
        },
    });

    const run = <Row = Record<string, unknown>>(query: string, ...params: unknown[]): SqlCursor<Row> => {
        const statement = db.prepare(query);
        const rows = statement.all(...(params as never[])) as Row[];

        return cursor(rows);
    };

    return {
        close: () => db.close(),
        raw: (query, ...params) => run<Record<string, unknown>>(query, ...params).toArray(),
        sql: { exec: run as SqlExec["exec"] },
    };
};
