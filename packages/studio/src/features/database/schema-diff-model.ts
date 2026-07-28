/**
 * Turn two schema snapshots into something the diagram can render — pure, so
 * the status classification is unit-testable without React Flow or a DOM.
 *
 * The classification itself comes from `shared/schema-snapshot.ts`'s
 * `diffSchemaSnapshots`, the SAME function `lunora deploy`'s drift gate blocks
 * on. That is the whole point of the extraction: this view cannot tell the
 * operator a change is safe while the gate refuses to ship it.
 */
import type { DriftChange, SchemaSnapshot, TableSnapshot } from "../../../../../shared/schema-snapshot";
import { diffSchemaSnapshots, parseSnapshotJson } from "../../../../../shared/schema-snapshot";
import type { ColumnMeta } from "../../lib/admin";

/** How a table fared between two versions. */
type TableStatus = "added" | "changed" | "context" | "removed";

/** How one field fared, for the `+` / `−` / `~` glyph on its row. */
type FieldStatus = "added" | "changed" | "removed" | "unchanged";

/** One table as the diff canvas renders it. */
interface DiffTable {
    /** Columns of the version the table exists in (destination for added/changed, origin for removed). */
    readonly columns: ReadonlyArray<ColumnMeta>;
    /** Per-field status, keyed by field name — drives the row glyphs. */
    readonly fieldStatus: Readonly<Record<string, FieldStatus>>;
    readonly name: string;
    /** `"global"` tables live in D1, everything else in the shard's SQLite. */
    readonly shardMode: string;
    readonly status: TableStatus;
}

/** The whole rendered diff. */
interface SchemaDiffModel {
    /** How many changes are `breaking` — the same count the deploy gate blocks on. */
    readonly breakingCount: number;
    /** Every classified change, verbatim from the shared diff engine. */
    readonly changes: ReadonlyArray<DriftChange>;
    readonly tables: ReadonlyArray<DiffTable>;
}

/** Render a snapshot's fields as the `ColumnMeta` shape the existing diagram node consumes. */
const columnsOf = (table: TableSnapshot): ColumnMeta[] =>
    Object.entries(table.fields).map(([name, field]) => {
        return {
            name,
            optional: field.optional,
            // A relation is keyed by its ACCESSOR name but carries the foreign-key
            // field it reads, so match on `field` — keying on the accessor would
            // silently drop every FK arrow whose accessor differs from its column.
            ref: Object.values(table.relations).find((relation) => relation.field === name && relation.kind === "one")?.table,
            type: field.kind,
        };
    });

/**
 * Per-field status for one table, derived by comparing the two field maps
 * directly rather than parsing `DriftChange.summary` — the summaries are
 * operator prose and must stay free to change wording.
 */
const fieldStatusOf = (before: TableSnapshot | undefined, after: TableSnapshot | undefined): Record<string, FieldStatus> => {
    const status: Record<string, FieldStatus> = {};
    const beforeFields = before?.fields ?? {};
    const afterFields = after?.fields ?? {};

    for (const [name, field] of Object.entries(afterFields)) {
        const old = beforeFields[name];

        if (old === undefined) {
            status[name] = before === undefined ? "unchanged" : "added";
        } else {
            status[name] = old.kind === field.kind && old.optional === field.optional ? "unchanged" : "changed";
        }
    }

    for (const name of Object.keys(beforeFields)) {
        if (afterFields[name] === undefined) {
            status[name] = "removed";
        }
    }

    return status;
};

/**
 * Build the render model for the transition `before → after`.
 *
 * `before` is `undefined` for the very first recorded version, in which case
 * every table reads as `added` — which is exactly what happened.
 *
 * A table's status is **table-anchored**: only its own field / index / shard-mode
 * changes mark it `changed`. A relation-only change (the foreign key lives on
 * the other table) leaves it `context`, so the amber signal stays synonymous
 * with "this table's shape moved" instead of bleeding across every neighbor.
 */
const buildSchemaDiffModel = (before: SchemaSnapshot | undefined, after: SchemaSnapshot): SchemaDiffModel => {
    const { changes } = diffSchemaSnapshots(before, after);
    // `scope` is stamped by the diff engine itself (`shared/schema-snapshot.ts`),
    // so a new change variant cannot silently render an affected table as
    // untouched — which is what a set of type names maintained over here would do.
    const changedTables = new Set(changes.filter((change) => change.scope === "table" && change.table !== undefined).map((change) => change.table));

    const tables: DiffTable[] = [];

    const statusOf = (isNew: boolean, name: string): TableStatus => {
        if (isNew) {
            return "added";
        }

        return changedTables.has(name) ? "changed" : "context";
    };

    for (const [name, table] of Object.entries(after.tables)) {
        const old = before?.tables[name];
        const status = statusOf(old === undefined, name);

        tables.push({ columns: columnsOf(table), fieldStatus: fieldStatusOf(old, table), name, shardMode: table.shardMode, status });
    }

    // Removed tables have no "after" shape, so they render from their last known
    // one — otherwise the most consequential change in a migration would be the
    // one thing the canvas cannot show.
    for (const [name, table] of Object.entries(before?.tables ?? {})) {
        if (after.tables[name] === undefined) {
            tables.push({ columns: columnsOf(table), fieldStatus: fieldStatusOf(table, undefined), name, shardMode: table.shardMode, status: "removed" });
        }
    }

    tables.sort((a, b) => a.name.localeCompare(b.name));

    return { breakingCount: changes.filter((change) => change.severity === "breaking").length, changes, tables };
};

/** Parse a ledger row's stored snapshot JSON, or `undefined` when it is absent/corrupt. */
const snapshotFromJson = (json: string | undefined): SchemaSnapshot | undefined => parseSnapshotJson(json).snapshot;

export { buildSchemaDiffModel, snapshotFromJson };
export type { DiffTable, FieldStatus, SchemaDiffModel, TableStatus };
