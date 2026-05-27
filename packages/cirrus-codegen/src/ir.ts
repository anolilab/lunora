/** Reflective representation of a single validator call from the schema. */
export interface ValidatorIR {
    /** Kind of validator (string, number, id, object, optional, array, union, literal, record, ...). */
    kind: string;
    /** For `v.id("table")` — the table name. */
    tableName?: string;
    /** For `v.optional(inner)` / `v.array(inner)`. */
    inner?: ValidatorIR;
    /** For `v.object({...})`. */
    shape?: Record<string, ValidatorIR>;
    /** For `v.union(a, b, ...)`. */
    members?: ValidatorIR[];
    /** For `v.literal(value)` — the literal value as source text. */
    literalValue?: string;
    /** For `v.record(key, value)`. */
    keyType?: ValidatorIR;
    valueType?: ValidatorIR;
    /** Verbatim source text — used in emitted code when we can't reconstruct from AST. */
    sourceText?: string;
}

export interface IndexIR {
    fields: ReadonlyArray<string>;
    name: string;
    unique?: boolean;
}

export interface TableIR {
    indexes: ReadonlyArray<IndexIR>;
    name: string;
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
}

export interface ProjectIR {
    functions: ReadonlyArray<FunctionIR>;
    schema: SchemaIR;
}
