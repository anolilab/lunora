/** Reflective representation of a single validator call from the schema. */
export interface ValidatorIR {
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

export interface TableIR {
    indexes: ReadonlyArray<IndexIR>;
    name: string;
    searchIndexes: ReadonlyArray<SearchIndexIR>;
    shape: Record<string, ValidatorIR>;
    shardMode: "global" | "root" | { field: string; kind: "shardBy" };
}

export interface SchemaIR {
    tables: ReadonlyArray<TableIR>;
}

export interface FunctionIR {
    args: Record<string, ValidatorIR>;
    exportName: string;
    /** Path relative to `<projectRoot>/cirrus/` without extension, e.g. "messages". */
    filePath: string;
    kind: "action" | "mutation" | "query";
    /**
     * Serialized TS source for the handler's return type, with `Promise<T>`
     * unwrapped so callers see `T` directly. Defaults to `"unknown"` when
     * ts-morph cannot resolve the type (typically because the consuming
     * project lacks a tsconfig that can reach `@cirrus/server`).
     */
    returnType: string;
}

export interface ProjectIR {
    functions: ReadonlyArray<FunctionIR>;
    schema: SchemaIR;
}
