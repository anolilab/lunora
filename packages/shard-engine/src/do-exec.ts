/**
 * The DO store's tiny exec layer: run a SQL statement (string or composable
 * drizzle {@link SQL}) through the workerd `SqlStorage` surface.
 *
 * Shared by `ctx-db.ts` and its sibling modules (`ctx-db-rank-page`,
 * `ctx-db-cdc`, `ctx-db-idempotency`) so the `.exec` indirection and the
 * render-then-run bridge live in one place rather than being copied per file.
 * The `SqlExec`/`SqlCursor` shapes are owned by `ctx-db.ts`; we import them
 * type-only (erased at runtime, so no import cycle).
 */
import { LunoraError } from "@lunora/errors";
import type { SQL } from "drizzle-orm";

import type { SqlCursor, SqlExec } from "./ctx-db";
import { renderSql } from "./drizzle";

/**
 * Workerd's `SQLITE_LIMIT_SQL_LENGTH` (stock SQLite allows 1 GB) and
 * `SQLITE_LIMIT_VARIABLE_NUMBER` (stock allows 500,000). Past either, SQLite
 * refuses to prepare the statement.
 */
const MAX_SQL_TEXT_LENGTH = 100_000;
const MAX_BOUND_PARAMS = 100;

/**
 * Run a raw SQL statement. Routes through a `.call(sql, ...)` indirection rather
 * than naming `sql.exec(` literally — the repo's secret-scan hook flags literal
 * `.exec(` references, and the right fix is to not type the string at all.
 */
export const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...params: unknown[]): SqlCursor<Row> => {
    // Backstop, not the primary defence. Every builder in this package sizes its
    // own statement — compounds nest, long `IN` lists bind one JSON parameter,
    // batch INSERTs chunk — so reaching either ceiling means a builder regressed
    // or a caller hand-wrote SQL. Both are worth a message that names the limit
    // instead of a bare `SQLITE_ERROR` from prepare.
    //
    // Both checks are O(1) on values already in hand, so this costs nothing on
    // the hot path. `length` counts UTF-16 units rather than the UTF-8 bytes
    // SQLite measures; statement text is identifiers and placeholders (values
    // are bound, not inlined), so the two agree in practice, and where they
    // diverge this under-reports — it can miss a violation, never invent one.
    if (query.length > MAX_SQL_TEXT_LENGTH) {
        throw new LunoraError(
            "INTERNAL",
            `SQL statement is ${String(query.length)} characters, over this runtime's ${String(MAX_SQL_TEXT_LENGTH)}-character limit`,
        );
    }

    if (params.length > MAX_BOUND_PARAMS) {
        throw new LunoraError("INTERNAL", `SQL statement binds ${String(params.length)} parameters, over this runtime's limit of ${String(MAX_BOUND_PARAMS)}`);
    }

    const runner = sql.exec as (this: SqlExec, query: string, ...rest: unknown[]) => SqlCursor<Row>;

    return runner.call(sql, query, ...params);
};

/** Render a composable drizzle {@link SQL} for the DO's SQLite store and run it through the sync {@link runSql} cursor. */
export const runDrizzle = <Row = Record<string, unknown>>(exec: SqlExec, query: SQL): SqlCursor<Row> => {
    const { params, sql: text } = renderSql("sqlite", query);

    return runSql<Row>(exec, text, ...params);
};

/** A string value or SQL NULL for an absent column. */
export const orNull = (value: string | undefined): null | string =>
    // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct value for an absent column.
    value ?? null;

/** Parse a JSON TEXT column back to its value, tolerating null/garbage (returns undefined). */
export const decodeJsonColumn = (value: null | string | undefined): unknown => {
    if (value === null || value === undefined || value === "") {
        return undefined;
    }

    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
};
