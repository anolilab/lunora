import type { RelationIR, SchemaIR, ValidatorIR } from "../ir";
import { isOptionalOnInsert, unwrapOptional } from "./shared";

/**
 * Emit `_generated/shard.ts` — a `createShardDO(config)` factory returning a
 * concrete `ShardDO` subclass. Dispatch runs through `LUNORA_FUNCTIONS` from
 * `./functions.js`; the live schema is imported from `../schema.js`.
 *
 * The file stays dependency-light: it always imports `@lunora/do`, and only
 * imports `@lunora/bindings/vectors` when the schema declares at least one
 * vector index AND the target platform rates a vector store as something other
 * than `unsupported` (`hasVectors`) — the same pairing `emitServer` makes.
 * `scheduler`/`storage` arrive via optional config thunks (so the generated
 * file never hard-imports `@lunora/scheduler` / `@lunora/storage`); when a
 * thunk is omitted an error stub is wired in its place.
 */

/**
 * Foreign-key map per table for the data browser: `{ table: { field: target } }`
 * for every field declared `v.id("target")` (unwrapping `v.optional(...)`). The
 * generated shard hands this to the base `tableRefs` hook so the admin
 * `readTablePage` can mark those cells as links.
 */
const buildTableReferences = (schema: SchemaIR): Record<string, Record<string, string>> => {
    const references: Record<string, Record<string, string>> = {};

    for (const table of schema.tables) {
        const fields: Record<string, string> = {};

        for (const [field, validator] of Object.entries(table.shape)) {
            const resolved = unwrapOptional(validator);

            if (resolved.kind === "id" && resolved.tableName !== undefined) {
                fields[field] = resolved.tableName;
            }
        }

        if (Object.keys(fields).length > 0) {
            references[table.name] = fields;
        }
    }

    return references;
};

/**
 * Storage-column map per table for the file browser: `{ table: [field, …] }` for
 * every field declared `v.storage(...)` (unwrapping `v.optional(...)`). The
 * generated shard hands this to the base `storageColumns` hook so the admin
 * `storageReferences` read can join R2 objects back to the rows that own them
 * (and flag orphans — objects no row references). Only scalar storage columns
 * are emitted; an array-of-storage field can't be matched by an equality scan,
 * so it is skipped here.
 */
const buildStorageColumns = (schema: SchemaIR): Record<string, string[]> => {
    const byTable: Record<string, string[]> = {};

    for (const table of schema.tables) {
        const fields: string[] = [];

        for (const [field, validator] of Object.entries(table.shape)) {
            const resolved = unwrapOptional(validator);

            if (resolved.kind === "storage") {
                fields.push(field);
            }
        }

        if (fields.length > 0) {
            byTable[table.name] = fields;
        }
    }

    return byTable;
};

/** One flattened index entry per table, mirroring `@lunora/do`'s `TableIndexInfo`. */
interface EmittedTableIndex {
    fields: string[];
    name: string;
    type: "geo" | "index" | "rank" | "search" | "vector";
    unique?: boolean;
}

/**
 * Declared-index map per table for the schema viewer: `{ table: [{ name, type,
 * fields, unique? }] }`, flattening secondary (`.index`), search, rank, and
 * vector indexes into one list. The generated shard hands this to the base
 * `tableIndexes` hook so the admin `listTableIndexes` can report field names the
 * physical `json_extract` indexes can't.
 */
const buildTableIndexes = (schema: SchemaIR): Record<string, EmittedTableIndex[]> => {
    const byTable: Record<string, EmittedTableIndex[]> = {};

    for (const table of schema.tables) {
        const entries: EmittedTableIndex[] = [
            ...table.indexes.map((index) => {
                return { fields: [...index.fields], name: index.name, type: "index" as const, ...(index.unique === true ? { unique: true } : {}) };
            }),
            ...table.searchIndexes.map((index) => {
                return { fields: [index.field, ...(index.filterFields ?? [])], name: index.name, type: "search" as const };
            }),
            ...(table.geoIndexes ?? []).map((index) => {
                return { fields: [index.field], name: index.name, type: "geo" as const };
            }),
            ...table.rankIndexes.map((index) => {
                return { fields: index.sortBy.map((key) => key.field), name: index.name, type: "rank" as const };
            }),
            ...table.vectorIndexes.map((index) => {
                return { fields: index.field === undefined ? [] : [index.field], name: index.name, type: "vector" as const };
            }),
        ];

        if (entries.length > 0) {
            byTable[table.name] = entries;
        }
    }

    return byTable;
};

/** One resolved TTL policy the generated shard hands to the base `ttlSweeps()` alarm hook. */
interface EmittedTtlSweep {
    after?: number;
    field: string;
    softDeleteField?: string;
    table: string;
}

/**
 * Resolve every `.ttl(field, { after? })` table into a {@link EmittedTtlSweep} the
 * DO's alarm sweep consumes. `.global()` tables live in D1 (no local alarm), so
 * they're skipped. The `.softDelete()` marker (when the table declares one) rides
 * along so the sweep excludes already-tombstoned rows.
 */
const buildTtlSweeps = (schema: SchemaIR): EmittedTtlSweep[] => {
    const sweeps: EmittedTtlSweep[] = [];

    for (const table of schema.tables) {
        if (!table.ttl || table.shardMode === "global") {
            continue;
        }

        sweeps.push({
            ...(table.ttl.after === undefined ? {} : { after: table.ttl.after }),
            field: table.ttl.field,
            ...(table.softDelete ? { softDeleteField: table.softDelete.field } : {}),
            table: table.name,
        });
    }

    return sweeps;
};

/** One column descriptor per table, mirroring `@lunora/do`'s `ColumnMeta`. */
interface EmittedColumn {
    /** The typed bucket a `v.storage(bucket)` column's key lives in, when one was named. */
    bucket?: string;

    /**
     * The allowed values of a string-literal union, so the studio's row editor can
     * offer a dropdown instead of a free-text box. Present only when EVERY member
     * is a string literal — see {@link stringEnumValues}.
     */
    enumValues?: string[];
    /** `v.storage(...)` column — the value is an R2 object key. */
    isStorage?: boolean;
    name: string;

    /**
     * The column accepts `null` (`.nullable()`). Distinct from `optional`,
     * which means "may be omitted on INSERT" and is also true of a column with a
     * `.default(...)` — a defaulted non-nullable column must not be offered a
     * "clear this field" control that then writes `null`.
     */
    nullable?: boolean;

    /**
     * The declared `onDelete` of the relation this foreign key belongs to — what
     * the writer actually does to this row when the referenced parent is deleted.
     * Absent when the column is not an FK, or when the schema declared no action.
     * Carried so the studio's delete preview can name the real behaviour instead
     * of reporting every edge as undeclared.
     */
    onDelete?: "cascade" | "restrict" | "set null";
    /** Optional on insert: declared `v.optional(...)` or carrying a `.default(...)`. */
    optional: boolean;
    /** Primary key — the runtime-minted `_id` column. */
    pk?: boolean;
    /** Foreign-key target table for a `v.id("target")` column. */
    ref?: string;
    /** Display type: the validator IR kind (`string`, `number`, `id`, `array`, …). */
    type: string;
}

/**
 * The string values of a union of string literals, or `undefined` for anything
 * else.
 *
 * All-or-nothing on purpose. A mixed union (`v.union(v.literal("a"),
 * v.string())`) has legal values outside the list, so a dropdown built from it
 * would silently forbid one — worse than no dropdown. A numeric union is
 * excluded for a different reason: `enumValues` is `string[]` on the wire, so
 * admitting numbers would mean the editor stages `"1"` where the column holds `1`.
 *
 * `literalValue` is canonical SOURCE TEXT, not the value — `parse-validator.ts`
 * runs strings through `JSON.stringify` so escapes and backticks survive — so it
 * is parsed back here. A member that does not parse to a string disqualifies the
 * whole column rather than being dropped from the list, for the same reason a
 * mixed union does.
 */
const stringEnumValues = (validator: ValidatorIR): string[] | undefined => {
    if (validator.kind !== "union" || validator.members === undefined || validator.members.length === 0) {
        return undefined;
    }

    const values: string[] = [];

    for (const member of validator.members) {
        if (member.kind !== "literal" || member.literalValue === undefined) {
            return undefined;
        }

        try {
            const parsed: unknown = JSON.parse(member.literalValue);

            if (typeof parsed !== "string") {
                return undefined;
            }

            values.push(parsed);
        } catch {
            // Not JSON at all (an identifier, a template with substitutions) —
            // nothing the editor could offer as a fixed choice.
            return undefined;
        }
    }

    return values;
};

/**
 * Column map per table for the studio's schema diagram: `{ table: [{ name, type,
 * optional, pk?, ref?, isStorage? }] }`. Mirrors {@link buildTableReferences} /
 * {@link buildTableIndexes}; the generated shard hands it to the base
 * `tableColumns` hook so the admin `describeTable` read can report each field's
 * declared type and its PK/FK role (which `PRAGMA table_info` can't recover —
 * lunora stores rows as a `__doc__` JSON blob). The runtime-minted system fields
 * `_id` (the primary key) and `_creationTime` are absent from `table.shape`, so
 * they're prepended here so the diagram shows every column a row actually has.
 */

/**
 * One column's emitted metadata. Split out of {@link buildTableColumns} so the
 * per-field decisions read on their own rather than nested two loops deep.
 */
const buildColumn = (field: string, validator: ValidatorIR, onDeleteByField: ReadonlyMap<string, RelationIR["onDelete"]>): EmittedColumn => {
    const resolved = unwrapOptional(validator);
    const column: EmittedColumn = { name: field, optional: isOptionalOnInsert(validator), type: resolved.kind };

    if (resolved.kind === "id" && resolved.tableName !== undefined) {
        column.ref = resolved.tableName;

        // The declared delete behaviour lives on the table's relation, not on the
        // validator. Without it the studio's delete preview cannot tell a cascade
        // from a restrict and reports every FK as "no delete action declared".
        const onDelete = onDeleteByField.get(field);

        if (onDelete !== undefined) {
            column.onDelete = onDelete;
        }
    }

    if (resolved.kind === "storage") {
        column.isStorage = true;

        if (resolved.bucket !== undefined) {
            column.bucket = resolved.bucket;
        }
    }

    const enumValues = stringEnumValues(resolved);

    if (enumValues !== undefined) {
        column.enumValues = enumValues;
    }

    // `.nullable()` flips `notNull` off. Absent column metadata means the field
    // carries no modifiers at all, which is not-null.
    if (resolved.column?.notNull === false) {
        column.nullable = true;
    }

    return column;
};

const buildTableColumns = (schema: SchemaIR): Record<string, EmittedColumn[]> => {
    const byTable: Record<string, EmittedColumn[]> = {};

    for (const table of schema.tables) {
        const columns: EmittedColumn[] = [
            { name: "_id", optional: false, pk: true, type: "id" },
            { name: "_creationTime", optional: false, type: "number" },
            // Runtime-minted like the two above, but only on a `.commitOrdered()`
            // table — the diagram must not show a column the rows don't carry.
            ...(table.commitOrdered === true ? [{ name: "_commitSeq", optional: false, type: "number" } satisfies EmittedColumn] : []),
        ];

        // `one` relations are the ones whose FK column lives on THIS table, so
        // only those map a local field to a declared delete action.
        const onDeleteByField = new Map<string, RelationIR["onDelete"]>(
            table.relations.filter((relation) => relation.kind === "one").map((relation) => [relation.field, relation.onDelete]),
        );

        for (const [field, validator] of Object.entries(table.shape)) {
            columns.push(buildColumn(field, validator, onDeleteByField));
        }

        byTable[table.name] = columns;
    }

    return byTable;
};

export { buildStorageColumns, buildTableColumns, buildTableIndexes, buildTableReferences, buildTtlSweeps };
