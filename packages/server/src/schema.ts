import type { Validator } from "@cirrus/values";

import type {
    AggregateIndexDefinition,
    AggregateOp,
    IndexDefinition,
    OnDeleteAction,
    RelationDefinition,
    Schema,
    SearchIndexDefinition,
    ShardMode,
    TableDefinition,
    TableVectorIndex,
    TriggerBuilder,
    TriggerDefinition,
    TriggerEvent,
    TriggerHandler,
    TriggerOp,
    TriggerTiming,
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

/**
 * Options for the inline `.aggregateIndex(name, opts)` builder. `op` defaults to
 * `count` so `aggregateIndex("byUser", { by: ["userId"] })` is a single-line
 * `COUNT(*) GROUP BY userId` accelerator.
 */
export interface InlineAggregateIndexOptions<Shape extends Record<string, Validator> = Record<string, Validator>> {
    /** Group keys; counter rows are one per distinct tuple. Omitted = single-row aggregate over the whole table. */
    by?: ReadonlyArray<keyof Shape & string>;
    /** The column the reducer applies to. Required for `sum`/`min`/`max`/`avg`; ignored for `count`. */
    field?: keyof Shape & string;
    /** Reducer (default `count`). */
    op?: AggregateOp;
    /** Static predicate baked into the counter — only matching rows are aggregated. */
    where?: Record<string, unknown>;
}

export interface TableBuilder<Shape extends Record<string, Validator> = Record<string, Validator>> extends TableDefinition<Shape> {
    /** Declare an aggregate (counter/sum/…) maintained by triggers for O(1) reads. */
    aggregateIndex: (name: string, options?: InlineAggregateIndexOptions<Shape>) => TableBuilder<Shape>;
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
    /** Declare named lifecycle triggers fired inline within the write path. */
    triggers: (build: (t: TriggerBuilder<Shape>) => Record<string, TriggerDefinition>) => TableBuilder<Shape>;
    /** Declare a vector index over a single text field on this table. */
    vectorize: (field: keyof Shape & string, options: VectorizeOptions<Shape>) => TableBuilder<Shape>;
}

/** Shared relation builder — `one`/`many` produce {@link RelationDefinition}s, defaulting `references` to `_id`. */
const relationBuilder: RelationBuilder = {
    many: (table, options) => ({ field: options.field, kind: "many", references: options.references ?? "_id", table }),
    one: (table, options) => ({ field: options.field, kind: "one", onDelete: options.onDelete, references: options.references ?? "_id", table }),
};

/** Build a {@link TriggerDefinition}; the handler's narrow event type is erased into the stored union. */
const makeTrigger = (timing: TriggerTiming, op: TriggerOp, handler: TriggerHandler<TriggerEvent>): TriggerDefinition => ({ handler, op, timing });

/**
 * Build a per-`Shape` trigger builder. Runtime behavior is shape-agnostic —
 * every method just stores `{ handler, op, timing }` — so the `as` casts only
 * widen each handler's narrow event param into the stored {@link TriggerEvent}
 * union. The precise per-`Shape` event typing lives in {@link TriggerBuilder}.
 */
const createTriggerBuilder = <Shape extends Record<string, Validator>>(): TriggerBuilder<Shape> => ({
    afterDelete: (handler) => makeTrigger("after", "delete", handler as TriggerHandler<TriggerEvent>),
    afterInsert: (handler) => makeTrigger("after", "insert", handler as TriggerHandler<TriggerEvent>),
    afterUpdate: (handler) => makeTrigger("after", "update", handler as TriggerHandler<TriggerEvent>),
    beforeDelete: (handler) => makeTrigger("before", "delete", handler as TriggerHandler<TriggerEvent>),
    beforeInsert: (handler) => makeTrigger("before", "insert", handler as TriggerHandler<TriggerEvent>),
    beforeUpdate: (handler) => makeTrigger("before", "update", handler as TriggerHandler<TriggerEvent>),
});

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
    const aggregateIndexes: AggregateIndexDefinition[] = [];
    const indexes: IndexDefinition[] = [];
    const relations: Record<string, RelationDefinition> = {};
    const searchIndexes: SearchIndexDefinition[] = [];
    const triggers: Record<string, TriggerDefinition> = {};
    const triggerBuilder = createTriggerBuilder<Shape>();
    const vectorIndexes: TableVectorIndex[] = [];
    let shardMode: ShardMode = { kind: "root" };

    const builder: TableBuilder<Shape> = {
        get aggregateIndexes() {
            return aggregateIndexes;
        },
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
        get triggerMap() {
            return triggers;
        },
        get vectorIndexes() {
            return vectorIndexes;
        },
        aggregateIndex(name, options) {
            const op: AggregateOp = options?.op ?? "count";

            if (op !== "count" && !options?.field) {
                throw new Error(`aggregateIndex "${name}": op "${op}" requires a "field"`);
            }

            aggregateIndexes.push({
                by: options?.by,
                field: options?.field,
                name,
                // `on` is filled in by `defineSchema` once the table is keyed; we
                // stash the placeholder so the AggregateIndexDefinition shape stays
                // straightforward for D1/DO consumers (who read `on`).
                on: "",
                op,
                where: options?.where,
            });

            return builder;
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
        triggers(build) {
            Object.assign(triggers, build(triggerBuilder));

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
 * Options for the standalone `defineAggregateIndex(name, opts)` helper (DSL
 * Shape B). Unlike the inline `.aggregateIndex(...)` builder, this form takes
 * the owning table explicitly via `on` — handy when a single counter wants to
 * live next to the schema map rather than inside a table chain.
 */
export interface AggregateIndexOptions {
    by?: ReadonlyArray<string>;
    field?: string;
    on: string;
    op?: AggregateOp;
    where?: Record<string, unknown>;
}

/**
 * Declare a standalone aggregate index. Pass the returned value to
 * `defineSchema(tables, vectorIndexes, aggregateIndexes)` keyed by index name —
 * the schema attaches it to `tables[on].aggregateIndexes` so runtime consumers
 * (DO + D1) read every index uniformly off the table definition.
 */
export const defineAggregateIndex = (name: string, options: AggregateIndexOptions): AggregateIndexDefinition => {
    const op: AggregateOp = options.op ?? "count";

    if (op !== "count" && !options.field) {
        throw new Error(`aggregateIndex "${name}": op "${op}" requires a "field"`);
    }

    return { by: options.by, field: options.field, name, on: options.on, op, where: options.where };
};

/**
 * Build the application schema. The first argument is the table map; the
 * optional second argument registers standalone `defineVectorIndex(...)`
 * declarations (DSL Shape B) keyed by index name. The optional third argument
 * registers standalone `defineAggregateIndex(...)` declarations (DSL Shape B);
 * they are folded into the matching `tables[on].aggregateIndexes` array so
 * runtime backends read all indexes from one place.
 */
export const defineSchema = <T extends Record<string, TableDefinition>>(
    tables: T,
    vectorIndexes: Record<string, VectorIndexDefinition> = {},
    aggregateIndexes: Record<string, AggregateIndexDefinition> = {},
): Schema<T> => {
    // Fill in the `on` field for every inline `.aggregateIndex(...)` decl —
    // the builder stashes `""` because it doesn't know its own table name.
    for (const [tableName, table] of Object.entries(tables)) {
        for (const index of table.aggregateIndexes) {
            if (index.on === "") {
                (index as { on: string }).on = tableName;
            }
        }
    }

    // Fold standalone decls onto their owning table so the runtime can read
    // every aggregate uniformly off `tables[name].aggregateIndexes`.
    for (const index of Object.values(aggregateIndexes)) {
        const table = (tables as Record<string, TableDefinition>)[index.on];

        if (!table) {
            throw new Error(`defineAggregateIndex "${index.name}": unknown table "${index.on}"`);
        }

        (table.aggregateIndexes as AggregateIndexDefinition[]).push(index);
    }

    return { tables, vectorIndexes };
};
