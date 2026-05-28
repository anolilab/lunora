import type { Validator } from "@cirrus/values";

import type {
    IndexDefinition,
    OnDeleteAction,
    RelationDefinition,
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

/** A `one` (many-to-one) relation descriptor; phantom `Target` carries the target table name. */
export interface OneRelation<Target extends string = string> extends RelationDefinition {
    readonly __target?: Target;
    readonly kind: "one";
}

/** A `many` (one-to-many) relation descriptor; phantom `Target` carries the target table name. */
export interface ManyRelation<Target extends string = string> extends RelationDefinition {
    readonly __target?: Target;
    readonly kind: "many";
}

/** The `r` argument passed to `.relations((r) => …)`. */
export interface RelationBuilder {
    /** One-to-many: the FK `field` lives on the target table, matching this table's `references` (default `_id`). */
    many: <Target extends string>(table: Target, options: { field: string; references?: string }) => ManyRelation<Target>;
    /** Many-to-one: the FK `field` lives on this table, pointing at `table`.`references` (default `_id`). */
    one: <Target extends string>(table: Target, options: { field: string; onDelete?: OnDeleteAction; references?: string }) => OneRelation<Target>;
}

export interface TableBuilder<Shape extends Record<string, Validator> = Record<string, Validator>> extends TableDefinition<Shape> {
    /** Mark this table as global (D1-backed, cross-shard). */
    global: () => TableBuilder<Shape>;
    /** Add a secondary index. */
    index: (name: string, fields: ReadonlyArray<string>, options?: { unique?: boolean }) => TableBuilder<Shape>;
    /** Declare relations to other tables, loaded via `findMany({ with })`. */
    relations: (build: (r: RelationBuilder) => Record<string, RelationDefinition>) => TableBuilder<Shape>;
    /** Add a search index over a field with optional filter fields. */
    searchIndex: (name: string, options: { field: string; filterFields?: ReadonlyArray<string> }) => TableBuilder<Shape>;
    /** Route storage by the named field — one DO per distinct value. */
    shardBy: (field: keyof Shape & string) => TableBuilder<Shape>;
    /** Declare a vector index over a single text field on this table. */
    vectorize: (field: keyof Shape & string, options: VectorizeOptions<Shape>) => TableBuilder<Shape>;
}

/** Shared relation builder — `one`/`many` produce {@link RelationDefinition}s, defaulting `references` to `_id`. */
const relationBuilder: RelationBuilder = {
    many: (table, options) => ({ field: options.field, kind: "many", references: options.references ?? "_id", table }),
    one: (table, options) => ({ field: options.field, kind: "one", onDelete: options.onDelete, references: options.references ?? "_id", table }),
};

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
    const relations: Record<string, RelationDefinition> = {};
    const searchIndexes: SearchIndexDefinition[] = [];
    const vectorIndexes: TableVectorIndex[] = [];
    let shardMode: ShardMode = { kind: "root" };

    const builder: TableBuilder<Shape> = {
        get indexes() {
            return indexes;
        },
        get relationMap() {
            return relations;
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
        relations(build) {
            Object.assign(relations, build(relationBuilder));

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
