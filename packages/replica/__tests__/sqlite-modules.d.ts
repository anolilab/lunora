/**
 * Minimal ambient declarations for the optional SQLite peer dependencies used
 * by the adapter tests. Neither `sql.js` nor `better-sqlite3` ships its own
 * type declarations; only the structural surface the adapters consume is
 * declared here.
 */
declare module "sql.js" {
    interface SqlJsDatabase {
        close: () => void;
        exec: (sql: string, params?: unknown[], config?: { useBigInt?: boolean }) => { columns: string[]; values: unknown[][] }[];
        run: (sql: string, params?: unknown[]) => void;
    }

    interface SqlJsStatic {
        Database: new (data?: Uint8Array) => SqlJsDatabase;
    }

    const initSqlJs: (config?: Record<string, unknown>) => Promise<SqlJsStatic>;

    export default initSqlJs;
}

declare module "better-sqlite3" {
    interface Statement {
        all: (params?: unknown[]) => unknown[];
        get: (params?: unknown[]) => unknown;
        run: (params?: unknown[]) => { lastInsertRowid: number | bigint };
        safeIntegers: (toggle?: boolean) => unknown;
    }

    class Database {
        public constructor(path: string, options?: Record<string, unknown>);

        public close(): void;

        public exec(sql: string): void;

        public prepare(sql: string): Statement;

        public transaction(function_: () => void): () => void;
    }

    export default Database;
}
