import type { SqliteAdapter } from "./types";

/**
 * Create a {@link SqliteAdapter} backed by [sql.js](https://sql.js.org)
 * (a WebAssembly build of SQLite that runs in browsers, Node, and
 * React Native).
 * @param database An already-initialised sql.js database instance.
 * @param database.run Execute a parameterised SQL statement (no results).
 * @param database.exec Execute SQL and return result rows.
 * @param database.close Tear down the database connection.
 * @experimental
 */
export const createSqlJsAdapter = (database: {
    close: () => void;
    // sql.js `exec` also accepts bound `params` (same as `run`); type it so
    // the query path can forward them instead of running placeholders unbound.
    exec: (sql: string, params?: unknown[]) => { columns: string[]; values: unknown[][] }[];
    run: (sql: string, params?: unknown[]) => void;
}): SqliteAdapter => {
    return {
        exec(sql: string, params?: ReadonlyArray<unknown>): void {
            if (params && params.length > 0) {
                // Spread to a mutable copy — `params` is `readonly`, but sql.js
                // `run` expects a mutable `unknown[]`.
                database.run(sql, [...params]);
            } else {
                database.exec(sql);
            }
        },

        query<T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>): T[] {
            // Forward bound params so placeholder queries (e.g. LocalMirror's
            // `#ensureTableSchema` existence check) don't run unbound.
            const result = params && params.length > 0 ? database.exec(sql, [...params]) : database.exec(sql);
            const first = result[0];

            if (!first) {
                return [];
            }

            const colNames = first.columns;
            const rows: T[] = [];

            for (const row of first.values) {
                const object: Record<string, unknown> = {};
                for (const [i, column] of colNames.entries()) {
                    object[column] = row[i];
                }
                rows.push(object as T);
            }

            return rows;
        },

        transaction(function_: () => void): void {
            database.run("BEGIN");
            try {
                function_();
                database.run("COMMIT");
            } catch (error) {
                database.run("ROLLBACK");
                throw error;
            }
        },

        lastInsertRowId(): number {
            const result = database.exec("SELECT last_insert_rowid() AS id");
            const firstRow = result[0];
            if (result.length === 0 || !firstRow || firstRow.values.length === 0) {
                return -1;
            }
            const value = firstRow.values[0];
            if (!value || value.length === 0) {
                return -1;
            }
            return Number(value[0]);
        },

        close(): void {
            database.close();
        },
    };
};
