/**
 * Read an existing Postgres/MySQL database's shape out of `information_schema`
 * (plus `pg_index` on Postgres, which is the only place index columns are
 * reliably available in order).
 *
 * Query execution sits behind {@link SqlExecutor} so the assembly logic — which
 * is where the fiddly part actually lives — is testable without a live database.
 * Everything here is read-only: introspection never writes to the source.
 */
import type { IntrospectedColumn, IntrospectedDatabase, IntrospectedIndex, IntrospectedTable, SqlDialect } from "./model";

/** Runs one parameterized query and returns its rows. Placeholders are dialect-native (`$1` / `?`). */
type SqlExecutor = (sql: string, parameters: ReadonlyArray<unknown>) => Promise<ReadonlyArray<Record<string, unknown>>>;

/**
 * Read a column off a driver row, tolerating the case differences between
 * drivers (`pg` lower-cases, `mysql2` preserves the `information_schema`
 * spelling). Scalars are coerced to their string form; anything structural (a
 * driver returning a Buffer or a row object) reads as `""` rather than
 * `"[object Object]"`, so a surprising driver shape degrades to "absent".
 */
const field = (row: Record<string, unknown>, name: string): string => {
    const value = row[name] ?? row[name.toLowerCase()] ?? row[name.toUpperCase()];

    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
        return String(value);
    }

    return "";
};

const POSTGRES_COLUMNS = `
    SELECT c.table_name, c.column_name, c.is_nullable, c.data_type, c.udt_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.ordinal_position`;

const POSTGRES_PRIMARY_KEYS = `
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    WHERE tc.table_schema = $1 AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY tc.table_name, kcu.ordinal_position`;

const POSTGRES_FOREIGN_KEYS = `
    SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.table_schema = $1 AND tc.constraint_type = 'FOREIGN KEY'`;

// `pg_index.indkey` is an ordered attribute-number vector; unnesting it WITH
// ORDINALITY is the only way to recover multi-column index order faithfully.
const POSTGRES_INDEXES = `
    SELECT t.relname AS table_name, i.relname AS index_name, ix.indisunique AS is_unique, a.attname AS column_name
    FROM pg_class t
    JOIN pg_index ix ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE n.nspname = $1 AND t.relkind = 'r' AND NOT ix.indisprimary
    ORDER BY t.relname, i.relname, k.ord`;

// eslint-disable-next-line no-secrets/no-secrets -- `information_schema.*` table names, not a credential
const MYSQL_COLUMNS = `
    SELECT c.TABLE_NAME, c.COLUMN_NAME, c.IS_NULLABLE, c.DATA_TYPE
    FROM information_schema.COLUMNS c
    JOIN information_schema.TABLES t
      ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
    WHERE c.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'
    ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`;

// eslint-disable-next-line no-secrets/no-secrets -- `information_schema.*` table names, not a credential
const MYSQL_PRIMARY_KEYS = `
    SELECT TABLE_NAME, COLUMN_NAME
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = ? AND CONSTRAINT_NAME = 'PRIMARY'
    ORDER BY TABLE_NAME, ORDINAL_POSITION`;

// eslint-disable-next-line no-secrets/no-secrets -- `information_schema.*` table names, not a credential
const MYSQL_FOREIGN_KEYS = `
    SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME AS foreign_table, REFERENCED_COLUMN_NAME AS foreign_column
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`;

const MYSQL_INDEXES = `
    SELECT TABLE_NAME, INDEX_NAME AS index_name, NON_UNIQUE, COLUMN_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ? AND INDEX_NAME <> 'PRIMARY'
    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;

/** Group rows by their table name, preserving row order within each group. */
const groupByTable = (rows: ReadonlyArray<Record<string, unknown>>): Map<string, Record<string, unknown>[]> => {
    const grouped = new Map<string, Record<string, unknown>[]>();

    for (const row of rows) {
        const table = field(row, "table_name");
        const bucket = grouped.get(table);

        if (bucket === undefined) {
            grouped.set(table, [row]);
        } else {
            bucket.push(row);
        }
    }

    return grouped;
};

/**
 * Resolve a column's native type name and array depth. Postgres reports an array
 * as `data_type = 'ARRAY'` with the element type hidden in `udt_name` behind a
 * leading underscore (`_text`); MySQL has no array types.
 */
const resolveType = (row: Record<string, unknown>, dialect: SqlDialect): { arrayDepth: number; dataType: string } => {
    const dataType = field(row, "data_type").toLowerCase();

    if (dialect !== "postgres") {
        return { arrayDepth: 0, dataType };
    }

    const udt = field(row, "udt_name").toLowerCase();

    if (dataType === "array" && udt.startsWith("_")) {
        return { arrayDepth: 1, dataType: udt.slice(1) };
    }

    // `udt_name` is the more specific spelling (`int4` vs `integer`) and is what
    // the type table is keyed on first, so prefer it when it maps.
    return { arrayDepth: 0, dataType: udt === "" ? dataType : udt };
};

/** Assemble the index list for one table from its (already table-scoped) rows. */
const assembleIndexes = (rows: ReadonlyArray<Record<string, unknown>>, dialect: SqlDialect): IntrospectedIndex[] => {
    const byName = new Map<string, { columns: string[]; unique: boolean }>();

    for (const row of rows) {
        const name = field(row, "index_name");
        const unique = dialect === "postgres" ? field(row, "is_unique") === "true" : field(row, "NON_UNIQUE") === "0";
        const existing = byName.get(name);

        if (existing === undefined) {
            byName.set(name, { columns: [field(row, "column_name")], unique });
        } else {
            existing.columns.push(field(row, "column_name"));
        }
    }

    return [...byName.entries()].map(([name, index]) => {
        return { columns: index.columns, name, unique: index.unique };
    });
};

/**
 * Run the four introspection queries and fold them into the dialect-neutral
 * model. `schema` is the Postgres schema name (usually `public`) or the MySQL
 * database name.
 */
const readDatabase = async (execute: SqlExecutor, dialect: SqlDialect, schema: string): Promise<IntrospectedDatabase> => {
    const postgres = dialect === "postgres";
    const [columnRows, primaryKeyRows, foreignKeyRows, indexRows] = await Promise.all([
        execute(postgres ? POSTGRES_COLUMNS : MYSQL_COLUMNS, [schema]),
        execute(postgres ? POSTGRES_PRIMARY_KEYS : MYSQL_PRIMARY_KEYS, [schema]),
        execute(postgres ? POSTGRES_FOREIGN_KEYS : MYSQL_FOREIGN_KEYS, [schema]),
        execute(postgres ? POSTGRES_INDEXES : MYSQL_INDEXES, [schema]),
    ]);

    const primaryKeys = groupByTable(primaryKeyRows);
    const foreignKeys = groupByTable(foreignKeyRows);
    const indexes = groupByTable(indexRows);

    const tables: IntrospectedTable[] = [];

    for (const [name, rows] of groupByTable(columnRows)) {
        const references = new Map(
            (foreignKeys.get(name) ?? []).map((row) => [
                field(row, "column_name"),
                { column: field(row, "foreign_column"), table: field(row, "foreign_table") },
            ]),
        );

        const columns: IntrospectedColumn[] = rows.map((row) => {
            const columnName = field(row, "column_name");
            const reference = references.get(columnName);

            return {
                ...resolveType(row, dialect),
                name: columnName,
                nullable: field(row, "is_nullable").toUpperCase() === "YES",
                ...(reference === undefined ? {} : { references: reference }),
            };
        });

        tables.push({
            columns,
            indexes: assembleIndexes(indexes.get(name) ?? [], dialect),
            name,
            primaryKey: (primaryKeys.get(name) ?? []).map((row) => field(row, "column_name")),
        });
    }

    tables.sort((a, b) => a.name.localeCompare(b.name));

    return { dialect, tables };
};

export type { SqlExecutor };
export { assembleIndexes, groupByTable, readDatabase, resolveType };
