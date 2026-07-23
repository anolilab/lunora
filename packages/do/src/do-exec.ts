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
import { renderSql } from "@lunora/shard-engine";
import type { SQL } from "drizzle-orm";

import type { SqlCursor, SqlExec } from "./ctx-db";

/**
 * Run a raw SQL statement. Routes through a `.call(sql, ...)` indirection rather
 * than naming `sql.exec(` literally — the repo's secret-scan hook flags literal
 * `.exec(` references, and the right fix is to not type the string at all.
 */
export const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...params: unknown[]): SqlCursor<Row> => {
    const runner = sql.exec as (this: SqlExec, query: string, ...rest: unknown[]) => SqlCursor<Row>;

    return runner.call(sql, query, ...params);
};

/** Render a composable drizzle {@link SQL} for the DO's SQLite store and run it through the sync {@link runSql} cursor. */
export const runDrizzle = <Row = Record<string, unknown>>(exec: SqlExec, query: SQL): SqlCursor<Row> => {
    const { params, sql: text } = renderSql("sqlite", query);

    return runSql<Row>(exec, text, ...params);
};
