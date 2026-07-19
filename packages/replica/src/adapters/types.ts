/**
 * Abstract SQLite driver interface used by the local mirror.
 *
 * Each runtime (browser via sql.js, React Native via expo-sqlite,
 * Node via better-sqlite3) provides its own adapter implementing this
 * interface so the rest of `@lunora/replica` stays platform-agnostic.
 * @experimental
 */
export interface SqliteAdapter {
    /** Close the database connection. */
    close: () => void;

    /** Execute a SQL statement (with optional bound params). */
    exec: (sql: string, params?: ReadonlyArray<unknown>) => void;

    /** Return the id of the last inserted row. */
    lastInsertRowId: () => number;

    /**
     * Execute a SQL statement and return the result rows.
     * Columns can be accessed by index or by name.
     */
    query: <T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>) => T[];

    /** Run all statements in a transaction. */
    transaction: (function_: () => void) => void;
}
