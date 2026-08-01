import type { IndexKeyEntry } from "./read-write-set";
import type { SystemDatabaseReader } from "./system-reader";
import type { WhereInput } from "./where-types";

/**
 * Structural schema/writer types shared by the DO, D1, and SQL-store dialects.
 *
 * These are the host-neutral contracts that engine files (query compilation,
 * relation resolution, rank/aggregate planning, etc.) need without taking a
 * dependency on a concrete backend or on `@lunora/server`.
 */

/** Reducer applied by an aggregate index. */
export type AggregateOp = "avg" | "count" | "max" | "min" | "sum";

/** Structural mirror of `@lunora/server`'s `AggregateIndexDefinition`. */
export interface AggregateIndexDefinitionLike {
    readonly by?: ReadonlyArray<string>;
    readonly field?: string;
    readonly name: string;
    readonly on: string;
    readonly op: AggregateOp;
    readonly where?: Record<string, unknown>;
}

/** Structural mirror of `@lunora/server`'s `GeoIndexDefinition`. */
export interface GeoIndexDefinitionLike {
    readonly field: string;
    readonly name: string;
    readonly precision?: number;
}

/** Structural mirror of `@lunora/server`'s `IndexDefinition`. */
export interface IndexDefinitionLike {
    readonly fields: ReadonlyArray<string>;
    readonly name: string;
    readonly unique?: boolean;
}

/** Structural mirror of `@lunora/server`'s `RankIndexDefinition`. */
export interface RankIndexDefinitionLike {
    readonly name: string;
    readonly on: string;
    readonly partitionBy?: ReadonlyArray<string>;
    readonly sortBy: ReadonlyArray<RankSortKeyLike>;
    readonly where?: Record<string, unknown>;
}

export interface SearchIndexDefinitionLike {
    /** Indexed text column; a dot-separated path reads a nested field. */
    readonly field: string;
    readonly filterFields?: ReadonlyArray<string>;
    /** Analysis profile (folding + stopwords) — see `@lunora/server`'s `SearchIndexDefinition`. */
    readonly language?: string;
    readonly name: string;
    /** Skip the migration-time backfill of the search companion — see `@lunora/server`'s `SearchIndexDefinition`. */
    readonly staged?: boolean;
    /** `"native"` opts into the engine's own full-text index where it has one; see `@lunora/server`'s `SearchIndexDefinition`. */
    readonly strategy?: string;
}

/** Auth slice handed to a `.serverDefault(fn)` factory at write time. */
export interface ServerDefaultContextLike {
    readonly auth: {
        readonly identity: Record<string, unknown> | null;
        readonly userId: null | string;
    };
}

/** Column constraints/defaults the write layer honors. */
export interface ColumnMetaLike {
    readonly defaultFn?: () => unknown;
    readonly defaultValue?: unknown;
    readonly notNull?: boolean;
    readonly onUpdateFn?: () => unknown;
    readonly serverDefault?: (context: ServerDefaultContextLike) => unknown;
    readonly unique?: boolean;
}

/** Structural mirror of a validator from `@lunora/values`. */
export interface ValidatorLike {
    readonly _meta?: { readonly column?: ColumnMetaLike };
    readonly kind?: string;
    readonly parse?: (value: unknown) => unknown;
}

/** Lifecycle phase relative to the SQL write. */
export type TriggerTimingLike = "after" | "before";

/** The CRUD operation a trigger reacts to. `patch` and `replace` both map to `update`. */
export type TriggerOpLike = "delete" | "insert" | "update";

/**
 * A schedulable durable-workflow reference — the generated `workflows.&lt;name>` /
 * `agents.&lt;name>` object (carries its `WORKFLOW_*`/`AGENT_*` binding + stable
 * name). Structural mirror so a scheduled target can be a workflow/agent, not
 * just a function path, without this package depending on `@lunora/scheduler`.
 */
export interface SchedulableWorkflowReferenceLike {
    readonly binding?: string;
    readonly isLunoraWorkflow: true;
    readonly name?: string;
}

/**
 * Structural mirror of `@lunora/server`'s `Scheduler` (kept local so this
 * package takes no runtime dependency on the server package).
 */
export interface SchedulerLike {
    runAfter: (delayMs: number, target: SchedulableWorkflowReferenceLike | string, args?: Record<string, unknown>) => Promise<string>;
    runAt: (timestampMs: number, target: SchedulableWorkflowReferenceLike | string, args?: Record<string, unknown>) => Promise<string>;
}

/** What a trigger handler observes about the write that fired it. */
export interface TriggerEventLike {
    /** The new/merged row — present on `insert` and `update`, absent on `delete`. */
    doc?: Record<string, unknown>;
    id: string;
    op: TriggerOpLike;
    /** The pre-write row — present on `update` and `delete`, absent on `insert`. */
    previous?: Record<string, unknown>;
    table: string;
}

/** Handle injected into trigger handlers; built by the backend write layer. */
export interface TriggerContextLike {
    db: DatabaseWriterLike;
    scheduler: SchedulerLike;
}

/** Structural mirror of `@lunora/server`'s `TriggerDefinition`. */
export interface TriggerDefinitionLike {
    readonly handler: (context: TriggerContextLike, event: TriggerEventLike) => Promise<void> | void;
    readonly op: TriggerOpLike;
    readonly timing: TriggerTimingLike;
}

/** Minimal schema projection the RLS guard reads. */
export interface GuardableSchema {
    readonly rlsMode?: "required";
    readonly tables: Record<string, { readonly isPublic?: boolean }>;
}

/** Minimal subset of `@lunora/server`'s `Schema&lt;T>` the adapter reads. */
export interface SchemaLike {
    readonly rlsMode?: "required";
    readonly tables: Record<string, TableDefinitionLike>;
}

/** Structural mirror of `@lunora/server`'s `TableDefinition`. */
export interface TableDefinitionLike {
    readonly aggregateIndexes?: ReadonlyArray<AggregateIndexDefinitionLike>;
    readonly geoIndexes?: ReadonlyArray<GeoIndexDefinitionLike>;
    readonly indexes: ReadonlyArray<IndexDefinitionLike>;
    readonly isPublic?: boolean;
    readonly rankIndexes?: ReadonlyArray<RankIndexDefinitionLike>;
    readonly relationMap?: Record<string, RelationDefinitionLike>;
    readonly searchIndexes?: ReadonlyArray<SearchIndexDefinitionLike>;
    readonly shape: Record<string, ValidatorLike>;
    readonly shardMode?: { field?: string; kind: "global" | "root" | "shardBy" };
    readonly softDeleteMode?: { field: string };
    readonly triggerMap?: Record<string, TriggerDefinitionLike>;
    readonly ttlPolicy?: { after?: number; field: string };
}

/** Structural mirror of `@lunora/server`'s `RelationDefinition`. */
export interface RelationDefinitionLike {
    readonly field: string;
    readonly kind: "many" | "one";
    readonly onDelete?: OnDeleteActionLike;
    readonly references: string;
    readonly table: string;
}

export type OnDeleteActionLike = "cascade" | "restrict" | "set null";

/** Per-relation refinements: filter / order / cap / project / recurse. */
export interface NestedWith {
    limit?: number;
    orderBy?: OrderByInput[];
    select?: ReadonlyArray<string>;
    where?: WhereInput;
    with?: WithInput;
}

/** The `with` argument for relation loading. */
export interface WithInput {
    [relationName: string]: NestedWith | Record<string, true> | boolean | undefined;
    _count?: Record<string, true>;
}

export interface ApplyOnDeleteOptions {
    database: DatabaseWriterLike;
    relation: RelationDefinitionLike;
    row: Record<string, unknown>;
    tableName: string;
}

export interface ResolveWithOptions {
    fetcher: (tableName: string, args: QueryArgs) => Promise<QueryPage>;
    groupedCounter: (tableName: string, whereField: string, values: unknown[], policyWhere?: WhereInput) => Promise<Map<unknown, number>>;
    parents: Record<string, unknown>[];
    relationBaseWhere?: (table: string) => undefined | WhereInput;
    schema: { readonly tables: Record<string, TableDefinitionLike> };
    tableName: string;
    with: WithInput;
}

export interface ResolveWithResult {
    parent: Record<string, unknown>;
    relationName: string;
    rows: Record<string, unknown>[];
}

export type SortDirection = "asc" | "desc";

/** A single `{ field: "asc" | "desc" }` entry; `orderBy` is an ordered list of these. */
export type OrderByInput = Record<string, SortDirection>;

export interface QueryArgs {
    baseWhere?: WhereInput;
    cursor?: null | string;
    includeDeleted?: boolean;
    limit?: number;
    orderBy?: OrderByInput[];
    relationBaseWhere?: (table: string) => undefined | WhereInput;
    restrictsCounts?: boolean;
    select?: ReadonlyArray<string>;
    where?: WhereInput;
    with?: WithInput;
}

export interface QueryPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Record<string, unknown>[];
    splitCursor?: null | string;
}

export interface OrderKey {
    direction: SortDirection;
    field: string;
}

/** Query-options shape shared by every aggregate reader. */
export interface RestrictableQueryOptions {
    baseWhere?: WhereInput;
    relationBaseWhere?: (table: string) => undefined | WhereInput;
    restrictsCounts?: boolean;
    where?: WhereInput;
}

/** Args for `DatabaseWriterLike.aggregate`. */
export interface AggregateOptions extends RestrictableQueryOptions {
    field?: string;
    op: AggregateOp;
}

/** Result of `aggregate` — the scalar reduction, or `null` when no rows matched. */
export type AggregateResult = null | number;

/** Args for `DatabaseWriterLike.groupBy`. */
export interface GroupByOptions extends RestrictableQueryOptions {
    agg?: { field?: string; op: AggregateOp };
    by: ReadonlyArray<string>;
}

/** Result of `groupBy` — one entry per distinct group tuple. */
export interface GroupByEntry {
    key: Record<string, unknown>;
    value: AggregateResult;
}

export type RankDirection = "asc" | "desc";

export interface RankSortKeyLike {
    readonly direction: RankDirection;
    readonly field: string;
}

/** 1-based position within a partition under the declared sort, plus the partition's row total. */
export interface RankResult {
    position: number;
    total: number;
}

export interface RankOptions extends RestrictableQueryOptions {
    row: Record<string, unknown> | string;
}

export interface RankBeforeOptions {
    partitionKey: string;
    restrictsCounts?: boolean;
    rowId: string;
    sortValues: ReadonlyArray<unknown>;
}

export interface RankBeforeResult {
    before: number;
    total: number;
}

export interface RankPageOptions extends RestrictableQueryOptions {
    after?: RankPageRowKey;
    cursor?: null | string;
    partitionKey?: string;
    take?: number;
}

export interface RankPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Record<string, unknown>[];
}

export interface RankPageRowKey {
    partitionKey: string;
    rowId: string;
    sortValues: ReadonlyArray<unknown>;
}

export interface RankPageRow {
    doc: Record<string, unknown>;
    key: RankPageRowKey;
}

export interface ShardRankPageResult {
    directions: ReadonlyArray<RankDirection>;
    hasMore: boolean;
    rows: ReadonlyArray<RankPageRow>;
}

/** Options accepted by `TableReaderLike.paginate` — Convex-compatible. */
export interface PaginationOptions {
    cursor?: null | string;
    endCursor?: null | string;
    numItems: number;
}

/** Builder for search-index filters. */
export interface SearchFilterBuilderLike {
    eq: (field: string, value: unknown) => SearchFilterBuilderLike;
    search: (field: string, query: string) => SearchFilterBuilderLike;
}

/** Builder for geo-index filters. */
export interface GeoFilterBuilderLike {
    near: (point: { lat: number; lng: number }, radiusMeters: number) => GeoFilterBuilderLike;
    within: (box: { ne: { lat: number; lng: number }; sw: { lat: number; lng: number } }) => GeoFilterBuilderLike;
}

/**
 * One row of a `.collectWithScores()` result — the document paired with the
 * ranking value the read already computed to order it. `score` (FTS
 * relevance, higher is better) is populated for a `.withSearchIndex()` chain;
 * `distanceMeters` (haversine distance from `.near()`'s point) for a
 * `.withGeoIndex()` chain. `.within()` box matches have no point-distance
 * metric, so `distanceMeters` is `null` for those rows rather than a
 * misleading `0`. The two fields are mutually exclusive per call — which one
 * is populated depends on which index the chain staged.
 */
export interface ScoredDocument {
    distanceMeters?: null | number;
    document: Record<string, unknown>;
    score?: number;
}

/** A `ctx.db.&lt;table>` reader facade. */
export interface TableReaderLike {
    /** Lazy row iteration — see the implementation note in `ctx-db.ts`. */
    [Symbol.asyncIterator]: () => AsyncIterator<Record<string, unknown>>;
    collect: () => Promise<Record<string, unknown>[]>;

    /**
     * Like `.collect()`, but pairs each row with the relevance score /
     * distance the read already computed to order it — see
     * {@link ScoredDocument}. Requires a staged `.withSearchIndex()` or
     * `.withGeoIndex()`; throws otherwise (mirrors `.paginate()`'s
     * geo-unsupported guard).
     */
    collectWithScores: () => Promise<ScoredDocument[]>;
    filter: (predicate: (document: Record<string, unknown>) => boolean) => TableReaderLike;
    first: () => Promise<Record<string, unknown> | null>;
    order: (direction: "asc" | "desc") => TableReaderLike;
    paginate: (options: PaginationOptions) => Promise<QueryPage>;
    take: (limit: number) => Promise<Record<string, unknown>[]>;
    unique: () => Promise<Record<string, unknown> | null>;
    withGeoIndex: (indexName: string, build: (q: GeoFilterBuilderLike) => GeoFilterBuilderLike) => TableReaderLike;
    withIndex: (indexName: string, range?: (q: IndexRangeBuilderLike) => IndexRangeBuilderLike) => TableReaderLike;
    withSearchIndex: (indexName: string, search: (q: SearchFilterBuilderLike) => SearchFilterBuilderLike) => TableReaderLike;
}

/** Builder for index range scans. */
export interface IndexRangeBuilderLike {
    eq: (field: string, value: unknown) => IndexRangeBuilderLike;
    gt: (field: string, value: unknown) => IndexRangeBuilderLike;
    gte: (field: string, value: unknown) => IndexRangeBuilderLike;
    lt: (field: string, value: unknown) => IndexRangeBuilderLike;
    lte: (field: string, value: unknown) => IndexRangeBuilderLike;
}

/** Notifies hibernated subscribers that a row in `table` changed. */
export type BroadcastDelta = (delta: MutationDelta) => void;

/** Records that a query touched `table`. */
export type ReadHook = (table: string, idOrScan?: string) => void;

/** The argument a connection-lifecycle hook receives. */
export interface LifecycleEvent {
    connectionId: string;
    context?: Record<string, unknown>;
    shardKey: string;
    userId: string | null;
}

/** Per-socket lifecycle dispatch payload. */
export interface LifecycleDispatchInfo {
    event: LifecycleEvent;
    identity: Record<string, unknown> | undefined;
    userId: string | undefined;
}

/** Per-row change notification emitted by the CDC layer. */
export interface MutationDelta {
    /**
     * Index positions the written row occupies, unioned across its BEFORE and
     * AFTER images. Computed once on the write path (which is the only place
     * that still holds the before-image) so consumers never re-derive it —
     * a consumer working from `row` alone sees only the destination, and would
     * miss a subscriber watching the slice the row just LEFT.
     */
    indexKeys?: ReadonlyArray<IndexKeyEntry>;
    key: string;
    op: "insert" | "update" | "delete";
    row?: Record<string, unknown>;
    table: string;
}

/** Structural surface the RLS guard wraps. */
export interface DatabaseWriterLike {
    aggregate: (tableName: string, options: AggregateOptions) => Promise<AggregateResult>;
    asId?: (tableName: string, id: string) => string;
    count: (tableName: string, where?: RestrictableQueryOptions | WhereInput) => Promise<number>;
    delete: (id: string, expectedTable?: string, options?: { hard?: boolean }) => Promise<void>;
    deleteAll?: (tableName: string, options?: { chunkSize?: number; hard?: boolean }) => Promise<{ deleted: number }>;
    deleteMany?: (ids: ReadonlyArray<string>, options?: { limit?: number }, expectedTable?: string) => Promise<{ deleted: number }>;
    deleteWhere?: (tableName: string, where: WhereInput, options?: { limit?: number }) => Promise<{ deleted: number }>;
    findFirst: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown> | null>;
    findFirstOrThrow: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown>>;
    findMany: (tableName: string, args?: QueryArgs) => Promise<QueryPage>;
    get: (id: string, expectedTable?: string) => Promise<Record<string, unknown> | null>;
    groupBy: (tableName: string, options: GroupByOptions) => Promise<ReadonlyArray<GroupByEntry>>;
    insert: (tableName: string, document: Record<string, unknown>, options?: { allowExplicitId?: boolean; clientId?: string }) => Promise<string>;
    insertMany?: (
        tableName: string,
        documents: ReadonlyArray<Record<string, unknown>>,
        options?: { limit?: number; skipDuplicates?: boolean },
    ) => Promise<(string | null)[]>;
    insertManyUnsafe?: (
        tableName: string,
        documents: ReadonlyArray<Record<string, unknown>>,
        options?: { allowExplicitId?: boolean; limit?: number },
    ) => Promise<string[]>;
    lookupById?: (id: string, expectedTable?: string) => Promise<null | { row: Record<string, unknown>; tableName: string }>;
    normalizeId: (tableName: string, id: string) => null | string;
    patch: (id: string, patch: Record<string, unknown>, expectedTable?: string) => Promise<void>;
    patchMany?: (
        patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>,
        options?: { limit?: number },
        expectedTable?: string,
    ) => Promise<{ patched: number }>;
    patchWhere?: (tableName: string, args: { patch: Record<string, unknown>; where: WhereInput }, options?: { limit?: number }) => Promise<{ patched: number }>;
    query: (tableName: string) => TableReaderLike;
    rank: (tableName: string, indexName: string, options: RankOptions) => Promise<null | RankResult>;
    rankBefore?: (tableName: string, indexName: string, options: RankBeforeOptions) => Promise<RankBeforeResult>;
    rankPage: (tableName: string, indexName: string, options?: RankPageOptions) => Promise<RankPage>;
    rankPageRows?: (tableName: string, indexName: string, options?: RankPageOptions) => Promise<ShardRankPageResult>;
    replace: (id: string, document: Record<string, unknown>, expectedTable?: string, options?: { allowExplicitId?: boolean }) => Promise<void>;
    restore?: (id: string, expectedTable?: string) => Promise<void>;

    /**
     * The system-table reader.
     *
     * Typed as `unknown` until the engine extraction completed: `system-reader`
     * lived in `@lunora/do` while this file was already here, so naming it would
     * have inverted the dependency. Both are in this package now, so the real
     * type applies and callers stop asserting their way past it.
     */
    system?: SystemDatabaseReader;
    wipeShard?: (options?: { chunkSize?: number; exclude?: ReadonlyArray<string>; tables?: ReadonlyArray<string> }) => Promise<{
        deleted: number;
        tables: Record<string, number>;
    }>;
}
