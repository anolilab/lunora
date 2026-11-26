import { getAuthTables } from "better-auth/db";

import { quoteIdentifier } from "../../../shared/quote-identifier";
import type { LunoraAuthOptions } from "./create-auth";
import { resolveAuthOptions } from "./create-auth";
import type { SqlExecutor } from "./sql-store";

/**
 * A cell still holding a date string: text other than plain epoch digits. A
 * TEXT-affinity column stores a number as its digits, and `julianday()` would read those as
 * a day number.
 */
const isDateText = (column: string): string =>
    `(typeof(${column}) = 'text' AND NOT (${column} GLOB '[0-9]*' AND ${column} NOT GLOB '*[^0-9.]*' AND ${column} NOT GLOB '*.*.*' AND ${column} NOT GLOB '*.'))`;

/** Date text SQLite can read; `julianday()` is NULL for anything else, the empty string included. */
const isConvertible = (column: string): string => `(${isDateText(column)} AND julianday(${column}) IS NOT NULL)`;

/** Epoch ms for an ISO-8601 cell, computed by SQLite itself. */
const toEpochMs = (column: string): string => `CAST(ROUND((julianday(${column}) - 2440587.5) * 86400000) AS INTEGER)`;

/** One table rewritten by {@link convertAuthDatesToEpochMs}. */
interface AuthDateConversion {
    /** Rows with at least one date column rewritten. */
    converted: number;
    table: string;
}

interface DateTable {
    /** Owned by the app (`disableMigration`): Lunora never creates it, so it may be absent. */
    appManaged: boolean;
    columns: string[];
    table: string;
}

/** The better-auth tables for `options` that have `date` columns, with those columns' stored names. */
const dateTables = (options: LunoraAuthOptions): DateTable[] =>
    Object.values(getAuthTables(resolveAuthOptions(options)))
        .map((table) => {
            return {
                appManaged: table.disableMigrations === true,
                columns: Object.entries(table.fields)
                    .filter(([, attribute]) => attribute.type === "date")
                    .map(([key, attribute]) => attribute.fieldName ?? key),
                table: table.modelName,
            };
        })
        .filter((entry) => entry.columns.length > 0);

const tableExists = async (executor: SqlExecutor, table: string): Promise<boolean> => {
    const rows = await executor.all(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);

    return rows.length > 0;
};

/** Throws, naming the first cell of `entry` that holds text SQLite cannot read as a date. */
const assertConvertible = async (executor: SqlExecutor, entry: DateTable): Promise<void> => {
    const checks = entry.columns.map((column) => {
        const quoted = quoteIdentifier(column);

        return { column, sql: `(${isDateText(quoted)} AND julianday(${quoted}) IS NULL)` };
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
 * Pass the same options as `createAuth`, so the plugin tables are covered. The tables Lunora
 * provisions must exist; a plugin table the app manages itself (`disableMigration`) is
 * converted when present and skipped when absent. SQLite only (D1, a Durable Object's
 * storage): the conversion runs in SQL, a fixed handful of statements per table whatever its
 * size, so it stays inside D1's per-invocation query limit and returns no rows.
 *
 * Every table is checked before anything is written: a value that is not an ISO-8601 date
 * throws, naming the table, column and row, and no row is changed. The update converts only
 * text SQLite can still read as a date, so a value written meanwhile is never erased.
 * Idempotent: a converted cell holds a number, which no later run touches, so a run that
 * stops part-way is finished by running it again.
 *
 * ```ts
 * await convertAuthDatesToEpochMs(d1Executor(env.DB), authOptions);
 * ```
 */
const convertAuthDatesToEpochMs = async (executor: SqlExecutor, options: LunoraAuthOptions): Promise<AuthDateConversion[]> => {
    const tables: DateTable[] = [];

    for (const entry of dateTables(options)) {
        // eslint-disable-next-line no-await-in-loop -- one probe per app-managed table, before any check
        if (!entry.appManaged || (await tableExists(executor, entry.table))) {
            tables.push(entry);
        }
    }

    for (const entry of tables) {
        // eslint-disable-next-line no-await-in-loop -- every table is checked before the first write
        await assertConvertible(executor, entry);
    }

    const conversions: AuthDateConversion[] = [];

    for (const entry of tables) {
        const quoted = entry.columns.map((column) => quoteIdentifier(column));
        const table = quoteIdentifier(entry.table);
        const pending = quoted.map((column) => isConvertible(column)).join(" OR ");
        // Counted before the update rather than returned by it: `RETURNING` would ship one row
        // per converted record back through the binding.
        // eslint-disable-next-line no-await-in-loop -- one count per table, in order
        const [count] = await executor.all(`SELECT COUNT(*) AS "n" FROM ${table} WHERE ${pending}`, []);
        const converted = Number(count?.["n"] ?? 0);

        if (converted === 0) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- one statement per table, in order
        await executor.run(
            `UPDATE ${table} SET ${quoted.map((column) => `${column} = CASE WHEN ${isConvertible(column)} THEN ${toEpochMs(column)} ELSE ${column} END`).join(", ")} WHERE ${pending}`,
            [],
        );

        conversions.push({ converted, table: entry.table });
    }

    return conversions;
};

export type { AuthDateConversion };
export { convertAuthDatesToEpochMs };
