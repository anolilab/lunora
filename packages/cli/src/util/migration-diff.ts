/**
 * Pure-logic diffing for `lunora migrate generate`.
 *
 * Given two `SchemaSnapshot`s (the previous one persisted at
 * `lunora/migrations/.snapshot.json`, and the current one parsed live from
 * `lunora/schema.ts`), compute the SQL needed to bring D1 from the previous
 * shape to the new one.
 *
 * Only **global** tables go through here — sharded / root tables live in
 * per-DO SQLite and don't need a migration runner.
 *
 * Supported diffs in v0.1: CREATE TABLE (new table appears), DROP TABLE (table
 * removed), ALTER TABLE … ADD COLUMN (column added), CREATE INDEX (index added),
 * and DROP INDEX (index removed).
 *
 * Explicitly unsupported in v0.1 (documented as v0.2): column rename, column
 * type change, column removal (SQLite has no DROP COLUMN before 3.35; even with
 * it, we'd rather make the user opt in explicitly because it's destructive),
 * and index rename.
 *
 * Any unsupported delta is surfaced via {@link SchemaDiff.unsupported} so the
 * caller can write a comment block into the migration file.
 *
 * The physical D1 dialect (column affinities, framework columns, index naming,
 * identifier quoting) is NOT re-derived here — it's imported from the canonical
 * `@lunora/d1/dialect`, the same source the runtime's `runD1GlobalTableMigrations`
 * uses, so a generated migration is byte-identical to what the runtime would
 * auto-provision.
 */
import { columnRef, frameworkColumnDdl, physicalIndexName, quoteIdentifier, sqlAffinityForKind } from "@lunora/d1/dialect";

/** Compact snapshot of a single global table — what we persist + diff. */
interface TableSnapshot {
    columns: Record<string, ColumnSnapshot>;
    indexes: Record<string, IndexSnapshot>;
    /** Table name (also the JSON key — duplicated for ease of iteration). */
    name: string;
}

interface ColumnSnapshot {
    /** True when the column accepts NULL (validator wrapped in v.optional). */
    nullable: boolean;
    /** SQLite type affinity, derived from the validator. */
    sqlType: "BLOB" | "INTEGER" | "REAL" | "TEXT";
}

interface IndexSnapshot {
    fields: ReadonlyArray<string>;
    name: string;
    unique: boolean;
}

interface SchemaSnapshot {
    tables: Record<string, TableSnapshot>;
    version: 1;
}

interface DiffEntry {
    kind: "addColumn" | "createIndex" | "createTable" | "dropIndex" | "dropTable";
    /** Generated SQL for this delta (already terminated with `;`). */
    sql: string;
    /** Human-readable summary, used in migration headers. */
    summary: string;
}

interface UnsupportedEntry {
    kind: "columnTypeChange" | "dropColumn" | "indexRename" | "renameColumn";
    /** Human-readable description, embedded as SQL comments. */
    summary: string;
}

interface SchemaDiff {
    /** No-op marker — true when there is genuinely nothing to apply. */
    empty: boolean;
    entries: ReadonlyArray<DiffEntry>;
    unsupported: ReadonlyArray<UnsupportedEntry>;
}

/**
 * Map a Lunora validator kind to a SQLite type affinity — the canonical
 * `@lunora/d1/dialect` mapping. Re-exported under this name because
 * `schema-snapshot.ts` builds the persisted snapshot from it.
 */
const validatorKindToSqlType = (kind: string): ColumnSnapshot["sqlType"] => sqlAffinityForKind(kind);

const renderColumnDefinition = (name: string, column: ColumnSnapshot): string => {
    const parts = [quoteIdentifier(name), column.sqlType];

    if (!column.nullable) {
        parts.push("NOT NULL");
    }

    return parts.join(" ");
};

/** Emit `CREATE TABLE` SQL for a new global table. */
const renderCreateTable = (table: TableSnapshot): string => {
    const columns = Object.entries(table.columns).map(([columnName, column]) => `    ${renderColumnDefinition(columnName, column)}`);
    const lines = [...frameworkColumnDdl().map((column) => `    ${column}`), ...columns].join(",\n");

    return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.name)} (\n${lines}\n);`;
};

const renderDropTable = (tableName: string): string => `DROP TABLE IF EXISTS ${quoteIdentifier(tableName)};`;

const renderAddColumn = (tableName: string, columnName: string, column: ColumnSnapshot): string =>
    `ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${renderColumnDefinition(columnName, column)};`;

const renderCreateIndex = (tableName: string, index: IndexSnapshot): string => {
    const fields = index.fields.map((field) => columnRef(field)).join(", ");
    const uniqueClause = index.unique ? "UNIQUE " : "";

    return `CREATE ${uniqueClause}INDEX IF NOT EXISTS ${physicalIndexName(tableName, index.name)} ON ${quoteIdentifier(tableName)} (${fields});`;
};

const renderDropIndex = (tableName: string, indexName: string): string => `DROP INDEX IF EXISTS ${physicalIndexName(tableName, indexName)};`;

/** Surface type/nullability changes on an existing column as unsupported deltas. */
const diffExistingColumn = (tableName: string, columnName: string, old: ColumnSnapshot, column: ColumnSnapshot, unsupported: UnsupportedEntry[]): void => {
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
};

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
                sql: renderAddColumn(tableName, columnName, column),
                summary: `ADD COLUMN ${tableName}.${columnName}`,
            });

            continue;
        }

        diffExistingColumn(tableName, columnName, old, column, unsupported);
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
                sql: renderCreateIndex(tableName, index),
                summary: `CREATE INDEX ${indexName} ON ${tableName}`,
            });

            continue;
        }

        // Compare structurally — fields are an ordered tuple, unique is a flag.
        const fieldsEqual = old.fields.length === index.fields.length && old.fields.every((field, i) => field === index.fields[i]);

        if (!fieldsEqual || old.unique !== index.unique) {
            // Renaming an index / changing its fields or unique flag would mean
            // a drop+create, but we do NOT emit that SQL automatically: index
            // changes are surfaced through `unsupported` so the user reviews and
            // writes the drop+create by hand (avoids silently rebuilding an
            // index — potentially expensive or lock-heavy — under their feet).
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
                sql: renderDropIndex(tableName, indexName),
                summary: `DROP INDEX ${indexName}`,
            });
        }
    }
};

/** Emit CREATE TABLE + CREATE INDEX entries for a brand-new global table. */
const diffNewTable = (tableName: string, table: TableSnapshot, entries: DiffEntry[]): void => {
    entries.push({
        kind: "createTable",
        sql: renderCreateTable(table),
        summary: `CREATE TABLE ${tableName}`,
    });

    for (const index of Object.values(table.indexes)) {
        entries.push({
            kind: "createIndex",
            sql: renderCreateIndex(tableName, index),
            summary: `CREATE INDEX ${index.name} ON ${tableName}`,
        });
    }
};

/**
 * Compute a {@link SchemaDiff} from two snapshots. Pure function — no I/O.
 */

const diffSnapshots = (previous: SchemaSnapshot | undefined, next: SchemaSnapshot): SchemaDiff => {
    const previousTables = previous?.tables ?? {};
    const entries: DiffEntry[] = [];
    const unsupported: UnsupportedEntry[] = [];

    // Tables added or compared in detail.
    for (const [tableName, table] of Object.entries(next.tables)) {
        const old = previousTables[tableName];

        if (old === undefined) {
            diffNewTable(tableName, table, entries);

            continue;
        }

        diffColumns(tableName, old.columns, table.columns, entries, unsupported);
        diffIndexes(tableName, old.indexes, table.indexes, entries, unsupported);
    }

    // Tables removed.
    for (const tableName of Object.keys(previousTables)) {
        if (next.tables[tableName] === undefined) {
            entries.push({
                kind: "dropTable",
                sql: renderDropTable(tableName),
                summary: `DROP TABLE ${tableName}`,
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
const renderMigrationFile = (name: string, diff: SchemaDiff, generatedAt: string): string => {
    const lines: string[] = [
        `-- Lunora migration: ${name}`,
        `-- Generated at ${generatedAt}`,
        "-- This file was produced by `lunora migrate generate`. Review carefully before applying.",
        "",
    ];

    for (const entry of diff.entries) {
        lines.push(`-- ${entry.summary}`, entry.sql, "");
    }

    if (diff.unsupported.length > 0) {
        lines.push(
            "-- ---------------------------------------------------------------",
            "-- The following deltas are NOT auto-generated in v0.1.",
            "-- Write the appropriate SQL below by hand:",
            "--",
        );

        for (const entry of diff.unsupported) {
            lines.push(`--   * ${entry.summary}`);
        }

        lines.push("-- ---------------------------------------------------------------", "");
    }

    if (diff.empty) {
        lines.push("-- No changes detected. Re-running `lunora migrate generate` will overwrite this file.", "");
    }

    return lines.join("\n");
};

export type { ColumnSnapshot, DiffEntry, IndexSnapshot, SchemaDiff, SchemaSnapshot, TableSnapshot, UnsupportedEntry };
export { diffSnapshots, renderAddColumn, renderCreateIndex, renderCreateTable, renderDropIndex, renderDropTable, renderMigrationFile, validatorKindToSqlType };
