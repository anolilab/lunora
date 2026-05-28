/**
 * Wire constants and row shapes for the data-browser's admin introspection RPCs.
 *
 * These mirror the contract that `@cirrus/do`'s `introspect` module serves
 * (the `__cirrus_admin__:*` reserved `functionPath`s intercepted in `ShardDO`).
 * They are duplicated here deliberately: the dashboard ships browser React
 * components and must not pull the Durable Object runtime into the bundle, so
 * the only thing it shares with the server is these plain strings.
 */
export const ADMIN_FUNCTION_PREFIX = "__cirrus_admin__:";

/**
 * Fully-qualified reserved paths the data browser invokes via the client. The
 * `__cirrus_admin__:` prefix is spelled out inline rather than interpolated so
 * the values stay emittable under `--isolatedDeclarations`.
 */
export const ADMIN_FUNCTIONS = {
    listTables: "__cirrus_admin__:listTables",
    readTablePage: "__cirrus_admin__:readTablePage",
} as const;

/** A user table plus its current row count. */
export interface TableInfo {
    name: string;
    rowCount: number;
}

/** A window of rows from one table, plus the column list and total size. */
export interface TablePage {
    columns: string[];
    rows: Record<string, unknown>[];
    total: number;
}
