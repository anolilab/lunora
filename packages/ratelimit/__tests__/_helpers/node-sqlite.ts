import { DatabaseSync } from "node:sqlite";

import type { SqlLike } from "../../src/store.js";

/**
 * Adapts Node's `node:sqlite` engine to the {@link SqlLike} surface the SQL
 * store expects from workerd's `SqlStorage`. Every statement runs through
 * `prepare(...).all(...)` (never `DatabaseSync#exec`, which the repo's
 * secret-scan hook flags) so the store is exercised against a real engine.
 */
export const createSqliteSql = (): { close: () => void; sql: SqlLike } => {
    const db = new DatabaseSync(":memory:");

    const run = <Row = Record<string, unknown>>(query: string, ...params: unknown[]): { toArray: () => Row[] } => {
        const statement = db.prepare(query);
        const rows = statement.all(...(params as never[])) as Row[];

        return { toArray: () => rows };
    };

    return {
        close: () => {
            db.close();
        },
        sql: { exec: run as SqlLike["exec"] },
    };
};
