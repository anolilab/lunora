/**
 * DDL for better-auth's tables on a Durable Object's own SQLite.
 *
 * ## Why this is hand-rolled
 *
 * better-auth ships a migrator, but it is kysely-only: `ensureMigrated` drives
 * `getMigrations`, which builds kysely schema statements against a dialect. A
 * Durable Object's `state.storage.sql` is not a kysely dialect, so that path cannot
 * create these tables — yet `lunoraDoAdapter` needs them to exist before
 * better-auth writes a single row.
 *
 * ## Why it stays faithful
 *
 * The schema is derived from better-auth's own resolved-tables helper — the *same*
 * function `getAuthTables` is a one-line wrapper over, and the same one the kysely
 * migrator plans from. So plugin tables, field renames (`fieldName`), and index
 * resolution all come from better-auth rather than being mirrored here, and the
 * column types below match its own SQLite type map arm for arm.
 *
 * The one thing it cannot reuse is the column rendering itself: better-auth's `getType`
 * (its dialect type map) and its `NOT NULL` / `DEFAULT` construction are closures inside
 * `getMigrations`, which also refuses to run for a non-kysely adapter. So that last mile
 * is mirrored here, and `__tests__/do-schema-parity.behaviour.test.ts` diffs it against
 * better-auth's own compiled DDL so drift fails a test rather than reaching a database.
 * Requested upstream as better-auth/better-auth#10559; when a renderer is exported, the
 * mirror below should be deleted in favour of calling it.
 *
 * That matters most for **uniqueness**. better-auth does not express `unique: true`
 * as a column constraint — it emits a separate `CREATE UNIQUE INDEX`. A
 * materialiser that only walks `fields` and writes columns therefore produces
 * tables that *look* right and silently permit duplicate emails, duplicate session
 * tokens, and (with `@better-auth/scim` loaded) duplicate external ids across all
 * twelve of its unique fields. Indexes are not decoration here; they are the
 * constraint.
 */
import { getAuthTablesWithResolvedIndexes, getDatabaseFieldIndexName } from "@better-auth/core/db/internal";

import { quoteIdentifier } from "../../../shared/quote-identifier";
import type { LunoraAuthOptions } from "./create-auth";

/** better-auth's resolved table map, read off the helper rather than re-declared. */
type ResolvedSchema = ReturnType<typeof getAuthTablesWithResolvedIndexes>;

/** One field's attributes, as better-auth resolves them. */
type AuthField = ResolvedSchema["tables"][string]["fields"][string];

/**
 * The SQLite column type for a field, mirroring better-auth's `getType` SQLite arms:
 * `string`/`json`/`string[]`/`number[]`/enum → `text`, `boolean` → `integer`,
 * `number` → `integer` (`bigint` when flagged), `date` → `date`.
 *
 * SQLite applies these as *affinities* rather than constraints, so the value of
 * matching better-auth exactly is not runtime enforcement — it is that a schema
 * later introspected or migrated by better-auth's own tooling compares equal
 * instead of reporting drift on every column.
 */
const columnType = (fieldName: string, field: AuthField): string => {
    // Ids and foreign keys to an id are `text`: Lunora's adapter sets
    // `supportsNumericIds: false`, so better-auth's `serial` id mode never applies.
    if (fieldName === "id" || field.references?.field === "id") {
        return "text";
    }

    const { type } = field;

    // An array of string literals is a better-auth enum, stored as text.
    if (Array.isArray(type)) {
        return "text";
    }

    switch (type) {
        case "boolean": {
            return "integer";
        }
        case "date": {
            return "date";
        }
        case "number": {
            return "bigint" in field && field.bigint === true ? "bigint" : "integer";
        }
        default: {
            return "text";
        }
    }
};

/**
 * Render a static default as a SQLite literal, or `undefined` when the default
 * cannot be expressed in DDL.
 *
 * Mirrors the migrator's guard: only `string` / `number` / `boolean` fields with a
 * non-function, non-nullish `defaultValue` get a DB-level default, and a field that
 * is both `unique` and optional is skipped (backfilling every row with one value
 * would breach its unique index). Booleans render as `1` / `0` for SQLite.
 *
 * Matching this matters: a `required` column whose value better-auth expects the
 * database to supply would otherwise fail its `NOT NULL` on insert.
 */
const defaultLiteral = (field: AuthField): string | undefined => {
    const { defaultValue, type, unique } = field;

    if (unique === true && field.required === false) {
        return undefined;
    }

    if (defaultValue === undefined || defaultValue === null || typeof defaultValue === "function") {
        return undefined;
    }

    if (type === "boolean") {
        return defaultValue === true ? "1" : "0";
    }

    if (type === "number" && typeof defaultValue === "number" && Number.isFinite(defaultValue)) {
        return String(defaultValue);
    }

    if (type === "string" && typeof defaultValue === "string") {
        return `'${defaultValue.replaceAll("'", "''")}'`;
    }

    return undefined;
};

/**
 * The single-column indexes for a table's field-level `unique` / `index` flags.
 *
 * These are NOT part of the resolved index map — that carries only the table's
 * declared (compound) indexes. better-auth's migrator emits one index per flagged
 * field separately, so this must too, or `user.email` and every `unique` SCIM
 * column end up unconstrained.
 */
const fieldIndexStatements = (modelName: string, fields: Record<string, AuthField>): string[] => {
    const statements: string[] = [];

    for (const [key, field] of Object.entries(fields)) {
        const isUnique = field.unique === true;

        if (!isUnique && field.index !== true) {
            continue;
        }

        const column = field.fieldName ?? key;
        const name = getDatabaseFieldIndexName(modelName, column, isUnique);

        statements.push(
            `CREATE ${isUnique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdentifier(name)} ON ${quoteIdentifier(modelName)} (${quoteIdentifier(column)})`,
        );
    }

    return statements;
};

/**
 * The clause for an `ADD COLUMN`, which is narrower than a `CREATE TABLE` column.
 *
 * SQLite refuses `NOT NULL` without a default on `ADD COLUMN` (existing rows would
 * violate it immediately), so the constraint is only emitted when a static default
 * accompanies it.
 */
const addColumnClause = (column: string, field: AuthField): string => {
    const clause = [quoteIdentifier(column), columnType(column, field)];
    const literal = defaultLiteral(field);

    if (field.required !== false && literal !== undefined) {
        clause.push("NOT NULL");
    }

    if (literal !== undefined) {
        clause.push(`DEFAULT ${literal}`);
    }

    return clause.join(" ");
};

/**
 * One column's `"name" type [NOT NULL]` clause, for a fresh `CREATE TABLE`.
 *
 * No `DEFAULT`: better-auth's own fresh-table DDL emits none — it writes every field on
 * insert — so adding one here would be a divergence with nothing to buy. The `ADD
 * COLUMN` path is different, and says why.
 */
const columnClause = (fieldName: string, field: AuthField): string => {
    const clause = [quoteIdentifier(fieldName), columnType(fieldName, field)];

    // better-auth treats `required` as defaulting to true — only an explicit
    // `required: false` makes a column nullable.
    if (field.required !== false) {
        clause.push("NOT NULL");
    }

    return clause.join(" ");
};

/**
 * The `CREATE TABLE` / `CREATE INDEX` statements for a better-auth config, in
 * execution order (every table before any index).
 *
 * All statements are `IF NOT EXISTS`, so this is safe to run on every cold start —
 * which is how `LunoraAuthDO` uses it. It creates; it never alters or drops, so a
 * schema that has already diverged is left alone rather than half-migrated.
 *
 * Physical names throughout: `modelName` for tables, `fieldName ?? key` for columns,
 * and better-auth's own resolved `columns` / `name` for indexes — so an index name
 * here is the name better-auth's introspection expects to find.
 * @param options The better-auth options the DO will run — the plugin list decides which tables exist.
 * @returns SQL statements to execute in order.
 * @experimental
 */
export const authDoSchemaStatements = (options: LunoraAuthOptions): string[] => {
    const { indexesByTable, tables } = getAuthTablesWithResolvedIndexes(options);

    const tableStatements: string[] = [];
    const indexStatements: string[] = [];

    for (const table of Object.values(tables)) {
        // `disableMigrations` marks a table the app owns itself; the kysely migrator
        // skips it, so this does too rather than creating a table better-auth was
        // told not to manage.
        if (table.disableMigrations === true) {
            continue;
        }

        const columns = [
            // `NOT NULL` is load-bearing: unlike `INTEGER PRIMARY KEY` (the rowid
            // alias), a `TEXT PRIMARY KEY` in SQLite still accepts NULL. Upstream emits
            // `"id" text not null primary key`; without this, so would we — minus the
            // constraint.
            `${quoteIdentifier("id")} text NOT NULL PRIMARY KEY`,
            ...Object.entries(table.fields).map(([key, field]) => columnClause(field.fieldName ?? key, field)),
        ];

        tableStatements.push(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.modelName)} (${columns.join(", ")})`);

        indexStatements.push(...fieldIndexStatements(table.modelName, table.fields));

        for (const index of indexesByTable.get(table.modelName) ?? []) {
            const unique = index.unique === true ? "UNIQUE " : "";
            const columnList = index.columns.map((column) => quoteIdentifier(column)).join(", ");

            indexStatements.push(`CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdentifier(index.name)} ON ${quoteIdentifier(table.modelName)} (${columnList})`);
        }
    }

    return [...tableStatements, ...indexStatements];
};

/**
 * `ALTER TABLE … ADD COLUMN` statements for columns the live schema is missing.
 *
 * ## Why this is needed at all
 *
 * {@link authDoSchemaStatements} is entirely `IF NOT EXISTS`, which makes it safe to
 * re-run but blind to change: a *new table* appears on the next cold start, a *new
 * column on an existing table* never does. That is not a hypothetical — enabling the
 * `admin` plugin after first deploy adds `role` / `banned` / `banExpires` to `user`,
 * and without this the object would keep serving a `user` table that cannot hold them.
 *
 * Additive only. Nothing here drops, renames, or retypes a column: a column that
 * exists is left exactly as it is, so a schema someone has deliberately diverged is
 * never "corrected" underneath them.
 *
 * ## What SQLite will not let us do
 *
 * `ADD COLUMN` cannot introduce a `NOT NULL` column without a default (existing rows
 * would violate it immediately), and cannot introduce `UNIQUE`. So a required column
 * with a static default is added with both; a required column *without* one is added
 * **nullable**, which differs from what a fresh `CREATE TABLE` would produce. That is
 * the deliberate trade: better-auth writes these fields on every insert, so nullable
 * is harmless, whereas refusing to add the column at all would leave the object
 * broken. Uniqueness is unaffected — better-auth expresses it as a separate index, and
 * those are `IF NOT EXISTS`, so they are created by the statements above.
 * @param options The better-auth options the DO runs, already resolved.
 * @param existingColumns Physical column names currently present on a table; empty/absent for a table that does not exist yet (it will be created instead).
 * @returns SQL statements to execute in order; empty when the live schema is current.
 * @experimental
 */
export const authDoColumnAdditions = (options: LunoraAuthOptions, existingColumns: (table: string) => Iterable<string>): string[] => {
    const { tables } = getAuthTablesWithResolvedIndexes(options);
    const statements: string[] = [];

    for (const table of Object.values(tables)) {
        if (table.disableMigrations === true) {
            continue;
        }

        const present = new Set(existingColumns(table.modelName));

        // No columns reported means the table is absent — `CREATE TABLE IF NOT EXISTS`
        // handles that case, and emitting ALTERs against a missing table would throw.
        if (present.size === 0) {
            continue;
        }

        for (const [key, field] of Object.entries(table.fields)) {
            const column = field.fieldName ?? key;

            if (!present.has(column)) {
                statements.push(`ALTER TABLE ${quoteIdentifier(table.modelName)} ADD COLUMN ${addColumnClause(column, field)}`);
            }
        }
    }

    return statements;
};
