import { getAuthTables } from "better-auth/db";

import { quoteIdentifier } from "../../../shared/quote-identifier";
import type { BackfillSteps } from "./canonical-email";
import { readBackfillState, runBackfill, runBackfillSync, writeBackfillState } from "./canonical-email";
import type { LunoraAuthOptions } from "./create-auth";
import { resolveAuthOptions } from "./create-auth";
import type { SqlExecutor } from "./sql-store";

/**
 * A cell still holding a date string: text other than an epoch number. A TEXT-affinity column
 * stores a number as its digits (a pre-1970 one with its sign), and `julianday()` would read
 * those as a day number.
 */
const isDateText = (column: string): string =>
    `(typeof(${column}) = 'text' AND NOT ((${column} GLOB '[0-9]*' OR ${column} GLOB '-[0-9]*') AND substr(${column}, 2) NOT GLOB '*[^0-9.]*' AND ${column} NOT GLOB '*.*.*' AND ${column} NOT GLOB '*.'))`;

/**
 * Date text this conversion accepts: an ISO-8601 date, optionally with a time, that SQLite can
 * read. `julianday()` alone would also take a bare time (`12:00:00`) and invent a day for it.
 */
const isConvertible = (column: string): string =>
    `(${isDateText(column)} AND ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' AND julianday(${column}) IS NOT NULL)`;

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

/**
 * The state row recording a finished conversion, in the backfill's state table: the tables and
 * columns it covered, so adding a plugin with date columns runs it again, and when a run over
 * that coverage first came back clean.
 */
const DATES_STATE = "dates-epoch-ms";

/**
 * How long automatic runs keep converting after the first clean one. During a gradual deploy,
 * isolates still on an earlier version go on writing ISO strings; a day outlasts the rollout.
 */
const DATES_GRACE_MS = 24 * 60 * 60 * 1000;

interface DatesState {
    coverage: string[][];
    since: number;
}

const asDatesState = (value: unknown): DatesState | undefined => {
    const state = value as Partial<DatesState> | undefined;

    return Array.isArray(state?.coverage) && typeof state.since === "number" ? (state as DatesState) : undefined;
};

/** The tables to convert: every Lunora-provisioned one, and the app-managed ones that exist. */
const presentTables = function* presentTables(options: LunoraAuthOptions): BackfillSteps<DateTable[]> {
    const tables: DateTable[] = [];

    for (const entry of dateTables(options)) {
        if (!entry.appManaged) {
            tables.push(entry);

            continue;
        }

        const found = yield { params: [entry.table], sql: `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE` };

        if (found.length > 0) {
            tables.push(entry);
        }
    }

    return tables;
};

/** Throws, naming the first cell of `entry` that holds text this conversion cannot read as a date. */
const assertConvertible = function* assertConvertible(entry: DateTable): BackfillSteps<void> {
    const checks = entry.columns.map((column) => {
        const quoted = quoteIdentifier(column);

        return { column, sql: `(${isDateText(quoted)} AND NOT ${isConvertible(quoted)})` };
    });
    const [row] = yield {
        params: [],
        sql:
            `SELECT "id" AS "id", ${checks.map((check, index) => `${check.sql} AS "bad${String(index)}", ${quoteIdentifier(check.column)} AS "value${String(index)}"`).join(", ")} ` +
            `FROM ${quoteIdentifier(entry.table)} WHERE ${checks.map((check) => check.sql).join(" OR ")} LIMIT 1`,
    };

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
 * The conversion's statements. With `now`, an automatic run: skipped once a run over the same
 * coverage came back clean more than {@link DATES_GRACE_MS} ago, and recorded when it finishes.
 */
const conversionSteps = function* conversionSteps(options: LunoraAuthOptions, now?: number): BackfillSteps<AuthDateConversion[]> {
    const tables = yield* presentTables(options);
    const coverage = tables.map((entry) => [entry.table, ...entry.columns]);
    const matching = (state: DatesState | undefined): DatesState | undefined =>
        state !== undefined && JSON.stringify(state.coverage) === JSON.stringify(coverage) ? state : undefined;
    const recorded = now === undefined ? undefined : matching(asDatesState(yield* readBackfillState(DATES_STATE)));

    if (now !== undefined && recorded !== undefined && now - recorded.since >= DATES_GRACE_MS) {
        return [];
    }

    for (const entry of tables) {
        yield* assertConvertible(entry);
    }

    const conversions: AuthDateConversion[] = [];

    for (const entry of tables) {
        const quoted = entry.columns.map((column) => quoteIdentifier(column));
        const table = quoteIdentifier(entry.table);
        const pending = quoted.map((column) => isConvertible(column)).join(" OR ");
        // Counted before the update rather than returned by it: `RETURNING` would ship one row
        // per converted record back through the binding.
        const [count] = yield { params: [], sql: `SELECT COUNT(*) AS "n" FROM ${table} WHERE ${pending}` };
        const converted = Number(count?.["n"] ?? 0);

        if (converted === 0) {
            continue;
        }

        yield {
            params: [],
            sql: `UPDATE ${table} SET ${quoted.map((column) => `${column} = CASE WHEN ${isConvertible(column)} THEN ${toEpochMs(column)} ELSE ${column} END`).join(", ")} WHERE ${pending}`,
        };

        conversions.push({ converted, table: entry.table });
    }

    if (now !== undefined) {
        yield* writeBackfillState(DATES_STATE, { coverage, since: recorded?.since ?? now } satisfies DatesState);
    }

    return conversions;
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
const convertAuthDatesToEpochMs = async (executor: SqlExecutor, options: LunoraAuthOptions): Promise<AuthDateConversion[]> =>
    runBackfill(conversionSteps(options), executor);

/**
 * The conversion `ensureMigrated` and the auth Durable Object run on their own: skipped by one
 * indexed lookup once the data has stayed converted through the grace period, so a cold start
 * long after the upgrade does not scan every date table again.
 */
const convertAuthDatesOnce = async (executor: SqlExecutor, options: LunoraAuthOptions): Promise<AuthDateConversion[]> =>
    runBackfill(conversionSteps(options, Date.now()), executor);

/** The same conversion as `convertAuthDatesOnce`, over a synchronous executor, so it finishes before the caller's next statement. */
const convertAuthDatesOnceSync = (exec: (sql: string, params: unknown[]) => Record<string, unknown>[], options: LunoraAuthOptions): AuthDateConversion[] =>
    runBackfillSync(conversionSteps(options, Date.now()), exec);

/** Drop the record of a finished conversion, so the next automatic run converts again. */
const forgetSteps = function* forgetSteps(): BackfillSteps<void> {
    // Read first: it creates the state table, which a database that never ran a backfill lacks.
    yield* readBackfillState(DATES_STATE);
    yield* writeBackfillState(DATES_STATE, undefined);
};

/** After an import or replace: a restored snapshot can bring back dates an earlier version wrote as ISO strings. */
const forgetAuthDatesConversion = async (sql: Pick<SqlExecutor, "all">): Promise<void> => runBackfill(forgetSteps(), sql);

export type { AuthDateConversion };
export { convertAuthDatesOnce, convertAuthDatesOnceSync, convertAuthDatesToEpochMs, forgetAuthDatesConversion };
