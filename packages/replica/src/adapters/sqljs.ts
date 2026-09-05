import { narrowSafeIntegers } from "./int64";
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
    // The third argument is the per-call config that carries `useBigInt`.
    exec: (sql: string, params?: unknown[], config?: { useBigInt?: boolean }) => { columns: string[]; values: unknown[][] }[];
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
            //
            // `useBigInt` decodes INTEGER columns as `bigint` rather than
            // through a double — see `./int64`. `narrowSafeIntegers` puts an
            // ordinary integer back to a `number`, so only a real int64 stays wide.
            const result = database.exec(sql, params && params.length > 0 ? [...params] : undefined, { useBigInt: true });
            const first = result[0];

            if (!first) {
                return [];
            }

            const colNames = first.columns;
            const rows: Record<string, unknown>[] = [];

            for (const row of first.values) {
                const object: Record<string, unknown> = {};
                for (const [i, column] of colNames.entries()) {
                    object[column] = row[i];
                }
                rows.push(object);
            }

            return narrowSafeIntegers<T>(rows);
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

        close(): void {
            database.close();
        },
    };
};
