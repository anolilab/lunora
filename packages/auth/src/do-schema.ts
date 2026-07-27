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
 * That matters most for **uniqueness**. better-auth does not express `unique: true`
 * as a column constraint — it emits a separate `CREATE UNIQUE INDEX`. A
 * materialiser that only walks `fields` and writes columns therefore produces
 * tables that *look* right and silently permit duplicate emails, duplicate session
 * tokens, and (with `@better-auth/scim` loaded) duplicate external ids across all
 * twelve of its unique fields. Indexes are not decoration here; they are the
 * constraint.
 */
import { getAuthTablesWithResolvedIndexes, getDatabaseFieldIndexName } from "@better-auth/core/db/internal";

import type { LunoraAuthOptions } from "./create-auth";

/** better-auth's resolved table map, read off the helper rather than re-declared. */
type ResolvedSchema = ReturnType<typeof getAuthTablesWithResolvedIndexes>;

/** One field's attributes, as better-auth resolves them. */
type AuthField = ResolvedSchema["tables"][string]["fields"][string];

/** Quote a SQLite identifier, escaping any embedded double quote. */
const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll(`"`, `""`)}"`;

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

/** One column's `"name" type [NOT NULL] [DEFAULT …]` clause. */
const columnClause = (fieldName: string, field: AuthField): string => {
    const clause = [quoteIdentifier(fieldName), columnType(fieldName, field)];

    // better-auth treats `required` as defaulting to true — only an explicit
    // `required: false` makes a column nullable.
    if (field.required !== false) {
        clause.push("NOT NULL");
    }

    const literal = defaultLiteral(field);

    if (literal !== undefined) {
        clause.push(`DEFAULT ${literal}`);
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
const authDoSchemaStatements = (options: LunoraAuthOptions): string[] => {
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
            `${quoteIdentifier("id")} text PRIMARY KEY`,
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

export default authDoSchemaStatements;
