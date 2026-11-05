/**
 * Column provisioning for the `.global()` store: the columns a table is created with, the ones a shipped table is
 * missing, and the `NOT NULL` an existing column should no longer carry.
 *
 * `ctx-db-migrations.ts` imports from here, never the other way. Several isolates can provision one database at once,
 * so adding a column tolerates losing that race ({@link addColumnIfMissing}), and no isolate finishes provisioning a
 * defaulted column before its old rows hold the default ({@link alterGlobalTableDrift}).
 */

import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { validatorAcceptsNull } from "../../../shared/accepts-null";
import type { SqlDialect } from "./dialect";
// eslint-disable-next-line unicorn/prevent-abbreviations -- `SqlCtxExec` is this package's established exec type name.
import type { SqlCtxExec } from "./sql-exec";
import { OCC_VERSION_COLUMN, qualifiedColumnRefSql, queryAll, queryRun, runInOrder, serializeDocumentColumn } from "./sql-exec";
import { effectiveColumnKind } from "./value-codec";

/**
 * SQLite affinity for a column. Resolves the *effective* validator kind (so
 * `v.optional(inner)` stores as `inner` would) and defers to the shared dialect
 * (`@lunora/d1/dialect`) — the same mapping the `lunora migrate generate` SQL
 * emitter uses, so auto-provisioned and hand-migrated tables stay identical.
 */
const globalColumnAffinity = (validator: ValidatorLike, dialect: SqlDialect, indexedInFull = false): string =>
    dialect.columnType(effectiveColumnKind(validator), { unique: indexedInFull || validator._meta?.column?.unique === true });

/**
 * `table.column` pairs {@link relaxNullAcceptingColumns} already reported in
 * this isolate. Provisioning runs once per ctx-db — once per request on a
 * Hyperdrive binding — so an unconditional warning would repeat on every one.
 */
const reportedRelaxations = new Set<string>();

/** Warn once per isolate for `key`. The only channel a provisioning pass has. */
const warnOnce = (key: string, message: string): void => {
    if (reportedRelaxations.has(key)) {
        return;
    }

    reportedRelaxations.add(key);
    // eslint-disable-next-line no-console -- the only channel a provisioning pass has; deduplicated per isolate above.
    console.warn(`[@lunora/sql-store] ${message}`);
};

/** The value a row gets when none is supplied: `.$defaultFn` evaluated once, else `.default(v)`; `undefined` when neither is declared. */
const declaredDefaultOf = (validator: ValidatorLike): unknown => {
    const meta = validator._meta?.column;

    if (meta?.defaultFn) {
        return meta.defaultFn();
    }

    return meta && "defaultValue" in meta ? meta.defaultValue : undefined;
};

/** Is `column` covered by any UNIQUE index, single or composite, or declared `.unique()`? */
const isUniqueColumn = (definition: SchemaLike["tables"][string], column: string, validator: ValidatorLike): boolean =>
    validator._meta?.column?.unique === true || definition.indexes.some((index) => index.unique === true && index.fields.includes(column));

/**
 * How the rows that predate a REQUIRED column get a value once it is added: a `build` that returns the `UPDATE` writing
 * the value its declaration says a row gets when none is supplied, or why there is none to write. A column that may
 * hold null (`v.optional`, `.nullable()`, `v.any()`, a union with `v.null()`) needs nothing: NULL is a valid value
 * there. A required column with no default has no value to invent, and one under a UNIQUE constraint cannot take one:
 * one default written to every old row would collide the moment the index is built (NULLs are distinct, so leaving
 * them builds it), and that would fail provisioning of the whole plane on every pass.
 *
 * `build` evaluates a `.$defaultFn` once, and only when called, so a column that is already there never runs it. A
 * factory that throws, or yields nothing, is reported rather than thrown: the backfill is best-effort.
 */
const columnBackfill = (
    tableName: string,
    definition: SchemaLike["tables"][string],
    column: string,
    validator: ValidatorLike,
): undefined | { build: () => SQL | undefined } | { reason: string } => {
    if (validator.kind === "optional" || validatorAcceptsNull(validator)) {
        return undefined;
    }

    const meta = validator._meta?.column;

    if (isUniqueColumn(definition, column, validator)) {
        return { reason: "is unique, so one default cannot be written to every row" };
    }

    if (meta?.defaultFn === undefined && meta?.defaultValue === undefined) {
        return { reason: "has no default" };
    }

    let built: { query: SQL | undefined } | undefined;

    const build = (): SQL | undefined => {
        try {
            const value = declaredDefaultOf(validator);

            if (value === undefined) {
                warnOnce(
                    `backfill:${tableName}.${column}`,
                    `the default of "${tableName}.${column}" produced no value, so rows written before it read NULL. Run UPDATE "${tableName}" SET "${column}" = … WHERE "${column}" IS NULL.`,
                );

                return undefined;
            }

            return sql`UPDATE ${sql.identifier(tableName)} SET ${sql.identifier(column)} = ${serializeDocumentColumn(definition, column, value)} WHERE ${sql.identifier(column)} IS NULL`;
        } catch (error) {
            warnOnce(
                `backfill:${tableName}.${column}`,
                `could not compute the default of "${tableName}.${column}" (${error instanceof Error ? error.message : String(error)}); rows written before it read NULL. Run UPDATE "${tableName}" SET "${column}" = … WHERE "${column}" IS NULL.`,
            );

            return undefined;
        }
    };

    return {
        build: () => {
            built ??= { query: build() };

            return built.query;
        },
    };
};

/**
 * Run a column's backfill on its own. Best-effort, like {@link relaxNullAcceptingColumns}: a statement that fails is
 * reported with the `UPDATE` to run, not thrown. Throwing would leave the column in place, and undoing the column
 * instead would loop a persistent failure on every pass and could discard what a concurrent request has since written
 * to it.
 */
const runBackfill = async (exec: SqlCtxExec, dialect: SqlDialect, tableName: string, column: string, query: SQL): Promise<void> => {
    try {
        await queryRun(exec, dialect, query);
    } catch (error) {
        warnOnce(
            `backfill:${tableName}.${column}`,
            `could not backfill "${tableName}.${column}" from its default (${error instanceof Error ? error.message : String(error)}); rows written before it read NULL. Run UPDATE "${tableName}" SET "${column}" = … WHERE "${column}" IS NULL.`,
        );
    }
};

/** The columns a `.global()` table must carry beyond `id`/`_creationTime`: the OCC row version, then one per declared field. */
const wantedGlobalColumns = (definition: SchemaLike["tables"][string], dialect: SqlDialect): [column: string, type: string, validator?: ValidatorLike][] => [
    [OCC_VERSION_COLUMN, dialect.companionTypes.integer],
    ...Object.entries(definition.shape)
        .filter(([, validator]) => validator._meta?.column !== undefined)
        .map(([field, validator]): [string, string, ValidatorLike] => [field, globalColumnAffinity(validator, dialect), validator]),
];

/**
 * Does `tableName` have every one of `columns`? One `SELECT <columns> … LIMIT 0`: dialect-blind, no catalog member on
 * {@link SqlDialect}, and it reads no rows. Any failure reads as "no", so it never throws.
 *
 * Every column reference is **table-qualified**, and that is what makes the
 * probe an answer rather than a formality. workerd and D1 build SQLite with the
 * double-quoted-string misfeature enabled, so a bare `"slug"` that resolves to
 * no column is silently reinterpreted as a string literal and the `SELECT`
 * succeeds — the probe reported "no drift" for every table on the only runtime
 * this path runs on. That included {@link OCC_VERSION_COLUMN}, which the
 * guarded-write CAS reads on every `patch`/`replace`/`delete`. A qualified name
 * has no string-literal reading and raises `no such column: t.slug` on all three
 * engines. Verified in `__tests__/workerd/global-table-drift.workerd.test.ts`;
 * `node:sqlite` builds with `SQLITE_DQS=0`, so a Node-only suite cannot see the
 * difference. A probe rather than `PRAGMA table_info`, which D1's authorizer refuses.
 */
const hasColumns = async (exec: SqlCtxExec, dialect: SqlDialect, tableName: string, columns: ReadonlyArray<string>): Promise<boolean> => {
    const alias = "t";

    try {
        await queryAll(
            exec,
            dialect,
            sql`SELECT ${sql.join(
                columns.map((column) => qualifiedColumnRefSql(alias, column)),
                sql`, `,
            )} FROM ${sql.identifier(tableName)} AS ${sql.identifier(alias)} LIMIT 0`,
        );

        return true;
    } catch {
        return false;
    }
};

/**
 * Add `column` to `tableName` unless it is there. The outcome says who added it: `"present"` when it was already there,
 * `"raced"` when another isolate's `ALTER` landed between this one's probe and its own, and `"added"` or `"filled"`
 * when this call added it, `"filled"` meaning it also ran the backfill.
 *
 * With a `backfill`, the `ALTER` and the `UPDATE` go through {@link runInOrder}: one atomic batch on D1, so no other
 * isolate can see the column before its old rows hold the default. Should that unit fail for the backfill's sake, the
 * `ALTER` is retried alone and the column reported `"added"`, leaving the caller to report the backfill.
 *
 * Two isolates cold-starting on one database both probe, both miss, and the slower `ALTER` fails with a
 * duplicate-column error. A failed `ALTER` is accepted when a re-probe finds the column, which keeps this dialect-blind
 * (drivers disagree on errno vs code); any other failure leaves the column missing, so the `ALTER`'s own error
 * surfaces.
 */
const addColumnIfMissing = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    tableName: string,
    column: string,
    type: string,
    backfill?: () => SQL | undefined,
): Promise<"added" | "filled" | "present" | "raced"> => {
    if (await hasColumns(exec, dialect, tableName, [column])) {
        return "present";
    }

    const alter = sql`ALTER TABLE ${sql.identifier(tableName)} ADD COLUMN ${sql.identifier(column)} ${sql.raw(type)}`;
    const fill = backfill?.();

    try {
        await runInOrder(exec, dialect, fill === undefined ? [alter] : [alter, fill]);

        return fill === undefined ? "added" : "filled";
    } catch (error) {
        if (await hasColumns(exec, dialect, tableName, [column])) {
            return "raced";
        }

        if (fill === undefined) {
            throw error;
        }
    }

    return addColumnIfMissing(exec, dialect, tableName, column, type);
};

/**
 * Add one column {@link alterGlobalTableDrift} wants, and backfill it when this isolate added it, or lost the race to
 * the isolate that did: that one's `UPDATE` may not have landed yet, or may have failed.
 */
const provisionColumn = async (
    exec: SqlCtxExec,
    tableName: string,
    definition: SchemaLike["tables"][string],
    dialect: SqlDialect,
    column: string,
    type: string,
    validator: ValidatorLike | undefined,
): Promise<void> => {
    const backfill = validator === undefined ? undefined : columnBackfill(tableName, definition, column, validator);
    const outcome = await addColumnIfMissing(
        exec,
        dialect,
        tableName,
        column,
        type,
        backfill !== undefined && "build" in backfill ? backfill.build : undefined,
    );

    if (backfill === undefined || outcome === "present" || outcome === "filled") {
        return;
    }

    if ("reason" in backfill) {
        if (outcome === "added") {
            warnOnce(
                `backfill:${tableName}.${column}`,
                `"${tableName}.${column}" was added as a required field that ${backfill.reason}, so rows written before it read NULL. Backfill it with a migration (UPDATE "${tableName}" SET "${column}" = … WHERE "${column}" IS NULL).`,
            );
        }

        return;
    }

    const query = backfill.build();

    if (query !== undefined) {
        await runBackfill(exec, dialect, tableName, column, query);
    }
};

/**
 * Add the columns a `.global()` table is missing.
 *
 * `CREATE TABLE IF NOT EXISTS` alone leaves an existing table exactly as it is,
 * so adding a field to a shipped schema provisioned nothing: every `insert` died
 * with the driver's own `table p has no column named slug` — untyped, and never
 * mentioning a remedy — while reads and unrelated patches kept working, so the
 * deploy looked half-healthy.
 *
 * On the overwhelmingly common no-drift path this costs one {@link hasColumns}
 * probe over every declared column. Only when that fails does it go column by
 * column through {@link addColumnIfMissing}.
 *
 * Added columns are always **nullable** in the DDL, whatever the field declares:
 * `ADD COLUMN … NOT NULL` without a default is rejected outright on a non-empty
 * table by all three engines. The declared `notNull` is still enforced on write
 * by the validator, so existing rows are then made to satisfy it: a REQUIRED
 * field that declares a default (`.default(v)`, `.defaultNow()`, `.$defaultFn`)
 * has that default written to every row that has none, evaluated once. The
 * isolate that adds the column writes it in the same unit as the `ALTER` (atomic
 * on D1); an isolate whose own `ALTER` lost the race to it writes it again
 * before it finishes, touching only rows that still read NULL, so it serves no
 * request against unfilled rows while the adding isolate is mid-way, and
 * repairs a backfill that failed there. A column that was already present when
 * this pass probed it is left alone, NULLs and all. Without a D1 batch the `ALTER`
 * and `UPDATE` are two statements, so an isolate whose one-probe check lands between them
 * sees no drift; it reads NULL from old rows until the adder's `UPDATE` lands.
 * A required field with no default has no value to invent, so its existing rows
 * keep reading NULL and a warning names the column; backfill it with an
 * explicit migration before relying on it. The same goes for a column under a UNIQUE constraint, whatever its
 * default (see {@link columnBackfill}), and for a backfill statement that fails ({@link runBackfill}). Additive only, like the `CREATE` it
 * follows — a retype or a drop still needs an explicit migration.
 */
const alterGlobalTableDrift = async (exec: SqlCtxExec, tableName: string, definition: SchemaLike["tables"][string], dialect: SqlDialect): Promise<void> => {
    // The OCC version column leads the list: a table provisioned before it
    // existed carries none, and the guarded-write CAS reads it on every
    // `patch`/`replace`/`delete`.
    const wanted = wantedGlobalColumns(definition, dialect);

    if (
        await hasColumns(
            exec,
            dialect,
            tableName,
            wanted.map(([column]) => column),
        )
    ) {
        return;
    }

    for (const [column, type, validator] of wanted) {
        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the single shared connection.
        await provisionColumn(exec, tableName, definition, dialect, column, type, validator);
    }
};

/**
 * The one-off statement that relaxes a MySQL column to NULL while keeping the
 * declaration it has TODAY. `MODIFY COLUMN` replaces the whole definition, so it
 * is rebuilt from `information_schema` rather than from the current DDL: a
 * legacy column may carry a case-folding collation, or `LONGTEXT` where a
 * `.unique()` column is now `VARCHAR(768)`, and restating today's DDL would
 * change how it compares or fail on rows longer than the new type.
 */
const mysqlRelaxStatement = (tableName: string, field: string, row: Record<string, unknown>): string => {
    const charset = typeof row["charset"] === "string" ? ` CHARACTER SET ${row["charset"]} COLLATE ${String(row["collation"])}` : "";

    return `ALTER TABLE \`${tableName}\` MODIFY COLUMN \`${field}\` ${String(row["type"])}${charset} NULL`;
};

/**
 * Drop `NOT NULL` from the columns of an existing table whose validator accepts
 * null — the constraint every table provisioned before those kinds were exempt
 * still carries, so `insert({ note: null })` kept raising a raw constraint error
 * there after the DDL was fixed.
 *
 * Only Postgres is changed in place: `ALTER COLUMN … DROP NOT NULL` touches the
 * catalog and nothing else, and is a no-op once done. MySQL is NOT — its only
 * way to relax a column is `MODIFY COLUMN`, which restates the whole definition
 * and can rebuild the table, so running it from a cold start would block writes
 * and could change the column's collation or type. Such a column is reported
 * instead, once per isolate, with the exact statement to run (see
 * {@link mysqlRelaxStatement}). SQLite cannot drop a column constraint without a
 * rebuild at all: a D1 table keeps it until it is rebuilt by hand (the global
 * tables migration guide carries the recipe), and `lunora migrate generate`
 * reports the nullability change so the step is not missed.
 *
 * Best-effort by design. A failure here is logged and provisioning carries on:
 * the table still serves every write that does not store `null` in such a
 * column, where rejecting the whole provisioning pass would fail every request,
 * on every isolate, until an operator intervened.
 */
const relaxNullAcceptingColumns = async (exec: SqlCtxExec, tableName: string, definition: SchemaLike["tables"][string], dialect: SqlDialect): Promise<void> => {
    if (dialect.name === "sqlite") {
        return;
    }

    // Exactly the columns the fixed DDL leaves nullable where the old rule did not.
    const candidates = Object.keys(definition.shape).filter((field) => {
        const validator = definition.shape[field] as ValidatorLike;

        return validator._meta?.column?.notNull === true && validator.kind !== "optional" && validatorAcceptsNull(validator);
    });

    if (candidates.length === 0) {
        return;
    }

    try {
        // Postgres needs only the names; MySQL also the declaration the report restates.
        const selected =
            dialect.name === "postgres"
                ? sql`column_name AS ${sql.identifier("name")}`
                : sql`column_name AS ${sql.identifier("name")}, column_type AS ${sql.identifier("type")}, character_set_name AS ${sql.identifier("charset")}, collation_name AS ${sql.identifier("collation")}`;
        const schemaScope = dialect.name === "postgres" ? sql`table_schema = ANY (current_schemas(false))` : sql`table_schema = DATABASE()`;
        const rows = await queryAll(
            exec,
            dialect,
            sql`SELECT ${selected} FROM information_schema.columns WHERE ${schemaScope} AND table_name = ${tableName} AND is_nullable = 'NO' AND column_name IN (${sql.join(
                // eslint-disable-next-line no-restricted-syntax -- drizzle's tagged-template SQL builder binding `field` as a parameter, not a string conversion.
                candidates.map((field) => sql`${field}`),
                sql`, `,
            )})`,
        );

        for (const row of rows) {
            const field = String(row["name"]);

            if (dialect.name === "postgres") {
                // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the single shared connection.
                await queryRun(exec, dialect, sql`ALTER TABLE ${sql.identifier(tableName)} ALTER COLUMN ${sql.identifier(field)} DROP NOT NULL`);
                continue;
            }

            warnOnce(
                `${tableName}.${field}`,
                `"${tableName}"."${field}" accepts null in the schema but its column is NOT NULL, so writing null there fails. Relaxing it on MySQL can rebuild the table, so it is not done at startup; run this once, in a maintenance window: ${mysqlRelaxStatement(tableName, field, row)};`,
            );
        }
    } catch (error) {
        warnOnce(
            `${tableName}:relax-failed`,
            `could not relax NOT NULL on the null-accepting columns of "${tableName}" (${candidates.join(", ")}): ${error instanceof Error ? error.message : String(error)}. Writing null to them fails until the constraint is dropped by hand.`,
        );
    }
};

export { addColumnIfMissing, alterGlobalTableDrift, globalColumnAffinity, relaxNullAcceptingColumns, wantedGlobalColumns };
