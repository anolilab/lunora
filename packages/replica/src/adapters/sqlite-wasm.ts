import type { SqliteAdapter } from "./types";

/**
 * Create a {@link SqliteAdapter} backed by the [official SQLite Wasm](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm)
 * (a WebAssembly build of SQLite that runs in browsers and Node.js).
 *
 * The adapter takes a structural projection of the OO API (`sqlite3.oo1.DB`) so
 * the package never imports from `@sqlite.org/sqlite-wasm` directly — consumers
 * install it themselves and pass in their database instance.
 * @param database An already-initialised `sqlite3.oo1.DB` instance.
 * @param database.close Tear down the database connection.
 * @param database.exec Execute SQL with optional bind params and return rows
 * as `{ columns, values }` result objects.
 * @experimental
 */
export const createSqliteWasmAdapter = (database: {
    close: () => void;
    exec: (
        sql: string,
        options?: {
            bind?: unknown[];
            returnValue?: "resultRows" | "simple";
            rowMode?: "array" | "object";
        },
    ) => { columns: string[]; values: unknown[][] }[];
}): SqliteAdapter => {
    return {
        exec(sql: string, params?: ReadonlyArray<unknown>): void {
            if (params && params.length > 0) {
                database.exec(sql, { bind: [...params] });
            } else {
                database.exec(sql);
            }
        },

        query<T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>): T[] {
            const options = params && params.length > 0 ? { bind: [...params], returnValue: "resultRows" as const } : { returnValue: "resultRows" as const };
            const result = database.exec(sql, options);
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
            database.exec("BEGIN");
            try {
                function_();
                database.exec("COMMIT");
            } catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
        },

        lastInsertRowId(): number {
            const result = database.exec("SELECT last_insert_rowid() AS id", { returnValue: "resultRows" });
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
