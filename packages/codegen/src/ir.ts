/**
 * AST-observable subset of a column's modifier chain (`.unique()`, `.default()`,
 * …). Function-valued modifiers (`.$defaultFn`/`.$onUpdateFn`) can't be
 * serialized, so only their *presence* is recorded.
 */
export interface ColumnMetaIR {
    /** `.default(...)` or `.$defaultFn(...)` present — field is optional on insert. */
    hasDefault?: boolean;
    /** `.$onUpdateFn(...)` present. */
    hasOnUpdate?: boolean;
    /** Default `true`; `.nullable()` flips it to `false`. */
    notNull: boolean;
    /** `.unique()` present. */
    unique?: boolean;
}

/** Reflective representation of a single validator call from the schema. */
export interface ValidatorIR {
    /** Column modifiers (`.unique()`, `.default()`, `.nullable()`, …) when present. */
    column?: ColumnMetaIR;
    /** For `v.optional(inner)` / `v.array(inner)`. */
    inner?: ValidatorIR;
    /** For `v.record(key, value)`. */
    keyType?: ValidatorIR;
    /** Kind of validator (string, number, id, object, optional, array, union, literal, record, ...). */
    kind: string;
    /** For `v.literal(value)` — the literal value as source text. */
    literalValue?: string;
    /** For `v.union(a, b, ...)`. */
    members?: ValidatorIR[];
    /** For `v.object({...})`. */
    shape?: Record<string, ValidatorIR>;
    /** Verbatim source text — used in emitted code when we can't reconstruct from AST. */
    sourceText?: string;
    /** For `v.id("table")` — the table name. */
    tableName?: string;
    valueType?: ValidatorIR;
}

export interface IndexIR {
    fields: ReadonlyArray<string>;
    name: string;
    unique?: boolean;
}

export interface SearchIndexIR {
    /** Primary text-search field. */
    field: string;
    /** Optional filter fields surfaced alongside the FTS column. */
    filterFields?: ReadonlyArray<string>;
    name: string;
}

export interface VectorIndexIR {
    dimensions?: number;
    /** Shape A: the single source column. Shape B: undefined (derived via a `select` fn). */
    field?: string;
    /** Shape A: metadata field names mirrored into Vectorize. */
    metadata?: ReadonlyArray<string>;
    metric?: "cosine" | "dot-product" | "euclidean";
    name: string;
    /** Owning table the vectors are sourced from. */
    table: string;
}

export interface RelationIR {
    /** FK column: on this table for `one`, on the target table for `many`. */
    field: string;
    kind: "many" | "one";
    /** Accessor name the relation is loaded under (the `with` key). */
    name: string;
    /** FK behaviour applied to holder rows when the referenced parent is deleted. */
    onDelete?: "cascade" | "restrict" | "set null";
    /** Referenced column (defaults to `_id`). */
    references: string;
    /** Target table name. */
    table: string;
}

export interface TableIR {
    indexes: ReadonlyArray<IndexIR>;
    name: string;
    /** Declared relations (via `.relations((r) => …)`), keyed in source order. */
    relations: ReadonlyArray<RelationIR>;
    searchIndexes: ReadonlyArray<SearchIndexIR>;
    shape: Record<string, ValidatorIR>;
    shardMode: "global" | "root" | { field: string; kind: "shardBy" };
    /** Vector indexes declared inline via `.vectorize()` (DSL Shape A). */
    vectorIndexes: ReadonlyArray<VectorIndexIR>;
}

export interface SchemaIR {
    tables: ReadonlyArray<TableIR>;
    /** All vector indexes (inline Shape A hoisted + standalone Shape B), flattened. */
    vectorIndexes: ReadonlyArray<VectorIndexIR>;
}

export interface FunctionIR {
    args: Record<string, ValidatorIR>;
    exportName: string;
    /** Path relative to `&lt;projectRoot>/cirrus/` without extension, e.g. "messages". */
    filePath: string;
    kind: "action" | "mutation" | "query" | "stream";

    /**
     * Serialized TS source for the handler's return type, with `Promise&lt;T>`
     * unwrapped so callers see `T` directly. Defaults to `"unknown"` when
     * ts-morph cannot resolve the type (typically because the consuming
     * project lacks a tsconfig that can reach `@cirrus/server`).
     */
    returnType: string;

    /**
     * Call surface the function is exposed on. Absent (or `"public"`) means it
     * lands in the generated `api`; `"internal"` routes it to the separate
     * `internal` object and is rejected by the DO's external RPC path.
     */
    visibility?: "internal" | "public";
}

/**
 * A `defineMigration({...})` declaration discovered in the user's cirrus
 * sources. The emitted `CIRRUS_MIGRATIONS` registry keys on {@link MigrationIR.id}; the
 * import wiring needs {@link MigrationIR.exportName}/{@link MigrationIR.filePath}. {@link MigrationIR.table} is
 * informational (the runtime object carries the authoritative value).
 */
export interface MigrationIR {
    /** Export binding name, used to reference the module member in generated imports. */
    exportName: string;
    /** Path relative to `&lt;projectRoot>/cirrus/` without extension, e.g. "migrations". */
    filePath: string;
    /** Stable migration id — the registry key and per-shard run-state key. */
    id: string;
    /** Table the migration iterates; `""` when not a static string literal. */
    table: string;
}

export interface ProjectIR {
    functions: ReadonlyArray<FunctionIR>;
    migrations: ReadonlyArray<MigrationIR>;
    schema: SchemaIR;
}
