import { LunoraError } from "@lunora/errors";
import type { Validator } from "@lunora/values";
import { isOrWrapsFromValidator, v } from "@lunora/values";

import type { PrefixedTables, SchemaExtension } from "./plugin";
import { mergeSchemaExtension } from "./plugin";
import type {
    AggregateIndexDefinition,
    AggregateOp,
    DurableObjectJurisdiction,
    ExternalSourceDefinition,
    GeoIndexDefinition,
    GlobalBackend,
    IndexDefinition,
    OnDeleteAction,
    RankIndexDefinition,
    RankSortKey,
    RelationDefinition,
    Schema,
    SearchIndexDefinition,
    SearchLanguage,
    SearchStrategy,
    ShardMode,
    TableDefinition,
    TableVectorIndex,
    TriggerBuilder,
    TriggerDefinition,
    TriggerEvent,
    TriggerHandler,
    TriggerOp,
    TriggerTiming,
    TtlDefinition,
    VectorEmbedder,
    VectorIndexDefinition,
    VectorMetric,
} from "./types";

/**
 * Most `filterFields` one `.searchIndex()` may declare. Mirrors Convex. Lives
 * here because this is where it is enforceable — the engines read the declared
 * list, they never re-validate its length — so there is one home rather than a
 * copy on each side of a package boundary.
 */
const MAX_SEARCH_FILTER_FIELDS = 16;

/**
 * Languages `.searchIndex({ language })` accepts. Restated here rather than
 * imported because `@lunora/server` has no dependency edge to the engines that
 * own the analyzers — and a typo'd language silently falling back to
 * folding-only is exactly the kind of quiet wrong answer a schema-time check
 * should catch instead.
 */
const SEARCH_LANGUAGES: ReadonlySet<string> = new Set<string>(["de", "en", "es", "fr", "it", "nl", "none", "pt"]);

/** Options for `.vectorize(field, opts)` (DSL Shape A). */
interface VectorizeOptions<Shape extends Record<string, Validator> = Record<string, Validator>> {
    dimensions: number;
    embed: VectorEmbedder;
    /** Logical index name; must match a `[[vectorize]]` binding in wrangler. */
    index: string;
    /** Fields mirrored into Vectorize metadata for filtering. */
    metadata?: ReadonlyArray<keyof Shape & string>;
    metric: VectorMetric;
}

/** A `one` (many-to-one) relation descriptor; phantom `Target` carries the target table name. */
interface OneRelation<Target extends string = string> extends RelationDefinition {
    readonly __target?: Target;
    readonly kind: "one";
}

/** A `many` (one-to-many) relation descriptor; phantom `Target` carries the target table name. */
interface ManyRelation<Target extends string = string> extends RelationDefinition {
    readonly __target?: Target;
    readonly kind: "many";
}

/** The `r` argument passed to `.relations((r) => …)`. */
interface RelationBuilder {
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
interface InlineAggregateIndexOptions<Shape extends Record<string, Validator> = Record<string, Validator>> {
    /** Group keys; counter rows are one per distinct tuple. Omitted = single-row aggregate over the whole table. */
    by?: ReadonlyArray<keyof Shape & string>;
    /** The column the reducer applies to. Required for `sum`/`min`/`max`/`avg`; ignored for `count`. */
    field?: keyof Shape & string;
    /** Reducer (default `count`). */
    op?: AggregateOp;
    /** Static predicate baked into the counter — only matching rows are aggregated. */
    where?: Record<string, unknown>;
}

/**
 * Options for the inline `.rankIndex(name, opts)` builder. `sortBy` is required;
 * accepts either an array of `{ field, direction }` keys, or the shorthand
 * `["field"]` (asc) / `{ field: "desc" }` map entries. `partitionBy` scopes the
 * rank — omitted ⇒ one global rank over the whole table.
 */
interface InlineRankIndexOptions<Shape extends Record<string, Validator> = Record<string, Validator>> {
    /** Columns that scope each ranking; omitted ⇒ one global rank. */
    partitionBy?: ReadonlyArray<keyof Shape & string>;
    /** Ordered sort keys driving the rank. Required. */
    sortBy: ReadonlyArray<{ direction?: "asc" | "desc"; field: keyof Shape & string }>;
    /** Static predicate baked into the index; only matching rows enter. */
    where?: Record<string, unknown>;
}

interface TableBuilder<Shape extends Record<string, Validator> = Record<string, Validator>> extends TableDefinition<Shape> {
    /** Declare an aggregate (counter/sum/…) maintained by triggers for O(1) reads. */
    aggregateIndex: (name: string, options?: InlineAggregateIndexOptions<Shape>) => TableBuilder<Shape>;

    /**
     * Mark this table as written outside Lunora's discoverable insert path —
     * by an adapter, a migration, or framework middleware (e.g. `@lunora/auth`'s
     * better-auth tables, `@lunora/ratelimit`'s store). Advisor insert-path lints
     * (`table_without_insert`) then skip it instead of flagging the absent
     * `ctx.db.insert(...)`.
     */
    externallyManaged: () => TableBuilder<Shape>;

    /**
     * Declare a geospatial index over a `v.geoPoint()` column. The runtime keeps
     * a geohash companion so `withGeoIndex(name, q => q.near(point, radius))` and
     * `.within(bbox)` resolve as a geohash-prefix range scan + Haversine
     * refine/sort. `options.precision` tunes the geohash length (default 9).
     */
    geoIndex: (name: string, options: { field: keyof Shape & string; precision?: number }) => TableBuilder<Shape>;

    /**
     * Mark this table as global (cross-shard). Backed by **D1** by default;
     * pass `{ backend: "hyperdrive" }` to store it in a Postgres/MySQL database
     * via Cloudflare Hyperdrive (PlanetScale, Neon, …) instead. Either way the
     * table stays reactive — live queries re-run on write.
     */
    global: (options?: { backend?: GlobalBackend }) => TableBuilder<Shape>;
    /** Add a secondary index. */
    index: (name: string, fields: ReadonlyArray<string>, options?: { unique?: boolean }) => TableBuilder<Shape>;

    /**
     * Name the column holding the owning user's id, so "only the owner sees these
     * rows" is declared once here rather than restated in every shape.
     *
     * A `defineShape({ table, owner: true })` over this table derives its predicate
     * from the field: the subscriber's verified `ctx.auth.userId` must match, and an
     * anonymous subscriber is denied. Pairs naturally with `.shardBy(field)` on the
     * same column — the shard key routes the storage, `ownedBy` states who the rows
     * belong to — but the two are independent and either can be used alone.
     *
     * This is a *shape* declaration, not an RLS policy: it narrows what a shape
     * replicates. Guarding procedure reads/writes is still `rls(...)`'s job.
     */
    ownedBy: (field: keyof Shape & string) => TableBuilder<Shape>;

    /**
     * Opt this table OUT of secure-by-default RLS. Under a schema marked
     * `.rls("required")`, every table is protected (the write path denies raw,
     * non-RLS `ctx.db` access); calling `.public()` exempts this one table so a
     * plain `query`/`mutation` may read/write it without an RLS policy. No effect
     * when the schema does not require RLS.
     */
    public: () => TableBuilder<Shape>;

    /**
     * Declare a rank index (sorted companion table, btree-backed) for
     * `rank(row)` / `rankPage()` reads in O(log n). See {@link RankIndexDefinition}.
     */
    rankIndex: (name: string, options: InlineRankIndexOptions<Shape>) => TableBuilder<Shape>;
    /** Declare relations to other tables, loaded via `findMany({ with })`. */
    relations: (build: (r: RelationBuilder) => Record<string, RelationDefinition>) => TableBuilder<Shape>;

    /**
     * Add a full-text search index over `field`, queried with
     * `.withSearchIndex(name, q => q.search(field, term))`. `field` may be a
     * dot-separated path into a nested object (`"properties.name"`).
     * `filterFields` (at most 16) lists the columns `.eq()` may narrow by inside
     * the search. `language` selects the text analysis (accent folding always,
     * plus that language's stopwords). `staged: true` skips the migration-time
     * backfill on a large existing table. `strategy: "native"` uses the engine's
     * own full-text index where it has one (Postgres) — faster on large corpora,
     * at the cost of the engine ranking rather than the shared scorer.
     */
    searchIndex: (
        name: string,
        options: { field: string; filterFields?: ReadonlyArray<string>; language?: SearchLanguage; staged?: boolean; strategy?: SearchStrategy },
    ) => TableBuilder<Shape>;
    /** Route storage by the named field — one DO per distinct value. */
    shardBy: (field: keyof Shape & string) => TableBuilder<Shape>;

    /**
     * Turn on soft delete. Adds a nullable timestamp column (`options.field`,
     * default `deletedAt`) and changes `ctx.db.&lt;table>.delete()` to **set** it
     * instead of removing the row; `onDelete: "cascade"` children are recursively
     * soft-deleted too. **List reads** (`findMany`/`findFirst`/`query()`/`count`/
     * `aggregate`/relation loads) then hide soft-deleted rows unless they pass
     * `includeDeleted: true`; by-id `get`/`patch`/`replace` and the new
     * `restore()` still address the row directly. `hardDelete()` physically
     * removes it (cascading as a real delete). Note: `includeDeleted` is a read
     * scope, not access control — anyone who can run the read can set it; a unique
     * index still rejects a new row that collides with a soft-deleted one (the row
     * physically persists).
     */
    softDelete: (options?: { field?: string }) => TableBuilder<Shape>;

    /**
     * Materialize this table from an external Postgres/MySQL behind Cloudflare
     * Hyperdrive (plan 077). A system-driven poll loop reads the tenant slice
     * (`query`, with params bound from `tenantBy`) and lands it in the DO's SQLite,
     * after which `defineShape` carries it to clients unchanged. Implies
     * `.externallyManaged()` (rows come from the ingest loop, not user mutations).
     *
     * Orthogonal to `.shardBy()` — combine them for per-tenant DOs. **Under
     * `.shardBy()` `tenantBy` is mandatory** (the tenant-isolation boundary); the
     * `external_source_unscoped` advisor lint fails the build when it is absent, and
     * `external_source_on_global` rejects combining `.source()` with `.global()`.
     */
    source: (definition: ExternalSourceDefinition) => TableBuilder<Shape>;

    /** Declare named lifecycle triggers fired inline within the write path. */
    triggers: (build: (t: TriggerBuilder<Shape>) => Record<string, TriggerDefinition>) => TableBuilder<Shape>;

    /**
     * Declare a table-level TTL: a DO alarm-driven sweep auto-deletes rows whose
     * expiry has passed (or soft-deletes them when the table also
     * `.softDelete()`s). `field` is an epoch-millisecond column; without
     * `options.after` its value is the absolute expiry instant, with `after` the
     * row expires `after` ms past `field` (`field + after`). Coarse, cheap,
     * table-level — for per-row schedules use `@lunora/scheduler`.
     */
    ttl: (field: keyof Shape & string, options?: { after?: number }) => TableBuilder<Shape>;
    /** Declare a vector index over a single text field on this table. */
    vectorize: (field: keyof Shape & string, options: VectorizeOptions<Shape>) => TableBuilder<Shape>;
}

/** Shared relation builder — `one`/`many` produce {@link RelationDefinition}s, defaulting `references` to `_id`. */
const relationBuilder: RelationBuilder = {
    many: (table, options) => {
        return { field: options.field, kind: "many", references: options.references ?? "_id", table };
    },
    one: (table, options) => {
        return { field: options.field, kind: "one", onDelete: options.onDelete, references: options.references ?? "_id", table };
    },
};

/** Build a {@link TriggerDefinition}; the handler's narrow event type is erased into the stored union. */
const makeTrigger = (timing: TriggerTiming, op: TriggerOp, handler: TriggerHandler<TriggerEvent>): TriggerDefinition => {
    return { handler, op, timing };
};

/**
 * Build a per-`Shape` trigger builder. Runtime behavior is shape-agnostic —
 * every method just stores `{ handler, op, timing }` — so the `as` casts only
 * widen each handler's narrow event param into the stored {@link TriggerEvent}
 * union. The precise per-`Shape` event typing lives in {@link TriggerBuilder}.
 */
const createTriggerBuilder = <Shape extends Record<string, Validator>>(): TriggerBuilder<Shape> => {
    return {
        afterDelete: (handler) => makeTrigger("after", "delete", handler as TriggerHandler<TriggerEvent>),
        afterInsert: (handler) => makeTrigger("after", "insert", handler as TriggerHandler<TriggerEvent>),
        afterUpdate: (handler) => makeTrigger("after", "update", handler as TriggerHandler<TriggerEvent>),
        beforeDelete: (handler) => makeTrigger("before", "delete", handler as TriggerHandler<TriggerEvent>),
        beforeInsert: (handler) => makeTrigger("before", "insert", handler as TriggerHandler<TriggerEvent>),
        beforeUpdate: (handler) => makeTrigger("before", "update", handler as TriggerHandler<TriggerEvent>),
    };
};

/** Options for `defineVectorIndex(...)` (DSL Shape B). */
interface VectorIndexOptions {
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
const defineTable = <Shape extends Record<string, Validator>>(inputShape: Shape): TableBuilder<Shape> => {
    // Work on a shallow copy so `.softDelete()` can inject its marker column
    // without mutating the caller's object literal.
    const shape = { ...inputShape };

    // v.from() validators are args-only — they delegate to an external Standard
    // Schema library and do not map to a concrete SQL column type. Reject them
    // anywhere in a column, including nested under v.optional/array/object/etc.
    for (const [columnName, validator] of Object.entries(shape)) {
        if (isOrWrapsFromValidator(validator)) {
            throw new LunoraError("INTERNAL", `defineTable: column "${columnName}" uses v.from() which is args-only — table columns need a concrete v.* type`);
        }
    }

    const aggregateIndexes: AggregateIndexDefinition[] = [];
    const geoIndexes: GeoIndexDefinition[] = [];
    const indexes: IndexDefinition[] = [];
    const rankIndexes: RankIndexDefinition[] = [];
    const relations: Record<string, RelationDefinition> = {};
    const searchIndexes: SearchIndexDefinition[] = [];
    const triggers: Record<string, TriggerDefinition> = {};
    const triggerBuilder = createTriggerBuilder<Shape>();
    const vectorIndexes: TableVectorIndex[] = [];
    let shardMode: ShardMode = { kind: "root" };
    let isExternallyManaged = false;
    let isPublic = false;
    let ownerField: string | undefined;
    let softDelete: { field: string } | undefined;
    let ttl: TtlDefinition | undefined;
    let externalSource: ExternalSourceDefinition | undefined;

    const builder: TableBuilder<Shape> = {
        aggregateIndex(name, options) {
            const op: AggregateOp = options?.op ?? "count";

            if (op !== "count" && !options?.field) {
                throw new LunoraError("INTERNAL", `aggregateIndex "${name}": op "${op}" requires a "field"`);
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
        get aggregateIndexes() {
            return aggregateIndexes;
        },
        get externalSource() {
            return externalSource;
        },
        externallyManaged() {
            isExternallyManaged = true;

            return builder;
        },
        geoIndex(name, options) {
            geoIndexes.push({ field: options.field, name, precision: options.precision });

            return builder;
        },
        get geoIndexes() {
            return geoIndexes;
        },
        global(options?: { backend?: GlobalBackend }) {
            shardMode = { backend: options?.backend ?? "d1", kind: "global" };

            return builder;
        },
        get isExternallyManaged() {
            return isExternallyManaged;
        },
        get isPublic() {
            return isPublic;
        },
        index(name, fields, options) {
            indexes.push({ fields, name, unique: options?.unique ?? false });

            return builder;
        },
        get indexes() {
            return indexes;
        },
        ownedBy(field) {
            ownerField = field;

            return builder;
        },
        get ownerField() {
            return ownerField;
        },
        public() {
            isPublic = true;

            return builder;
        },
        rankIndex(name, options) {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: `sortBy` is typed required but untyped JS callers can omit it
            if (!options.sortBy || options.sortBy.length === 0) {
                throw new LunoraError("INTERNAL", `rankIndex "${name}": "sortBy" is required and must list at least one key`);
            }

            const sortBy: RankSortKey[] = options.sortBy.map((key) => {
                return {
                    direction: key.direction ?? "asc",
                    field: key.field,
                };
            });

            rankIndexes.push({
                name,
                // `on` is filled in by `defineSchema` once the table is keyed —
                // same pattern as `aggregateIndex`.
                on: "",
                partitionBy: options.partitionBy,
                sortBy,
                where: options.where,
            });

            return builder;
        },
        get rankIndexes() {
            return rankIndexes;
        },
        get relationMap() {
            return relations;
        },
        relations(build) {
            Object.assign(relations, build(relationBuilder));

            return builder;
        },
        searchIndex(name, options) {
            if (options.filterFields && options.filterFields.length > MAX_SEARCH_FILTER_FIELDS) {
                throw new LunoraError(
                    "INTERNAL",
                    `searchIndex "${name}": at most ${String(MAX_SEARCH_FILTER_FIELDS)} filterFields are supported (got ${String(options.filterFields.length)})`,
                );
            }

            if (options.language !== undefined && !SEARCH_LANGUAGES.has(options.language)) {
                throw new LunoraError(
                    "INTERNAL",
                    `searchIndex "${name}": unknown language "${options.language}" (supported: ${[...SEARCH_LANGUAGES].toSorted((left, right) => left.localeCompare(right)).join(", ")})`,
                );
            }

            searchIndexes.push({
                field: options.field,
                filterFields: options.filterFields,
                language: options.language,
                name,
                staged: options.staged,
                strategy: options.strategy,
            });

            return builder;
        },
        get searchIndexes() {
            return searchIndexes;
        },
        shape,
        shardBy(field) {
            shardMode = { field, kind: "shardBy" };

            return builder;
        },
        get shardMode() {
            return shardMode;
        },
        get softDeleteMode() {
            return softDelete;
        },
        source(definition) {
            // Order-independent guards only — `binding`/`query` are always required.
            // The tenant-scope (`tenantBy` under `.shardBy()`) and the
            // sourced-vs-`.global()` contradiction depend on the FINAL table state
            // (the chain order is arbitrary), so they are enforced by the
            // `external_source_unscoped` / `external_source_on_global` advisor lints
            // over the discovered IR rather than here.
            if (!definition.binding) {
                throw new LunoraError("INTERNAL", "source: `binding` is required (the wrangler Hyperdrive binding name)");
            }

            if (!definition.query) {
                throw new LunoraError("INTERNAL", "source: `query` is required (the tenant-membership SQL)");
            }

            externalSource = definition;
            // A sourced table is written by the ingest loop, never a user mutation —
            // exactly what `.externallyManaged()` marks, so imply it.
            isExternallyManaged = true;

            return builder;
        },
        softDelete(options) {
            const field = options?.field ?? "deletedAt";

            softDelete = { field };

            // Auto-add the marker column so the generated `Doc` carries it and the
            // write path validates it. Optional on insert (absent on a live row)
            // and nullable so `restore()` can clear it with `patch({ [field]: null })`;
            // set to `Date.now()` on soft delete. Idempotent — if the user already
            // declared the column, their validator wins.
            if (!(field in shape)) {
                (shape as Record<string, Validator>)[field] = v.optional(v.number().nullable());
            }

            return builder;
        },
        get triggerMap() {
            return triggers;
        },
        triggers(build) {
            Object.assign(triggers, build(triggerBuilder));

            return builder;
        },
        ttl(field, options) {
            ttl = { after: options?.after, field };

            return builder;
        },
        get ttlPolicy() {
            return ttl;
        },
        get vectorIndexes() {
            return vectorIndexes;
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
const defineVectorIndex = (options: VectorIndexOptions): VectorIndexDefinition => {
    return {
        dimensions: options.dimensions,
        embed: options.embed,
        kind: "vectorIndex",
        metadata: options.metadata,
        metric: options.metric,
        select: options.source.select,
        table: options.source.table,
    };
};

/**
 * Options for the standalone `defineAggregateIndex(name, opts)` helper (DSL
 * Shape B). Unlike the inline `.aggregateIndex(...)` builder, this form takes
 * the owning table explicitly via `on` — handy when a single counter wants to
 * live next to the schema map rather than inside a table chain.
 */
interface AggregateIndexOptions {
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
const defineAggregateIndex = (name: string, options: AggregateIndexOptions): AggregateIndexDefinition => {
    const op: AggregateOp = options.op ?? "count";

    if (op !== "count" && !options.field) {
        throw new LunoraError("INTERNAL", `aggregateIndex "${name}": op "${op}" requires a "field"`);
    }

    return { by: options.by, field: options.field, name, on: options.on, op, where: options.where };
};

/**
 * Options for the standalone `defineRankIndex(name, opts)` helper (DSL Shape B).
 * Mirrors the inline `.rankIndex(...)` builder but takes the owning table via
 * `table` so it can sit next to the schema map.
 */
interface RankIndexOptions {
    partitionBy?: ReadonlyArray<string>;
    sortBy: ReadonlyArray<{ direction?: "asc" | "desc"; field: string }>;
    table: string;
    where?: Record<string, unknown>;
}

/**
 * Declare a standalone rank index. Pass the returned value to
 * `defineSchema(tables, vectorIndexes, aggregateIndexes, rankIndexes)` keyed
 * by index name — the schema attaches it to `tables[on].rankIndexes`.
 */
const defineRankIndex = (name: string, options: RankIndexOptions): RankIndexDefinition => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: `sortBy` is typed required but untyped JS callers can omit it
    if (!options.sortBy || options.sortBy.length === 0) {
        throw new LunoraError("INTERNAL", `rankIndex "${name}": "sortBy" is required and must list at least one key`);
    }

    const sortBy: RankSortKey[] = options.sortBy.map((key) => {
        return {
            direction: key.direction ?? "asc",
            field: key.field,
        };
    });

    return { name, on: options.table, partitionBy: options.partitionBy, sortBy, where: options.where };
};

/**
 * Build the application schema. The first argument is the table map; the
 * optional second argument registers standalone `defineVectorIndex(...)`
 * declarations (DSL Shape B) keyed by index name. The optional third argument
 * registers standalone `defineAggregateIndex(...)` declarations (DSL Shape B);
 * the optional fourth argument registers standalone `defineRankIndex(...)`
 * declarations. Both are folded into the matching `tables[on].*Indexes` array
 * so runtime backends read every index uniformly off the table definition.
 */

/**
 * Schema with an in-place `.extend(plugin.extension)` method. Used so apps
 * can compose plugin schemas: `defineSchema({...}).extend(authPlugin.extension)`.
 *
 * `extend` is non-mutating — returns a fresh `ExtendableSchema` containing
 * the merged tables. Extension tables are auto-namespaced by the extension
 * `key` (`buckets` → `ratelimit_buckets`), so the merged type carries the
 * prefixed names via {@link PrefixedTables}. Chains:
 * `defineSchema(...).extend(a).extend(b)` is the typed equivalent of merging
 * `a`'s prefixed tables then `b`'s.
 */
type ExtendableSchema<T extends Record<string, TableDefinition>> = {
    extend: <X extends Record<string, TableDefinition>, Key extends string>(
        extension: SchemaExtension<X> & { readonly key: Key },
    ) => ExtendableSchema<PrefixedTables<X, Key> & T>;

    /**
     * Pin every Durable Object the app reaches — shards, fan-out, subscriptions,
     * the scheduler, and `ctx.containers` — to a Cloudflare data-residency
     * jurisdiction (`"eu"`, `"us"`, `"fedramp"`). Codegen reads this off the
     * schema and emits it into the generated worker's `createWorker({ jurisdiction })`
     * (and `ctx.scheduler` / `ctx.containers`). Non-mutating: returns a fresh
     * `ExtendableSchema`, so it composes with `.rls(...)` / `.extend(...)` in any order.
     *
     * ⚠️ **Set this once, before your first deploy — changing or removing it
     * strands data.** A Durable Object name maps to a *different* ID in each
     * jurisdiction, so toggling this on an existing app makes every shard, scheduler
     * job, and session DO resolve to a NEW, empty DO; the previous data stays in the
     * old jurisdiction's DOs and is no longer reachable. There is no in-place
     * migration — you would have to export from the old jurisdiction and import
     * into the new one.
     *
     * Note: this pins **DO-backed** state only. D1-backed state — `.global()`
     * tables and `@lunora/auth` sessions alike — is governed by D1's own location
     * settings, not this option.
     * @see https://developers.cloudflare.com/durable-objects/reference/data-location/
     */
    jurisdiction: (jurisdiction: DurableObjectJurisdiction) => ExtendableSchema<T>;

    /**
     * Turn on secure-by-default RLS for the whole schema. Every table is then
     * protected — the DO/D1 write path denies raw, non-RLS `ctx.db` access, so a
     * procedure that forgets `.use(rls(...))` fails closed. Opt a table out with
     * `.public()`. Non-mutating: returns a fresh `ExtendableSchema` carrying the
     * mode, so `.rls("required")` composes with `.extend(...)` either order.
     */
    rls: (mode: "required") => ExtendableSchema<T>;
} & Schema<T>;

const withExtend = <T extends Record<string, TableDefinition>>(schema: Schema<T>): ExtendableSchema<T> => {
    return {
        ...schema,
        extend<X extends Record<string, TableDefinition>, Key extends string>(
            extension: SchemaExtension<X> & { readonly key: Key },
        ): ExtendableSchema<PrefixedTables<X, Key> & T> {
            return withExtend(mergeSchemaExtension(schema, extension));
        },
        jurisdiction(_jurisdiction: DurableObjectJurisdiction): ExtendableSchema<T> {
            // Authoring-time, type-checked declaration only. The jurisdiction is
            // a worker-side residency concern: codegen reads the literal off the
            // schema AST and emits it into the generated `createWorker({ jurisdiction })`
            // (and `ctx.scheduler`). Nothing reads it off the schema object at
            // runtime, so this returns the schema unchanged.
            return withExtend(schema);
        },
        rls(mode: "required"): ExtendableSchema<T> {
            return withExtend({ ...schema, rlsMode: mode });
        },
    };
};

/**
 * Fill in the `on` field for every inline `.aggregateIndex(...)` /
 * `.rankIndex(...)` decl — the builder stashes `""` because it doesn't
 * know its own table name.
 */
const fillIndexTableNames = (tables: Record<string, TableDefinition>): void => {
    for (const [tableName, table] of Object.entries(tables)) {
        for (const index of table.aggregateIndexes) {
            if (index.on === "") {
                (index as { on: string }).on = tableName;
            }
        }

        for (const index of table.rankIndexes) {
            if (index.on === "") {
                (index as { on: string }).on = tableName;
            }
        }
    }
};

/**
 * Fold standalone aggregate / rank index decls onto their owning table so the
 * runtime can read every index uniformly off `tables[name].*Indexes`.
 */
const attachStandaloneIndexes = (
    tables: Record<string, TableDefinition>,
    aggregateIndexes: Record<string, AggregateIndexDefinition>,
    rankIndexes: Record<string, RankIndexDefinition>,
): void => {
    for (const index of Object.values(aggregateIndexes)) {
        const table = tables[index.on];

        if (!table) {
            throw new LunoraError("INTERNAL", `defineAggregateIndex "${index.name}": unknown table "${index.on}"`);
        }

        (table.aggregateIndexes as AggregateIndexDefinition[]).push(index);
    }

    for (const index of Object.values(rankIndexes)) {
        const table = tables[index.on];

        if (!table) {
            throw new LunoraError("INTERNAL", `defineRankIndex "${index.name}": unknown table "${index.on}"`);
        }

        (table.rankIndexes as RankIndexDefinition[]).push(index);
    }
};

/** The first incremental-only knob set on a `.source()` config, or `undefined` when none are (used to reject them on a full-pull source). */
const strayIncrementalKnob = (source: ExternalSourceDefinition): string | undefined => {
    if (source.cursor) {
        return "cursor";
    }

    if (source.reconcileEveryMs !== undefined) {
        return "reconcileEveryMs";
    }

    if (source.softDeleteColumn !== undefined) {
        return "softDeleteColumn";
    }

    return undefined;
};

/**
 * Validate the `mode` + incremental knobs of one `.source()` (plan 077 / 136):
 * reject an unknown mode; require `cursor` + a delete-visibility path
 * (`reconcileEveryMs`/`softDeleteColumn`) for incremental; reject those knobs on a
 * full-pull source. Throws so a misconfigured source never loads.
 */
const validateExternalSourceMode = (name: string, source: ExternalSourceDefinition): void => {
    const isIncremental = source.mode === "incremental";

    // Reject an unknown mode from untyped JS callers (the typed union is
    // `"full-pull" | "incremental" | undefined`, a compile-time error otherwise).
    if (source.mode !== undefined && source.mode !== "full-pull" && !isIncremental) {
        throw new LunoraError(
            "INTERNAL",
            `defineSchema: table "${name}" uses \`mode: ${JSON.stringify(source.mode)}\` — supported modes are "full-pull" (default) and "incremental".`,
        );
    }

    if (!isIncremental) {
        // The incremental-only knobs are meaningless (and misleading) on a full-pull
        // source — reject them so a mislaid `mode` fails loudly rather than silently
        // ignoring a cursor/reconcile/soft-delete config.
        const strayKnob = strayIncrementalKnob(source);

        if (strayKnob) {
            throw new LunoraError(
                "INTERNAL",
                `defineSchema: table "${name}" sets \`${strayKnob}\` but is not \`mode: "incremental"\` — that knob only applies to incremental ingest. Set \`mode: "incremental"\` or remove \`${strayKnob}\`.`,
            );
        }

        return;
    }

    // Incremental needs a durable watermark: the cursor column + the
    // watermark-parameterized pull query. Without it there is nothing to page from
    // (plan 136 §"No cursor declaration").
    if (!source.cursor?.column || !source.cursor.query) {
        throw new LunoraError(
            "INTERNAL",
            `defineSchema: table "${name}" is \`mode: "incremental"\` but has no \`cursor\` — add \`cursor: { column: "updated_at", query: "… WHERE … > $N" }\` binding the watermark as the trailing parameter.`,
        );
    }

    // Delete visibility: an incremental slice can't observe upstream deletes (absent
    // ≠ deleted), so it MUST declare either a reconcile sweep or a soft-delete
    // tombstone column, else it silently accumulates phantom rows (the
    // `external_source_incremental_no_delete_path` STOP lint mirrors this).
    if (source.reconcileEveryMs === undefined && source.softDeleteColumn === undefined) {
        throw new LunoraError(
            "INTERNAL",
            `defineSchema: table "${name}" is \`mode: "incremental"\` with no delete-visibility path — an incremental pull never sees upstream deletes, so it would accumulate phantom rows. Add \`reconcileEveryMs\` (a periodic full-pull sweep) or \`softDeleteColumn\` (an upstream tombstone column).`,
        );
    }
};

/**
 * Hard-enforce the `.source(...)` invariants at schema-definition time (plan 077).
 * Chain order is arbitrary, so the builder can't see the final `shardMode` when
 * `.source()` runs — the checks live here, where every table is fully assembled.
 * These **throw** (the schema won't load), so the tenant-isolation boundary is a
 * runtime guarantee, not merely the advisor lint's build-time warning.
 */
const validateExternalSources = (tables: Record<string, TableDefinition>): void => {
    for (const [name, table] of Object.entries(tables)) {
        const source = table.externalSource;

        if (!source) {
            continue;
        }

        if (table.shardMode.kind === "global") {
            throw new LunoraError(
                "INTERNAL",
                `defineSchema: table "${name}" cannot be both .source() and .global() — a sourced table materializes into a shard DO's SQLite, a global table lives in the external tier`,
            );
        }

        if (table.shardMode.kind === "shardBy" && !source.tenantBy) {
            throw new LunoraError(
                "INTERNAL",
                `defineSchema: sourced + .shardBy() table "${name}" needs a \`tenantBy\` mapper — without it every tenant's DO would run the same unscoped query and replicate the whole multitenant table (a cross-tenant leak). Add \`tenantBy: (shardKey) => [shardKey]\` binding the shard key into the query's parameters.`,
            );
        }

        validateExternalSourceMode(name, source);
    }
};

const defineSchema = <T extends Record<string, TableDefinition>>(
    tables: T,
    vectorIndexes: Record<string, VectorIndexDefinition> = {},
    aggregateIndexes: Record<string, AggregateIndexDefinition> = {},
    rankIndexes: Record<string, RankIndexDefinition> = {},
): ExtendableSchema<T> => {
    fillIndexTableNames(tables);
    attachStandaloneIndexes(tables, aggregateIndexes, rankIndexes);
    validateExternalSources(tables);

    return withExtend({ tables, vectorIndexes });
};

export { defineAggregateIndex, defineRankIndex, defineSchema, defineTable, defineVectorIndex };

export type {
    AggregateIndexOptions,
    ExtendableSchema,
    InlineAggregateIndexOptions,
    InlineRankIndexOptions,
    ManyRelation,
    OneRelation,
    RankIndexOptions,
    RelationBuilder,
    TableBuilder,
    VectorIndexOptions,
    VectorizeOptions,
};
