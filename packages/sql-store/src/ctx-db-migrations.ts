/**
 * Provisioning for the `.global()` store: everything that reshapes the DATABASE
 * rather than reads or writes a row.
 *
 * Table DDL and its drift repair, the declared/`.unique()`/default-order
 * indexes, the aggregate and rank companion tables, and the one-shot `v.bigint()`
 * storage rewrite — the cluster `ensureMigrated` runs once per ctx-db, and
 * nothing on a read or write path calls.
 *
 * Split out of `ctx-db.ts` along the same seam as `ctx-db-search.ts` and for the
 * same reason: everything here reaches the engine through `sql-exec`, never
 * through the store core, so there is no cycle back. Mirrors the DO plane, whose
 * `ctx-db-migrations.ts` holds the identical cluster.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-migrations" mirrors its parent "ctx-db.ts", the established module name in this package. */
/* eslint-disable no-restricted-syntax -- `sql\`…\`` here is the drizzle tagged-template SQL builder, not a string conversion; the rule misfires on the inner TemplateLiteral. */

import { LunoraError } from "@lunora/errors";
import type { RankIndexDefinitionLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { aggregateTableName, rankTableName, renderSql, sortColumnName } from "@lunora/shard-engine";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { SqlDialect } from "./dialect";
import type { SqlCtxExec } from "./sql-exec";
import { columnRefSql, createIndexIfNotExists, OCC_VERSION_COLUMN, queryAll, queryBatch, queryRun, tableColumns } from "./sql-exec";
import { BIGINT_KEY_LENGTH, bigintSqlKey, effectiveColumnKind } from "./value-codec";

/**
 * SQLite affinity for a column. Resolves the *effective* validator kind (so
 * `v.optional(inner)` stores as `inner` would) and defers to the shared dialect
 * (`@lunora/d1/dialect`) — the same mapping the `lunora migrate generate` SQL
 * emitter uses, so auto-provisioned and hand-migrated tables stay identical.
 */
const globalColumnAffinity = (validator: ValidatorLike, dialect: SqlDialect): string => dialect.columnType(effectiveColumnKind(validator));

/** Build the column DDL for a global table as a drizzle `SQL`: framework columns plus a typed column per declared field. */
const globalTableColumnsDdl = (tableName: string, definition: SchemaLike["tables"][string], dialect: SqlDialect): SQL => {
    const fieldColumns: SQL[] = [];

    for (const [field, validator] of Object.entries(definition.shape)) {
        if (!validator._meta?.column) {
            continue;
        }

        // Required, non-optional fields get NOT NULL; optional ones stay nullable
        // so an insert that omits them can't trip a constraint.
        const notNull = validator._meta.column.notNull && validator.kind !== "optional" ? " NOT NULL" : "";

        fieldColumns.push(sql`${sql.identifier(field)} ${sql.raw(`${globalColumnAffinity(validator, dialect)}${notNull}`)}`);
    }

    const frameworkColumns = [
        ...dialect.frameworkColumns().map((column) => sql`${sql.identifier(column.name)} ${sql.raw(column.type)}`),
        // The optimistic-concurrency row version (see `OCC_VERSION_COLUMN`).
        // Nullable and untyped by the dialect's `frameworkColumns` on purpose:
        // it is the store core's own bookkeeping, not part of the physical
        // contract the D1/Hyperdrive dialects publish, and `INSERT` never binds
        // it.
        sql`${sql.identifier(OCC_VERSION_COLUMN)} ${sql.raw(dialect.companionTypes.integer)}`,
    ];
    const total = frameworkColumns.length + fieldColumns.length;

    // `VALIDATION_ERROR`, not `INTERNAL`: a table too wide is the schema
    // author's input, and an internal-coded error has its message replaced with
    // "Internal error" on the way out — redacting the one sentence that says
    // what to do. `ensureMigrated` does not cache the rejection, so every
    // request re-runs this; an opaque 500 forever is a bad way to learn a table
    // has too many columns.
    const limit = dialect.maxTableColumns;

    if (limit !== undefined && total > limit) {
        // Exactly one column over is the case that reads as an accusation
        // rather than a diagnosis: `_version` joined the framework set after
        // this table was provisioned, so a table that fit at the engine's limit
        // yesterday is one column over today, and its rows are real. The limit
        // is hard — no `ALTER` can widen a table already at it — so the
        // difference between the two cases is worth a sentence: one is "your
        // schema is too wide", the other is "your data needs moving first".
        const displacedByRowVersion = total - 1 === limit;
        const path = `Move one or more fields into a single object field, or split the table — either way the existing rows need a data migration (\`defineMigration\` + \`lunora migrate up\`); there is no in-place path.`;

        throw new LunoraError(
            "VALIDATION_ERROR",
            `@lunora/sql-store: global table "${tableName}" needs ${String(total)} columns, over this engine's ${String(limit)}-column limit. ${
                displacedByRowVersion
                    ? `One of them is "${OCC_VERSION_COLUMN}", the row version every guarded write reads, which caps declared fields at ${String(limit - frameworkColumns.length)}. A table provisioned at ${String(limit)} columns before that column existed cannot be widened to hold it. `
                    : ""
            }${path}`,
        );
    }

    return sql.join([...frameworkColumns, ...fieldColumns], sql`, `);
};

/**
 * The default total order every read here ends with, appended to a declared
 * index so the index can answer the sort instead of the engine sorting every
 * match into a temp B-tree.
 *
 * Same defect, same fix, as `INDEX_SORT_KEYS` in `@lunora/shard-engine`'s
 * `ctx-db-migrations.ts` — this backend simply never got it. `compileOrderBySql`
 * below used to say so in its own doc. Measured on `node:sqlite`, 50k rows,
 * `WHERE status = ? ORDER BY _creationTime, id LIMIT 21`: 134.0us against a
 * fields-only index, 11.3us with the sort keys on it, and the `USE TEMP B-TREE
 * FOR ORDER BY` step disappears from the plan.
 *
 * NOT appended to a UNIQUE index: `(email, _creationTime, id)` is unique for
 * every row, so the constraint would silently stop rejecting duplicates — data
 * corruption rather than a slow query. Same split as the DO twin.
 */
const indexSortKeys = (dialect: SqlDialect): SQL | undefined => {
    // Not on an engine that needs a key prefix to index text. MySQL declares
    // `id VARCHAR(768)` — 768 utf8mb4 characters is 3072 bytes, which is exactly
    // InnoDB's whole-index key limit on its own — so appending it to ANY other
    // column raises ER_TOO_LONG_KEY and the migration fails outright. Prefixing
    // it (`id(191)`) would create, but MySQL cannot satisfy an ORDER BY from a
    // prefixed column, so the index would cost writes and buy nothing. The
    // engine that actually backs `.global()` is D1 (SQLite); Postgres indexes
    // text directly and gets the fix too.
    if (dialect.indexKeyPrefix?.("string") !== undefined) {
        return undefined;
    }

    return sql`${columnRefSql("_creationTime")}, ${columnRefSql("id")}`;
};

/**
 * Drop `name` when the engine already holds an index by that name built from a
 * DIFFERENT column list.
 *
 * `CREATE INDEX IF NOT EXISTS` does not replace a differing definition and does
 * not complain, so a database provisioned before {@link indexSortKeys} existed
 * would keep its filter-only index forever and never see the improvement. The
 * DO twin (`dropIndexIfShapeChanged`) exists for exactly this.
 *
 * SQLite only — that is the engine `.global()` tables run on (D1), and it is the
 * one whose catalog echoes the CREATE statement back verbatim, so the comparison
 * is a string compare rather than a per-engine column-list reconstruction. On
 * Postgres/MySQL a pre-existing index of the old shape is left alone: the new
 * shape reaches fresh databases, and an existing one keeps working, slower.
 */
const dropIndexIfShapeChanged = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    spec: { columns: SQL; name: string; refs: SQL[]; table: string; unique: boolean },
): Promise<void> => {
    if (dialect.name !== "sqlite") {
        return;
    }

    const held = await queryAll(exec, dialect, sql`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${spec.name} AND tbl_name = ${spec.table}`);
    const current = held[0]?.["sql"];

    // No row, or an implicit index the engine created for a constraint (`sql` is
    // NULL there) — nothing of ours to replace.
    if (typeof current !== "string") {
        return;
    }

    // Compare the parenthesised column list rather than the whole statement, so
    // this stays insensitive to how the surrounding DDL is spelled.
    const columnsOf = (statement: string): string | undefined => {
        const open = statement.indexOf("(");

        return open === -1 ? undefined : statement.slice(open, statement.lastIndexOf(")") + 1);
    };

    const unique = spec.unique ? sql`UNIQUE ` : sql``;
    const wanted = columnsOf(
        renderSql(dialect.name, sql`CREATE ${unique}INDEX ${sql.identifier(spec.name)} ON ${sql.identifier(spec.table)} (${spec.columns})`).sql,
    );

    if (wanted === undefined || wanted === columnsOf(current)) {
        return;
    }

    // A UNIQUE index is dropped only once we know the new shape can actually be
    // created. Dropping first and letting the follow-up `CREATE UNIQUE INDEX`
    // fail on rows that are duplicates under the NEW column set leaves the table
    // with no constraint at all — and the failed migration re-runs and re-fails
    // on every wake, so the gap does not close on its own. Refusing here keeps
    // the old constraint in force and names what has to be de-duplicated.
    //
    // There is a TOCTOU window between this probe and the create, which is
    // acceptable: this runs at provisioning time, only when an index's declared
    // fields actually changed, and losing the race costs a failed migration
    // rather than a silently unprotected table.
    if (spec.unique) {
        // Restricted to rows where EVERY indexed column is non-NULL, because the
        // two sides disagree about NULL: `GROUP BY` treats NULLs as equal, a
        // SQLite UNIQUE index treats them as distinct. Without the filter, an
        // optional `.unique()` field with two unset rows reads as a duplicate,
        // this throws, and a `CREATE UNIQUE INDEX` that would have SUCCEEDED is
        // refused — on every wake, since the migration re-runs and re-fails.
        const nonNull = sql.join(
            spec.refs.map((reference) => sql`${reference} IS NOT NULL`),
            sql` AND `,
        );
        const duplicates = await queryAll(
            exec,
            dialect,
            sql`SELECT ${spec.columns} FROM ${sql.identifier(spec.table)} WHERE ${nonNull} GROUP BY ${spec.columns} HAVING COUNT(*) > 1 LIMIT 1`,
        );

        if (duplicates.length > 0) {
            throw new LunoraError(
                "INTERNAL",
                `unique index "${spec.name}" on "${spec.table}" cannot be re-created with its new column list: existing rows are duplicates under it. De-duplicate the table with a data migration first; the previous index is left in place.`,
            );
        }
    }

    await queryRun(exec, dialect, sql`DROP INDEX IF EXISTS ${sql.identifier(spec.name)}`);
};

/** Create a global table's declared secondary indexes and its synthesized `.unique()` column indexes. */
const createGlobalTableIndexes = async (exec: SqlCtxExec, tableName: string, definition: SchemaLike["tables"][string], dialect: SqlDialect): Promise<void> => {
    // Index column reference as drizzle SQL, with a key prefix where the engine
    // demands it (MySQL can't index its now-unbounded TEXT string columns without
    // one). Framework columns (id/_creationTime — absent from `shape`) are already
    // index-safe types, so they get no prefix.
    const indexRef = (field: string): SQL => {
        const reference = columnRefSql(field);
        const validator = definition.shape[field];
        const prefix = validator && dialect.indexKeyPrefix ? dialect.indexKeyPrefix(effectiveColumnKind(validator)) : undefined;

        return prefix === undefined ? reference : sql`${reference}(${sql.raw(String(prefix))})`;
    };

    const sortKeys = indexSortKeys(dialect);

    for (const index of definition.indexes) {
        const refs = index.fields.map((field) => indexRef(field));
        const fields = sql.join(refs, sql`, `);
        const unique = index.unique ?? false;
        const spec = {
            columns: unique || sortKeys === undefined ? fields : sql`${fields}, ${sortKeys}`,
            name: `${tableName}_${index.name}`,
            // The columns UNJOINED, for the NULL filter on the duplicate probe in
            // `dropIndexIfShapeChanged` — it needs one predicate per column, which
            // the joined list cannot be taken apart into.
            refs,
            table: tableName,
            unique,
        };

        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared D1 connection.
        await dropIndexIfShapeChanged(exec, dialect, spec);
        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared D1 connection.
        await createIndexIfNotExists(exec, dialect, spec);
    }

    // The DEFAULT total order, for the reads that name no index at all — a bare
    // `findMany({ limit })` or `paginate()`. The table above declares only `id`
    // as its primary key, so nothing indexed `ORDER BY _creationTime, id` and the
    // engine read the whole table into a temp B-tree to return the first page.
    // The DO twin creates the same index on every row table.
    if (sortKeys !== undefined) {
        await createIndexIfNotExists(exec, dialect, { columns: sortKeys, name: `${tableName}__by_creation`, table: tableName, unique: false });
    }

    // `.unique()` columns synthesize a UNIQUE index so the engine enforces the
    // constraint (the write layer maps breaches to ConflictError), mirroring the
    // DO twin's `migrateSecondaryIndexes`.
    for (const [field, column] of tableColumns(definition)) {
        if (!column.unique) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared D1 connection.
        await createIndexIfNotExists(exec, dialect, { columns: indexRef(field), name: `${tableName}_unique_${field}`, table: tableName, unique: true });
    }
};

/**
 * Reserved table recording the one-shot, per-table storage migrations that have
 * run to completion on this binding.
 *
 * One row per finished job, keyed by name — the same shape, and for the same
 * reason, as `__lunora_search_state`: a probe that has to look at the DATA to
 * decide whether it is done costs a scan every time it is asked, and
 * `ensureMigrated` asks once per ctx-db (per request, on a Hyperdrive binding).
 */
const MIGRATION_STATE_TABLE = "__lunora_migration_state";

/** Create the marker table. Idempotent; runs only for a table that has a one-shot migration to consider. */
const ensureMigrationState = async (exec: SqlCtxExec, dialect: SqlDialect): Promise<void> => {
    await queryRun(
        exec,
        dialect,
        sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(MIGRATION_STATE_TABLE)} (${sql.identifier("name")} ${sql.raw(dialect.companionTypes.key)} PRIMARY KEY)`,
    );
};

/** Has `marker`'s migration already finished on this binding? One primary-key lookup. */
const migrationCompleted = async (exec: SqlCtxExec, dialect: SqlDialect, marker: string): Promise<boolean> => {
    const rows = await queryAll(
        exec,
        dialect,
        sql`SELECT ${sql.identifier("name")} FROM ${sql.identifier(MIGRATION_STATE_TABLE)} WHERE ${sql.identifier("name")} = ${marker}`,
    );

    return rows.length > 0;
};

/**
 * Record the bigint rewrite of one table as finished, and report the rows it
 * could not convert — once, here, rather than by re-scanning them on every cold
 * start from now on.
 *
 * A concurrent cold start that inserted the same marker first is the expected
 * race, not a failure: both passes walked the same table to the same end.
 */
const completeBigintRewrite = async (exec: SqlCtxExec, dialect: SqlDialect, marker: string, tableName: string, unconvertible: number): Promise<void> => {
    if (unconvertible > 0) {
        // eslint-disable-next-line no-console -- the only channel a provisioning pass has; reported once per table rather than re-scanned every cold start.
        console.warn(
            `[@lunora/sql-store] bigint storage migration on "${tableName}": ${String(unconvertible)} row(s) hold a value the order-preserving key cannot represent (non-numeric text, or a magnitude past 39 digits) and were left as stored — range filters and ORDER BY over them stay wrong until they are corrected by hand.`,
        );
    }

    try {
        await queryRun(exec, dialect, sql`INSERT INTO ${sql.identifier(MIGRATION_STATE_TABLE)} (${sql.identifier("name")}) VALUES (${marker})`);
    } catch (error) {
        if (!dialect.isUniqueViolation(error)) {
            throw error;
        }
    }
};

/**
 * Rows converted per pass by {@link rewriteLegacyBigintColumns}; keeps one
 * statement's bound-parameter count inside D1's budget.
 *
 * Rendered into the `LIMIT` inline (`sql.raw`) rather than bound: mysql2's
 * prepared-statement path rejects a placeholder there with
 * `Incorrect arguments to mysqld_stmt_execute`, which took the whole MySQL
 * provisioning pass down. It is a module constant, so nothing caller-supplied
 * reaches the statement text.
 */
const BIGINT_REWRITE_PAGE = 100;

/**
 * The declared fields of `table` that are stored as a `bigint` key.
 */
const bigintFields = (definition: SchemaLike["tables"][string]): string[] =>
    Object.entries(definition.shape)
        .filter(([, validator]) => validator._meta?.column !== undefined && effectiveColumnKind(validator) === "bigint")
        .map(([field]) => field);

/**
 * The `SET` assignments that convert one row's legacy `bigint` columns, and the
 * `WHERE` guard that makes applying them safe — both empty when every column
 * already holds a key.
 *
 * The guard is the compare-and-swap the user write path already does
 * (`runGuardedWrite`, in `ctx-db.ts`). The page below is read, then written in a second
 * round trip; a user write that commits in between holds the NEW encoding, and
 * an unguarded `WHERE id = ?` overwrote it with the re-encoded value this pass
 * read — silently reverting a committed write to a stale amount. Comparing each
 * column against the exact text the page read means the losing statement
 * updates nothing, and the row is already in the new encoding either way.
 *
 * A value this encoding cannot hold — non-numeric text no encoder here ever
 * wrote, or a magnitude past the 39-digit ceiling — contributes no assignment
 * and is left exactly as stored rather than aborting the pass.
 */
const legacyBigintRewrite = (row: Record<string, unknown>, fields: ReadonlyArray<string>): { assignments: SQL[]; guards: SQL[] } => {
    const assignments: SQL[] = [];
    const guards: SQL[] = [];

    for (const field of fields) {
        const raw = row[field];

        if (typeof raw !== "string" || raw.length === BIGINT_KEY_LENGTH) {
            continue;
        }

        try {
            const key = bigintSqlKey(BigInt(raw));

            assignments.push(sql`${columnRefSql(field)} = ${key}`);
            guards.push(sql`${columnRefSql(field)} = ${raw}`);
        } catch {
            // Not a value this encoding can hold. Left as stored.
        }
    }

    return { assignments, guards };
};

/**
 * Rewrite any `v.bigint()` column still holding the plain decimal text an
 * earlier build stored into the order-preserving key {@link bigintSqlKey} now
 * writes.
 *
 * This is a **storage-format migration, and it is not optional**. Decimal text
 * is exact for `=` but sorts `"9"` after `"10"`, so every range filter,
 * `ORDER BY`, page cursor and `MIN`/`MAX` over such a column returned the wrong
 * rows. The fix changes what is written — which means a table holding both forms
 * has a worse problem than the one it started with: `where: { n: { eq: 10n } }`
 * binds the key and no longer matches a row stored as `"10"`. Converting the
 * stragglers is what keeps that from being a silent read break, so it runs from
 * the same provisioning pass that creates the table.
 *
 * **A converted table costs one primary-key lookup, and that is the point.**
 * `ensureMigrated` runs per ctx-db — per request on a Hyperdrive binding — and
 * the page probe (`WHERE LENGTH(col) <> 40 AND id > ?`) can use no index for
 * `LENGTH`, so it is a full table scan on every cold start, forever, on a table
 * where it will never match again. Worse, the rows it CANNOT convert keep
 * matching, so each start pages through them from the top. Completion is
 * therefore recorded per table in {@link MIGRATION_STATE_TABLE} and read back
 * before any of that: the walk runs once, and a table it has finished is a
 * single keyed lookup from then on.
 *
 * Recording completion is sound because nothing writes the legacy form any more:
 * a row this pass could not convert is unconvertible for the same reason next
 * time (it is reported once, here, rather than re-scanned every start), and a
 * user write that races the pass writes the NEW encoding — the compare-and-swap
 * in {@link legacyBigintRewrite} is what stops this pass reverting it. The one
 * case that assumption does not cover is an isolate of a PRE-key build still
 * writing while a new one finishes the walk; delete that table's row from
 * `__lunora_migration_state` to make the pass run again.
 *
 * It pages on a keyset cursor over `id`, so a value it cannot convert is stepped
 * over rather than retried forever within a run.
 */
const rewriteLegacyBigintColumns = async (
    exec: SqlCtxExec,
    tableName: string,
    definition: SchemaLike["tables"][string],
    dialect: SqlDialect,
): Promise<void> => {
    const fields = bigintFields(definition);

    if (fields.length === 0) {
        return;
    }

    await ensureMigrationState(exec, dialect);

    const marker = `bigint-key:${tableName}`;

    if (await migrationCompleted(exec, dialect, marker)) {
        return;
    }

    const legacy = sql.join(
        fields.map((field) => sql`(${columnRefSql(field)} IS NOT NULL AND LENGTH(${columnRefSql(field)}) <> ${BIGINT_KEY_LENGTH})`),
        sql` OR `,
    );
    const selected = sql.join([columnRefSql("id"), ...fields.map((field) => columnRefSql(field))], sql`, `);
    let cursor = "";
    let unconvertible = 0;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- keyset pages run sequentially on the single shared connection; each page's cursor comes from the previous one.
        const rows = await queryAll(
            exec,
            dialect,
            sql`SELECT ${selected} FROM ${sql.identifier(tableName)} WHERE (${legacy}) AND ${columnRefSql("id")} > ${cursor} ORDER BY ${columnRefSql("id")} LIMIT ${sql.raw(String(BIGINT_REWRITE_PAGE))}`,
        );

        if (rows.length === 0) {
            // eslint-disable-next-line no-await-in-loop -- the loop's exit: one write, on the shared connection, and the pass is over.
            await completeBigintRewrite(exec, dialect, marker, tableName, unconvertible);

            return;
        }

        const updates: SQL[] = [];

        for (const row of rows) {
            const { id } = row;
            const { assignments, guards } = typeof id === "string" ? legacyBigintRewrite(row, fields) : { assignments: [], guards: [] };

            if (assignments.length === 0) {
                // Matched the probe but holds nothing this encoding can write.
                unconvertible += 1;

                continue;
            }

            updates.push(
                sql`UPDATE ${sql.identifier(tableName)} SET ${sql.join(assignments, sql`, `)} WHERE ${columnRefSql("id")} = ${id} AND ${sql.join(guards, sql` AND `)}`,
            );
        }

        // eslint-disable-next-line no-await-in-loop -- one round trip per page; the rows are keyed by distinct `id`, so order across them doesn't matter.
        await queryBatch(exec, dialect, updates);

        const last = rows.at(-1)?.["id"];

        if (typeof last !== "string") {
            return;
        }

        cursor = last;
    }
};

/**
 * Add the columns a `.global()` table is missing.
 *
 * `CREATE TABLE IF NOT EXISTS` alone leaves an existing table exactly as it is,
 * so adding a field to a shipped schema provisioned nothing: every `insert` died
 * with the driver's own `table p has no column named slug` — untyped, and never
 * mentioning a remedy — while reads and unrelated patches kept working, so the
 * deploy looked half-healthy. Both sibling migrations in this package already
 * reshape their own tables (`runSqlAggregateMigrations` PRAGMA-checks and
 * `ALTER`s, `migrateSearchState` `ALTER`s under a try/catch); only the
 * user-facing table was left out.
 *
 * The probe is one `SELECT <every declared column> … LIMIT 0` — dialect-blind,
 * no catalog member on {@link SqlDialect}, and on the overwhelmingly common
 * no-drift path it is a single statement that reads no rows. Only when that
 * fails does it cost one probe per column to find which are missing.
 *
 * Added columns are always **nullable**, whatever the field declares: existing
 * rows have no value for a field that did not exist, and `ADD COLUMN … NOT NULL`
 * without a default is rejected outright on a non-empty table by all three
 * engines. The declared `notNull` is still enforced on write by the validator.
 * Additive only, like the `CREATE` it follows — a retype or a drop still needs an
 * explicit migration.
 */
const alterGlobalTableDrift = async (exec: SqlCtxExec, tableName: string, definition: SchemaLike["tables"][string], dialect: SqlDialect): Promise<void> => {
    // The OCC version column leads the list: a table provisioned before it
    // existed carries none, and the guarded-write CAS reads it on every
    // `patch`/`replace`/`delete`.
    const wanted: [column: string, type: string][] = [
        [OCC_VERSION_COLUMN, dialect.companionTypes.integer],
        ...Object.entries(definition.shape)
            .filter(([, validator]) => validator._meta?.column !== undefined)
            .map(([field, validator]): [string, string] => [field, globalColumnAffinity(validator, dialect)]),
    ];

    const probe = async (columns: ReadonlyArray<string>): Promise<boolean> => {
        try {
            await queryAll(
                exec,
                dialect,
                sql`SELECT ${sql.join(
                    columns.map((column) => columnRefSql(column)),
                    sql`, `,
                )} FROM ${sql.identifier(tableName)} LIMIT 0`,
            );

            return true;
        } catch {
            return false;
        }
    };

    if (await probe(wanted.map(([column]) => column))) {
        return;
    }

    for (const [column, type] of wanted) {
        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the single shared connection; each probe gates its own ALTER.
        if (await probe([column])) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- same connection, and a failure here must surface rather than race the next ALTER.
        await queryRun(exec, dialect, sql`ALTER TABLE ${sql.identifier(tableName)} ADD COLUMN ${sql.identifier(column)} ${sql.raw(type)}`);
    }
};

/**
 * Auto-provision every `.global()` table from the schema: `CREATE TABLE IF NOT
 * EXISTS` with the physical `id`/`_creationTime` columns plus a typed column per
 * declared field, then its secondary and `.unique()` indexes. This is the D1
 * twin of `@lunora/do`'s `runShardMigrations` (which self-creates shard-local
 * tables) — it makes the schema the single source of truth for global tables
 * too, so a fresh database serves them without a hand-applied migration. The
 * column set and dialect match exactly what this module reads and writes
 * (`columnRef`, `serializeColumnValue`, `decodeGlobalRow`).
 *
 * Idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`); additive only — it never
 * drops or retypes an existing column, so destructive schema changes still need
 * an explicit migration.
 */
const runSqlGlobalTableMigrations = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind !== "global") {
            continue;
        }

        const columns = globalTableColumnsDdl(tableName, definition, dialect);

        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the single shared D1 connection; the table must exist before its indexes below.
        await queryRun(exec, dialect, sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(tableName)} (${columns})`);
        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially; the table must carry every declared column before its indexes reference them.
        await alterGlobalTableDrift(exec, tableName, definition, dialect);
        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially; indexes follow the table.
        await createGlobalTableIndexes(exec, tableName, definition, dialect);
        // eslint-disable-next-line no-await-in-loop -- runs on the same connection, after the columns exist.
        await rewriteLegacyBigintColumns(exec, tableName, definition, dialect);
    }
};

/**
 * Whether a table's companion tables belong in the `.global()` database.
 *
 * Deliberately looser than `runSqlGlobalTableMigrations`, which provisions base
 * tables only for `shardMode.kind === "global"`: a `SchemaLike` caller may
 * legitimately omit `shardMode` altogether, and excluding those would silently
 * stop provisioning companions a table does want. What it DOES exclude is an
 * explicit `root` or `shardBy` table — its rows live in the Durable Objects, so
 * a `__agg_`/`__rank_` table created for it here is an orphan nothing ever
 * writes to and nothing ever reads. Same rule, same reasoning, as
 * `globalSearchIndexes`.
 */
const companionsBelongHere = (definition: SchemaLike["tables"][string]): boolean =>
    definition.shardMode === undefined || definition.shardMode.kind === "global";

/**
 * Materialize the `__agg_<index>` companion tables for every declared
 * `aggregateIndex` on a global table. Global tables in Lunora ship their own
 * DDL — counter tables are opt-in so production hosts can decide where they
 * live. Tests and dev hosts can call this once after their schema migration to
 * unlock O(1) counts.
 *
 * Idempotent (`CREATE TABLE IF NOT EXISTS`).
 */
const runSqlAggregateMigrations = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    const { integer, key, real } = dialect.companionTypes;

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        const indexes = definition.aggregateIndexes;

        if (!indexes || indexes.length === 0 || !companionsBelongHere(definition)) {
            continue;
        }

        for (const index of indexes) {
            const aggTable = aggregateTableName(tableName, index.name);

            // `__value__` is op-aware now (count / running sum / extreme — NULL
            // for an empty min/max group) and `__count__` tracks the row count
            // (avg divisor + empty-group detection). It is nullable; the pre-
            // reducer-aware shape declared it `NOT NULL`.
            // eslint-disable-next-line no-await-in-loop -- DDL statements run sequentially on the single shared connection.
            await queryRun(
                exec,
                dialect,
                sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(aggTable)} (${sql.identifier("__key__")} ${sql.raw(key)} PRIMARY KEY, ${sql.identifier("__value__")} ${sql.raw(real)}, ${sql.identifier("__count__")} ${sql.raw(integer)} NOT NULL DEFAULT 0)`,
            );

            // Alpha-era companion-rebuild caveat (SQLite/D1 only): a binding that
            // materialized this table before `__count__` existed gets the column
            // added here (defaulted 0). `CREATE TABLE IF NOT EXISTS` won't reshape
            // an existing table, so we pragma-check then ALTER. Fresh PG/MySQL
            // tables are created with `__count__` already, so this legacy reshape
            // is skipped off SQLite.
            if (dialect.name === "sqlite") {
                // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection.
                const columns = await queryAll(exec, dialect, sql`PRAGMA table_info(${sql.identifier(aggTable)})`);

                if (!columns.some((column) => column["name"] === "__count__")) {
                    // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection.
                    await queryRun(
                        exec,
                        dialect,
                        sql`ALTER TABLE ${sql.identifier(aggTable)} ADD COLUMN ${sql.identifier("__count__")} ${sql.raw(integer)} NOT NULL DEFAULT 0`,
                    );
                }
            }
        }
    }
};

/**
 * A rank btree index column. MySQL can't index a full VARCHAR(768)/TEXT column in
 * a *composite* index (3072-byte key limit), so VARCHAR/TEXT key columns get a
 * 191-char utf8mb4 prefix (keeps several columns under the cap); SQLite/Postgres
 * — and number/real columns everywhere — index in full.
 */
const rankIndexColumn = (dialect: SqlDialect, column: string, direction: "ASC" | "DESC", needsPrefix: boolean): SQL => {
    const reference = dialect.name === "mysql" && needsPrefix ? sql`${sql.identifier(column)}(191)` : sql`${sql.identifier(column)}`;

    return sql`${reference} ${sql.raw(direction)}`;
};

/** The rank btree key tuple in sort order: `__partition__`, the sort columns, then `__id__` — each prefixed where MySQL's type demands it. */
const rankBtreeColumns = (dialect: SqlDialect, index: RankIndexDefinitionLike, definition: SchemaLike["tables"][string]): SQL[] => {
    // __partition__/__id__ are the VARCHAR(768) `key` type → always prefixed on MySQL.
    const columns: SQL[] = [rankIndexColumn(dialect, "__partition__", "ASC", true)];

    for (const [i, sortKey] of index.sortBy.entries()) {
        const validator = definition.shape[sortKey.field];
        const needsPrefix = validator !== undefined && dialect.indexKeyPrefix?.(effectiveColumnKind(validator)) !== undefined;

        columns.push(rankIndexColumn(dialect, sortColumnName(i), sortKey.direction === "desc" ? "DESC" : "ASC", needsPrefix));
    }

    columns.push(rankIndexColumn(dialect, "__id__", "ASC", true));

    return columns;
};

/** Each rank sort column is typed by its source field's kind (the same type + serialized form the main table uses), so it accepts the stored sort key and orders correctly. A generic BLOB would reject the value on Postgres (BYTEA is strict). */
const rankSortColumnDefs = (dialect: SqlDialect, index: RankIndexDefinitionLike, definition: SchemaLike["tables"][string]): SQL[] =>
    index.sortBy.map((sortKey, i) => {
        const validator = definition.shape[sortKey.field];
        const columnType = dialect.columnType(validator ? effectiveColumnKind(validator) : undefined);

        return sql`${sql.identifier(sortColumnName(i))} ${sql.raw(columnType)}`;
    });

/**
 * Materialize the `__rank_<index>` companion tables for every declared
 * `rankIndex` on a global table. Mirrors `runSqlAggregateMigrations` — same
 * opt-in pattern so production hosts decide whether to spend the DDL.
 *
 * Idempotent (`CREATE TABLE IF NOT EXISTS` + `createIndexIfNotExists`).
 */
const runSqlRankMigrations = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    const { key } = dialect.companionTypes;

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        const indexes = definition.rankIndexes;

        if (!indexes || indexes.length === 0 || !companionsBelongHere(definition)) {
            continue;
        }

        for (const index of indexes) {
            const rankTable = rankTableName(tableName, index.name);
            const sortColumnDefs = rankSortColumnDefs(dialect, index, definition);
            const columnPart = sortColumnDefs.length > 0 ? sql`, ${sql.join(sortColumnDefs, sql`, `)}` : sql``;

            // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection; the table must exist before its index below.
            await queryRun(
                exec,
                dialect,
                sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(rankTable)} (${sql.identifier("__id__")} ${sql.raw(key)} PRIMARY KEY, ${sql.identifier("__partition__")} ${sql.raw(key)} NOT NULL${columnPart})`,
            );

            const orderedColumns = rankBtreeColumns(dialect, index, definition);
            const btreeName = `${tableName}__rank_${index.name}__btree`;

            // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared D1 connection (the CREATE INDEX follows its CREATE TABLE).
            await createIndexIfNotExists(exec, dialect, {
                columns: sql.join(orderedColumns, sql`, `),
                name: btreeName,
                table: rankTable,
                unique: false,
            });
        }
    }
};

export { runSqlAggregateMigrations, runSqlGlobalTableMigrations, runSqlRankMigrations };
