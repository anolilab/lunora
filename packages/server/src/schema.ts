import type { Validator } from "@cirrus/values";

import type {
    IndexDefinition,
    Schema,
    SearchIndexDefinition,
    ShardMode,
    TableDefinition,
    TableVectorIndex,
    VectorEmbedder,
    VectorIndexDefinition,
    VectorMetric,
} from "./types.js";

/** Options for `.vectorize(field, opts)` (DSL Shape A). */
export interface VectorizeOptions<Shape extends Record<string, Validator> = Record<string, Validator>> {
    dimensions: number;
    embed: VectorEmbedder;
    /** Logical index name; must match a `[[vectorize]]` binding in wrangler. */
    index: string;
    /** Fields mirrored into Vectorize metadata for filtering. */
    metadata?: ReadonlyArray<keyof Shape & string>;
    metric: VectorMetric;
}

export interface TableBuilder<Shape extends Record<string, Validator> = Record<string, Validator>> extends TableDefinition<Shape> {
    /** Mark this table as global (D1-backed, cross-shard). */
    global: () => TableBuilder<Shape>;
    /** Add a secondary index. */
    index: (name: string, fields: ReadonlyArray<string>, options?: { unique?: boolean }) => TableBuilder<Shape>;
    /** Add a search index over a field with optional filter fields. */
    searchIndex: (name: string, options: { field: string; filterFields?: ReadonlyArray<string> }) => TableBuilder<Shape>;
    /** Route storage by the named field — one DO per distinct value. */
    shardBy: (field: keyof Shape & string) => TableBuilder<Shape>;
    /** Declare a vector index over a single text field on this table. */
    vectorize: (field: keyof Shape & string, options: VectorizeOptions<Shape>) => TableBuilder<Shape>;
}

/** Options for `defineVectorIndex(...)` (DSL Shape B). */
export interface VectorIndexOptions {
    dimensions: number;
    embed: VectorEmbedder;
    /** Optional projection of the source row into Vectorize metadata. */
    metadata?: (row: Record<string, unknown>) => Record<string, unknown>;
    metric: VectorMetric;
    /** The vector source: which table, and how to derive the embedded text. */
    source: { select: (row: Record<string, unknown>) => string; table: string };
}

/**
 * Build a table definition. Returned object is both the table definition (for
 * `defineSchema`) and a fluent builder for indexes + sharding metadata.
 */
export const defineTable = <Shape extends Record<string, Validator>>(shape: Shape): TableBuilder<Shape> => {
    const indexes: IndexDefinition[] = [];
    const searchIndexes: SearchIndexDefinition[] = [];
    const vectorIndexes: TableVectorIndex[] = [];
    let shardMode: ShardMode = { kind: "root" };

    const builder: TableBuilder<Shape> = {
        get indexes() {
            return indexes;
        },
        get searchIndexes() {
            return searchIndexes;
        },
        shape,
        get shardMode() {
            return shardMode;
        },
        get vectorIndexes() {
            return vectorIndexes;
        },
        global() {
            shardMode = { kind: "global" };

            return builder;
        },
        index(name, fields, options) {
            indexes.push({ fields, name, unique: options?.unique ?? false });

            return builder;
        },
        searchIndex(name, options) {
            searchIndexes.push({ field: options.field, filterFields: options.filterFields, name });

            return builder;
        },
        shardBy(field) {
            shardMode = { field, kind: "shardBy" };

            return builder;
        },
        vectorize(field, options) {
            vectorIndexes.push({
                dimensions: options.dimensions,
                embed: options.embed,
                field,
                metadata: options.metadata,
                metric: options.metric,
                name: options.index,
            });

            return builder;
        },
    };

    return builder;
};

/**
 * Declare a standalone vector index (DSL Shape B). Pass the returned value in
 * the `vectorIndexes` map of {@link defineSchema} when the source is derived
 * from multiple fields or a computation rather than a single column.
 */
export const defineVectorIndex = (options: VectorIndexOptions): VectorIndexDefinition => ({
    dimensions: options.dimensions,
    embed: options.embed,
    kind: "vectorIndex",
    metadata: options.metadata,
    metric: options.metric,
    select: options.source.select,
    table: options.source.table,
});

/**
 * Build the application schema. The first argument is the table map; the
 * optional second argument registers standalone `defineVectorIndex(...)`
 * declarations (DSL Shape B) keyed by index name.
 */
export const defineSchema = <T extends Record<string, TableDefinition>>(tables: T, vectorIndexes: Record<string, VectorIndexDefinition> = {}): Schema<T> => {
    return { tables, vectorIndexes };
};
