/**
 * Pure-logic diffing for `cirrus migrate generate`.
 *
 * Given two `SchemaSnapshot`s (the previous one persisted at
 * `cirrus/migrations/.snapshot.json`, and the current one parsed live from
 * `cirrus/schema.ts`), compute the SQL needed to bring D1 from the previous
 * shape to the new one.
 *
 * Only **global** tables go through here — sharded / root tables live in
 * per-DO SQLite and don't need a migration runner.
 *
 * Supported diffs in v0.1:
 *   - CREATE TABLE (new table appears)
 *   - DROP TABLE (table removed)
 *   - ALTER TABLE … ADD COLUMN (column added)
 *   - CREATE INDEX (index added)
 *   - DROP INDEX (index removed)
 *
 * Explicitly unsupported in v0.1 (documented as v0.2):
 *   - column rename
 *   - column type change
 *   - column removal (SQLite has no DROP COLUMN before 3.35; even with it, we'd
 *     rather make the user opt in explicitly because it's destructive)
 *   - index rename
 *
 * Any unsupported delta is surfaced via {@link SchemaDiff.unsupported} so the
 * caller can write a comment block into the migration file.
 */

/** Compact snapshot of a single global table — what we persist + diff. */
export interface TableSnapshot {
    columns: Record<string, ColumnSnapshot>;
    indexes: Record<string, IndexSnapshot>;
    /** Table name (also the JSON key — duplicated for ease of iteration). */
    name: string;
}

export interface ColumnSnapshot {
    /** SQLite type affinity, derived from the validator. */
    sqlType: "BLOB" | "INTEGER" | "REAL" | "TEXT";
    /** True when the column accepts NULL (validator wrapped in v.optional). */
    nullable: boolean;
}

export interface IndexSnapshot {
    fields: ReadonlyArray<string>;
    name: string;
    unique: boolean;
}

export interface SchemaSnapshot {
    tables: Record<string, TableSnapshot>;
    version: 1;
}

export interface DiffEntry {
    kind: "addColumn" | "createIndex" | "createTable" | "dropIndex" | "dropTable";
    /** Human-readable summary, used in migration headers. */
    summary: string;
    /** Generated SQL for this delta (already terminated with `;`). */
    sql: string;
}

export interface UnsupportedEntry {
    kind: "columnTypeChange" | "dropColumn" | "indexRename" | "renameColumn";
    /** Human-readable description, embedded as SQL comments. */
    summary: string;
}

export interface SchemaDiff {
    /** No-op marker — true when there is genuinely nothing to apply. */
    empty: boolean;
    entries: ReadonlyArray<DiffEntry>;
    unsupported: ReadonlyArray<UnsupportedEntry>;
}

/** Map a Cirrus validator kind to a SQLite type affinity. */
export const validatorKindToSqlType = (kind: string): ColumnSnapshot["sqlType"] => {
    switch (kind) {
        case "bigint":
        case "boolean":
        case "number": {
            return "INTEGER";
        }
        case "bytes": {
            return "BLOB";
        }
        case "id":
        case "literal":
        case "string": {
            return "TEXT";
        }
        // Default: store as TEXT (JSON-encoded) — matches how `@cirrus/d1`
        // round-trips object/array/union values today.
        default: {
            return "TEXT";
        }
    }
};

const escapeIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const renderColumnDefinition = (name: string, column: ColumnSnapshot): string => {
    const parts = [escapeIdentifier(name), column.sqlType];

    if (!column.nullable) {
        parts.push("NOT NULL");
    }

    return parts.join(" ");
};

/** Emit `CREATE TABLE` SQL for a new global table. */
export const renderCreateTable = (table: TableSnapshot): string => {
    const id = `${escapeIdentifier("_id")} TEXT PRIMARY KEY`;
    const columns = Object.entries(table.columns)
        .map(([columnName, column]) => `    ${renderColumnDefinition(columnName, column)}`)
        .join(",\n");

    return `CREATE TABLE IF NOT EXISTS ${escapeIdentifier(table.name)} (\n    ${id}${columns.length > 0 ? `,\n${columns}` : ""}\n);`;
};

export const renderDropTable = (tableName: string): string => `DROP TABLE IF EXISTS ${escapeIdentifier(tableName)};`;

export const renderAddColumn = (tableName: string, columnName: string, column: ColumnSnapshot): string =>
    `ALTER TABLE ${escapeIdentifier(tableName)} ADD COLUMN ${renderColumnDefinition(columnName, column)};`;

export const renderCreateIndex = (tableName: string, index: IndexSnapshot): string => {
    const fields = index.fields.map((field) => escapeIdentifier(field)).join(", ");
    const uniqueClause = index.unique ? "UNIQUE " : "";

    return `CREATE ${uniqueClause}INDEX IF NOT EXISTS ${escapeIdentifier(index.name)} ON ${escapeIdentifier(tableName)} (${fields});`;
};

export const renderDropIndex = (indexName: string): string => `DROP INDEX IF EXISTS ${escapeIdentifier(indexName)};`;

const diffColumns = (
    tableName: string,
    previous: Record<string, ColumnSnapshot>,
    next: Record<string, ColumnSnapshot>,
    entries: DiffEntry[],
    unsupported: UnsupportedEntry[],
): void => {
    for (const [columnName, column] of Object.entries(next)) {
        const old = previous[columnName];

        if (old === undefined) {
            entries.push({
                kind: "addColumn",
                summary: `ADD COLUMN ${tableName}.${columnName}`,
                sql: renderAddColumn(tableName, columnName, column),
            });

            continue;
        }

        if (old.sqlType !== column.sqlType) {
            unsupported.push({
                kind: "columnTypeChange",
                summary: `column type change on ${tableName}.${columnName}: ${old.sqlType} → ${column.sqlType} (write SQL manually)`,
            });
        }

        if (old.nullable !== column.nullable) {
            unsupported.push({
                kind: "columnTypeChange",
                summary: `nullability change on ${tableName}.${columnName}: ${
                    old.nullable ? "NULL" : "NOT NULL"
                } → ${column.nullable ? "NULL" : "NOT NULL"} (write SQL manually)`,
            });
        }
    }

    for (const columnName of Object.keys(previous)) {
        if (next[columnName] === undefined) {
            unsupported.push({
                kind: "dropColumn",
                summary: `DROP COLUMN ${tableName}.${columnName} (SQLite drop-column requires careful migration — write SQL manually)`,
            });
        }
    }
};

const diffIndexes = (
    tableName: string,
    previous: Record<string, IndexSnapshot>,
    next: Record<string, IndexSnapshot>,
    entries: DiffEntry[],
    unsupported: UnsupportedEntry[],
): void => {
    for (const [indexName, index] of Object.entries(next)) {
        const old = previous[indexName];

        if (old === undefined) {
            entries.push({
                kind: "createIndex",
                summary: `CREATE INDEX ${indexName} ON ${tableName}`,
                sql: renderCreateIndex(tableName, index),
            });

            continue;
        }

        // Compare structurally — fields are an ordered tuple, unique is a flag.
        const fieldsEqual = old.fields.length === index.fields.length && old.fields.every((field, i) => field === index.fields[i]);

        if (!fieldsEqual || old.unique !== index.unique) {
            // Renaming indexes / changing their fields means drop+create. We
            // emit that pair when only the unique flag flips or fields shift,
            // but we surface it through unsupported so the user can review.
            unsupported.push({
                kind: "indexRename",
                summary: `index ${indexName} changed on ${tableName} — drop+create manually if intentional`,
            });
        }
    }

    for (const indexName of Object.keys(previous)) {
        if (next[indexName] === undefined) {
            entries.push({
                kind: "dropIndex",
                summary: `DROP INDEX ${indexName}`,
                sql: renderDropIndex(indexName),
            });
        }
    }
};

/**
 * Compute a {@link SchemaDiff} from two snapshots. Pure function — no I/O.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
export const diffSnapshots = (previous: SchemaSnapshot | undefined, next: SchemaSnapshot): SchemaDiff => {
    const previousTables = previous?.tables ?? {};
    const entries: DiffEntry[] = [];
    const unsupported: UnsupportedEntry[] = [];

    // Tables added or compared in detail.
    for (const [tableName, table] of Object.entries(next.tables)) {
        const old = previousTables[tableName];

        if (old === undefined) {
            entries.push({
                kind: "createTable",
                summary: `CREATE TABLE ${tableName}`,
                sql: renderCreateTable(table),
            });

            for (const index of Object.values(table.indexes)) {
                entries.push({
                    kind: "createIndex",
                    summary: `CREATE INDEX ${index.name} ON ${tableName}`,
                    sql: renderCreateIndex(tableName, index),
                });
            }

            continue;
        }

        diffColumns(tableName, old.columns, table.columns, entries, unsupported);
        diffIndexes(tableName, old.indexes, table.indexes, entries, unsupported);
    }

    // Tables removed.
    for (const [tableName] of Object.entries(previousTables)) {
        if (next.tables[tableName] === undefined) {
            entries.push({
                kind: "dropTable",
                summary: `DROP TABLE ${tableName}`,
                sql: renderDropTable(tableName),
            });
        }
    }

    return {
        empty: entries.length === 0 && unsupported.length === 0,
        entries,
        unsupported,
    };
};

/**
 * Render a complete migration file body from a diff. Includes a header,
 * each SQL statement, and (if any) a trailing comment block describing the
 * manual SQL the user needs to fill in for unsupported deltas.
 */
export const renderMigrationFile = (name: string, diff: SchemaDiff, generatedAt: string): string => {
    const lines: string[] = [
        `-- Cirrus migration: ${name}`,
        `-- Generated at ${generatedAt}`,
        "-- This file was produced by `cirrus migrate generate`. Review carefully before applying.",
        "",
    ];

    for (const entry of diff.entries) {
        lines.push(`-- ${entry.summary}`);
        lines.push(entry.sql);
        lines.push("");
    }

    if (diff.unsupported.length > 0) {
        lines.push("-- ---------------------------------------------------------------");
        lines.push("-- The following deltas are NOT auto-generated in v0.1.");
        lines.push("-- Write the appropriate SQL below by hand:");
        lines.push("--");

        for (const entry of diff.unsupported) {
            lines.push(`--   * ${entry.summary}`);
        }

        lines.push("-- ---------------------------------------------------------------");
        lines.push("");
    }

    if (diff.empty) {
        lines.push("-- No changes detected. Re-running `cirrus migrate generate` will overwrite this file.");
        lines.push("");
    }

    return lines.join("\n");
};
