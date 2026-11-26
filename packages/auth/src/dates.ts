import { getAuthTables } from "better-auth/db";

import { quoteIdentifier } from "../../../shared/quote-identifier";
import type { LunoraAuthOptions } from "./create-auth";
import { resolveAuthOptions } from "./create-auth";
import type { SqlExecutor } from "./sql-store";

/**
 * Storage codec for better-auth's `date` fields.
 *
 * `authTables` declares every such column `v.date()`, an epoch-millisecond number, and
 * Lunora's writer re-validates the whole row on `ctx.db.patch`. The adapter therefore has
 * to store numbers: an ISO string written here makes the next Lunora patch of any other
 * column on that row fail validation.
 */

/** An epoch-ms number already stored in a TEXT-affinity column reads back as its digits. */
const EPOCH_DIGITS = /^-?\d+(?:\.\d+)?$/u;

/**
 * Epoch ms for a value better-auth hands the adapter for a `date` field: a `Date` on writes,
 * and on where clauses whatever the caller passed (a `Date`, or an already-serialised string
 * or number). Anything unparseable passes through unchanged, so SQL sees what was given.
 */
const encodeAuthDate = (value: unknown): unknown => {
    if (value instanceof Date) {
        return value.getTime();
    }

    if (typeof value === "string") {
        const millis = EPOCH_DIGITS.test(value) ? Number(value) : Date.parse(value);

        return Number.isNaN(millis) ? value : millis;
    }

    if (Array.isArray(value)) {
        return value.map((entry) => encodeAuthDate(entry));
    }

    return value;
};

/**
 * A stored `date` cell as the `Date` better-auth expects. Accepts the epoch-ms numbers this
 * adapter writes and the ISO strings earlier versions wrote, so rows that predate the
 * conversion keep reading correctly.
 */
const decodeAuthDate = (value: unknown): unknown => {
    if (typeof value === "number") {
        return new Date(value);
    }

    if (typeof value === "string") {
        return new Date(EPOCH_DIGITS.test(value) ? Number(value) : value);
    }

    return value;
};

/**
 * A cell still holding a date string. Digits-only text is an epoch already (a TEXT-affinity
 * column stores a number as its digits), and `julianday()` would read it as a day number.
 */
const isDateText = (column: string): string => `(typeof(${column}) = 'text' AND ${column} GLOB '*[^0-9.-]*')`;

/** Epoch ms for an ISO-8601 cell, computed by SQLite itself; `julianday()` is NULL for anything else. */
const toEpochMs = (column: string): string => `CAST(ROUND((julianday(${column}) - 2440587.5) * 86400000) AS INTEGER)`;

/** One table rewritten by {@link convertAuthDatesToEpochMs}. */
interface AuthDateConversion {
    /** Rows with at least one date column rewritten. */
    converted: number;
    table: string;
}

interface DateTable {
    columns: string[];
    table: string;
}

/** The better-auth tables for `options` that have `date` columns, with those columns' stored names. */
const dateTables = (options: LunoraAuthOptions): DateTable[] =>
    Object.values(getAuthTables(resolveAuthOptions(options)))
        .map((table) => {
            return {
                columns: Object.entries(table.fields)
                    .filter(([, attribute]) => attribute.type === "date")
                    .map(([key, attribute]) => attribute.fieldName ?? key),
                table: table.modelName,
            };
        })
        .filter((entry) => entry.columns.length > 0);

/** Throws, naming the first cell of `entry` that holds text SQLite cannot read as a date. */
const assertConvertible = async (executor: SqlExecutor, entry: DateTable): Promise<void> => {
    const checks = entry.columns.map((column) => {
        const quoted = quoteIdentifier(column);

        return { column, sql: `(${quoted} = '' OR (${isDateText(quoted)} AND julianday(${quoted}) IS NULL))` };
    });
    const [row] = await executor.all(
        `SELECT "id" AS "id", ${checks.map((check, index) => `${check.sql} AS "bad${String(index)}", ${quoteIdentifier(check.column)} AS "value${String(index)}"`).join(", ")} ` +
            `FROM ${quoteIdentifier(entry.table)} WHERE ${checks.map((check) => check.sql).join(" OR ")} LIMIT 1`,
        [],
    );

    if (!row) {
        return;
    }

    const index = checks.findIndex((_, position) => Number(row[`bad${String(position)}`]) === 1);
    const column = checks[index]?.column ?? "?";

    throw new TypeError(
        `convertAuthDatesToEpochMs: ${entry.table}.${column} of row ${String(row["id"])} holds ${JSON.stringify(row[`value${String(index)}`])}, which is not an ISO-8601 date; nothing was converted`,
    );
};

/**
 * Rewrite the ISO-string dates earlier `@lunora/auth` versions stored in better-auth's
 * tables as epoch-ms numbers, matching the `v.date()` columns `authTables` declares.
 *
 * Until a row is converted, a Lunora `ctx.db.patch` on it fails validation, and SQL range
 * filters on its date columns misbehave: SQLite orders every string above every number, so
 * a legacy `expiresAt` never matches `< now` and always matches `> now`.
 *
 * Pass the same options as `createAuth`, so the plugin tables are covered. The tables must
 * already exist. SQLite only (D1, a Durable Object's storage): the conversion runs in SQL,
 * two statements per table whatever its size, so it stays inside D1's per-invocation query
 * limit. Every table is checked before anything is written: a value that is not an ISO-8601
 * date throws, naming the table, column and row, and no row is changed. Idempotent: a
 * converted cell holds a number, which no later run touches.
 *
 * ```ts
 * await convertAuthDatesToEpochMs(d1Executor(env.DB), authOptions);
 * ```
 */
const convertAuthDatesToEpochMs = async (executor: SqlExecutor, options: LunoraAuthOptions): Promise<AuthDateConversion[]> => {
    const tables = dateTables(options);
    const conversions: AuthDateConversion[] = [];

    for (const entry of tables) {
        // eslint-disable-next-line no-await-in-loop -- every table is checked before the first write
        await assertConvertible(executor, entry);
    }

    for (const entry of tables) {
        const quoted = entry.columns.map((column) => quoteIdentifier(column));
        // Each cell is converted only while it still holds date text, so a cell another
        // writer has turned into a number meanwhile keeps that number.
        // eslint-disable-next-line no-await-in-loop -- one statement per table, in order
        const rows = await executor.all(
            `UPDATE ${quoteIdentifier(entry.table)} SET ${quoted.map((column) => `${column} = CASE WHEN ${isDateText(column)} THEN ${toEpochMs(column)} ELSE ${column} END`).join(", ")} ` +
                `WHERE ${quoted.map((column) => isDateText(column)).join(" OR ")} ` +
                `RETURNING "id"`,
            [],
        );

        if (rows.length > 0) {
            conversions.push({ converted: rows.length, table: entry.table });
        }
    }

    return conversions;
};

export type { AuthDateConversion };
export { convertAuthDatesToEpochMs, decodeAuthDate, encodeAuthDate };
