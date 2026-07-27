import { DatabaseSync } from "node:sqlite";

import type { SqlCursor, SqlExec } from "../../src/ctx-db";

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
 *
 * ## `withoutFts5`
 *
 * Whether `node:sqlite` ships FTS5 depends on the Node build — 22.14 does not,
 * 22.23 and 24 do. The ctx-db branches on that capability (FTS5 shadow table
 * vs. a LIKE scan over the document table), so leaving it to the ambient build
 * means whichever branch the local Node happens to have is the only one under
 * test, and the other is exercised by nobody until CI's other matrix leg fails.
 * That is not hypothetical: it is how an unguarded read-time backfill shipped
 * green on Node 24 and threw "no such table" on every search under 22.14.
 *
 * Passing `withoutFts5` makes the fts5 virtual-table DDL fail with the exact
 * error a build lacking the module raises, so a suite can pin both branches on
 * any Node. It fails the DDL only — the availability probe and the real
 * `CREATE VIRTUAL TABLE … USING fts5(…)` alike — and leaves every other
 * statement untouched.
 */
const createSqliteExec = (
    options: { withoutFts5?: boolean } = {},
): {
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
        // eslint-disable-next-line vitest/no-conditional-tests -- a harness branch on the engine's declared capability, not a conditional assertion
        if (options.withoutFts5 === true && /\busing\s+fts5\b/iu.test(query)) {
            // Byte-for-byte what SQLite raises when the module is absent, so the
            // capability probe classifies it the same way it would in the wild.
            throw new Error("no such module: fts5");
        }

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
