import { getAuthTables } from "better-auth/db";

import { quoteIdentifier } from "../../../shared/quote-identifier";
import type { BackfillStep, BackfillSteps } from "./canonical-email";
import { BACKFILL_STATE_TABLE, runBackfill, runBackfillSync } from "./canonical-email";
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
    /** Written by the first clean run after the grace period: later automatic runs skip. */
    final?: boolean;
    since: number;
}

const asDatesState = (value: unknown): DatesState | undefined => {
    const state = value as Partial<DatesState> | undefined;

    return Array.isArray(state?.coverage) && typeof state.since === "number" ? (state as DatesState) : undefined;
};

/** SQLite's affinity rules: `INT` wins, then `CHAR` / `CLOB` / `TEXT` make a column text. */
const INTEGER_TYPE = /INT/iu;
const TEXT_TYPE = /CHAR|CLOB|TEXT/iu;
const hasTextAffinity = (declared: string): boolean => !INTEGER_TYPE.test(declared) && TEXT_TYPE.test(declared);

/**
 * Report an app-managed table's date columns declared with text affinity. Lunora's and
 * better-auth's DDL give date columns a numeric type; a table the app created itself may not,
 * and then the epoch numbers the adapter writes are stored as text, so range filters and
 * ordering on them compare as text (chronological only between 2001 and 2286). Logged, not
 * thrown: refusing would also hold back the conversion of every other table.
 */
const warnTextDateColumns = function* warnTextDateColumns(entry: DateTable): BackfillSteps<void> {
    // Per table: D1 refuses `pragma_table_info()` joined over `sqlite_master`.
    const declared = yield { params: [], sql: `PRAGMA table_info(${quoteIdentifier(entry.table)})` };
    const textual = entry.columns.filter((column) =>
        declared.some(
            (row) =>
                typeof row["name"] === "string" &&
                row["name"].toLowerCase() === column.toLowerCase() &&
                typeof row["type"] === "string" &&
                hasTextAffinity(row["type"]),
        ),
    );

    for (const column of textual) {
        // eslint-disable-next-line no-console -- no injected logger at this layer (workerd/Node both capture console)
        console.error(
            `@lunora/auth: ${entry.table}.${column} is a date column with text affinity; declare it REAL, INTEGER, NUMERIC or date so range filters on it compare as numbers.`,
        );
    }
};

/** The tables to convert: every Lunora-provisioned one, and the app-managed ones that exist, found in one statement. */
const presentTables = function* presentTables(options: LunoraAuthOptions): BackfillSteps<DateTable[]> {
    const entries = dateTables(options);
    const appManaged = entries.filter((entry) => entry.appManaged);
    const found =
        appManaged.length === 0
            ? []
            : yield {
                  params: appManaged.map((entry) => entry.table),
                  sql: `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" COLLATE NOCASE IN (${appManaged.map(() => "?").join(", ")})`,
              };
    const names = new Set(found.map((row) => String(row["name"]).toLowerCase()));

    return entries.filter((entry) => !entry.appManaged || names.has(entry.table.toLowerCase()));
};

/**
 * Counts the rows of `entry` still holding convertible date text, and throws instead, naming the
 * first cell holding text this conversion cannot read as a date. One statement for both.
 */
const pendingRows = function* pendingRows(entry: DateTable): BackfillSteps<number> {
    const checks = entry.columns.map((column) => {
        const quoted = quoteIdentifier(column);

        return { column, sql: `(${isDateText(quoted)} AND NOT ${isConvertible(quoted)})` };
    });
    const table = quoteIdentifier(entry.table);
    const pending = entry.columns.map((column) => isConvertible(quoteIdentifier(column))).join(" OR ");
    const [row] = yield {
        params: [],
        sql:
            `SELECT (SELECT COUNT(*) FROM ${table} WHERE ${pending}) AS "pending", "bad".* FROM (SELECT 1) LEFT JOIN (` +
            `SELECT "id" AS "id", ${checks.map((check, index) => `${check.sql} AS "bad${String(index)}", ${quoteIdentifier(check.column)} AS "value${String(index)}"`).join(", ")} ` +
            `FROM ${table} WHERE ${checks.map((check) => check.sql).join(" OR ")} LIMIT 1) AS "bad" ON 1`,
    };

    // The join leaves "id" NULL when no row is unconvertible.
    const id = row?.["id"];

    if (row === undefined || (typeof id !== "string" && typeof id !== "number")) {
        return Number(row?.["pending"] ?? 0);
    }

    const index = checks.findIndex((_, position) => Number(row[`bad${String(position)}`]) === 1);
    const column = checks[index]?.column ?? "?";

    throw new TypeError(
        `convertAuthDatesToEpochMs: ${entry.table}.${column} of row ${String(id)} holds ${JSON.stringify(row[`value${String(index)}`])}, which is not an ISO-8601 date; nothing was converted`,
    );
};

const STATE_TABLE = quoteIdentifier(BACKFILL_STATE_TABLE);

/** The state table, created if absent: a database that never ran a backfill lacks it. */
const STATE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${STATE_TABLE} ("name" TEXT NOT NULL PRIMARY KEY, "cursor" TEXT NOT NULL)`;

/** The record exactly as stored, so a later write can check it is still the one this run read. */
const readDatesRecord = function* readDatesRecord(): BackfillSteps<string | undefined> {
    yield { params: [], sql: STATE_TABLE_DDL };

    const [row] = yield { params: [DATES_STATE], sql: `SELECT "cursor" FROM ${STATE_TABLE} WHERE "name" = ?` };
    const cursor = row?.["cursor"];

    return typeof cursor === "string" ? cursor : undefined;
};

/**
 * The conversion's statements. With `now`, an automatic run, recorded when it finishes: skipped
 * once a run over the same coverage has come back clean after the {@link DATES_GRACE_MS} that
 * followed the first clean one. That last run is a full one, so ISO strings written late in
 * the rollout are converted even when no cold start fell inside the grace period.
 *
 * Queries, for `n` date tables of which `k` are app-managed: one probe for those `k` (none
 * when `k` is 0), then for an automatic run the state table's DDL and record read, which alone
 * make up a skipped run; a column-type read per app-managed table, one check per table, an
 * update per table still holding date text, and the record write. At most `2n + k + 4`, and
 * `n + k + 4` once the rows are converted. The checks stay one statement per table
 * so a long plugin list cannot push a statement past D1's 100 KB limit.
 */
const conversionSteps = function* conversionSteps(options: LunoraAuthOptions, now?: number): BackfillSteps<AuthDateConversion[]> {
    const tables = yield* presentTables(options);
    const coverage = tables.map((entry) => [entry.table, ...entry.columns]);
    const raw = now === undefined ? undefined : yield* readDatesRecord();
    const stored = raw === undefined ? undefined : asDatesState(JSON.parse(raw));
    const recorded = JSON.stringify(stored?.coverage) === JSON.stringify(coverage) ? stored : undefined;

    if (now !== undefined && recorded?.final === true) {
        return [];
    }

    // Every table is checked before any is written.
    const counts: number[] = [];

    for (const entry of tables) {
        if (entry.appManaged) {
            yield* warnTextDateColumns(entry);
        }

        counts.push(yield* pendingRows(entry));
    }

    const conversions: AuthDateConversion[] = [];

    for (const [index, entry] of tables.entries()) {
        const converted = counts[index] ?? 0;

        if (converted === 0) {
            continue;
        }

        const quoted = entry.columns.map((column) => quoteIdentifier(column));

        yield {
            params: [],
            sql: `UPDATE ${quoteIdentifier(entry.table)} SET ${quoted.map((column) => `${column} = CASE WHEN ${isConvertible(column)} THEN ${toEpochMs(column)} ELSE ${column} END`).join(", ")} WHERE ${quoted.map((column) => isConvertible(column)).join(" OR ")}`,
        };

        conversions.push({ converted, table: entry.table });
    }

    if (now !== undefined) {
        const since = recorded?.since ?? now;
        const cursor = JSON.stringify({ coverage, final: now - since >= DATES_GRACE_MS, since } satisfies DatesState);

        // Only over the record this run read: a restore that wrote rows meanwhile has replaced it.
        yield raw === undefined
            ? { params: [DATES_STATE, cursor], sql: `INSERT INTO ${STATE_TABLE} ("name", "cursor") VALUES (?, ?) ON CONFLICT ("name") DO NOTHING` }
            : { params: [cursor, DATES_STATE, raw], sql: `UPDATE ${STATE_TABLE} SET "cursor" = ? WHERE "name" = ? AND "cursor" = ?` };
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

/**
 * The statements an import or replace runs so the next automatic run converts what it restores: a
 * snapshot can bring back dates an earlier version wrote as ISO strings. Run the DDL before writing
 * any row; the invalidation can join a replace's atomic batch. It overwrites the record with a
 * value no run has read, so a conversion in flight cannot then record itself clean: its
 * compare-and-swap no longer matches.
 */
const datesInvalidation = (): { ddl: BackfillStep; invalidate: BackfillStep } => {
    return {
        ddl: { params: [], sql: STATE_TABLE_DDL },
        invalidate: {
            params: [DATES_STATE, JSON.stringify({ invalidated: crypto.randomUUID() })],
            sql: `INSERT INTO ${STATE_TABLE} ("name", "cursor") VALUES (?, ?) ON CONFLICT ("name") DO UPDATE SET "cursor" = excluded."cursor"`,
        },
    };
};

export type { AuthDateConversion };
export { convertAuthDatesOnce, convertAuthDatesOnceSync, convertAuthDatesToEpochMs, datesInvalidation };
