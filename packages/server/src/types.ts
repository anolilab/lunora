import type { Id, Infer, Validator } from "@cirrus/values";

// Cache the namespace proxies and the per-function reference objects so that
// `api.foo.bar` returns the *same* object on every access. React hooks
// (`useMutation`, `useQuery`) put the reference in dependency arrays; a fresh
// identity per render would re-run effects every render and loop forever.
const namespaceCache = new Map<PropertyKey, Record<string, unknown>>();

/** Map of validators describing a function's args record. */
type ArgsValidator = Record<string, Validator>;

/** Infer the args object type from an {@link ArgsValidator}. */
type InferArgs<A extends ArgsValidator> = {
    [K in keyof A as undefined extends Infer<A[K]> ? K : never]?: Infer<A[K]>;
} & { [K in keyof A as undefined extends Infer<A[K]> ? never : K]: Infer<A[K]> };

/** How a table is routed at runtime. */
type ShardMode = { kind: "global" } | { field: string; kind: "shardBy" } | { kind: "root" };

interface IndexDefinition {
    fields: ReadonlyArray<string>;
    name: string;
    unique?: boolean;
}

interface SearchIndexDefinition {
    field: string;
    filterFields?: ReadonlyArray<string>;
    name: string;
}

/** Reducer applied by an aggregate index. */
type AggregateOp = "avg" | "count" | "max" | "min" | "sum";

/**
 * Declared aggregate index — the schema-level seam that lets the runtime keep
 * O(1) counters/sums in step with row writes (via the trigger runner) and
 * route matching reads through them.
 *
 * - `on` — the table whose rows feed the aggregate.
 * - `op` — the reducer. `count` is field-less; the others take `field`.
 * - `field` — the column the reducer applies to (required for non-count ops).
 * - `by` — group keys. When all `where` keys in a read participate in `by`, the
 * reader can answer from the counter table without scanning rows.
 * - `where` — optional static predicate baked into the counter (only the rows
 * matching it ever land in the counter).
 */
interface AggregateIndexDefinition {
    by?: ReadonlyArray<string>;
    field?: string;
    name: string;
    on: string;
    op: AggregateOp;
    where?: Record<string, unknown>;
}

/**
 * One ordering key on a `rankIndex.sortBy`: which column to sort by, and the
 * direction. The runtime breaks ties on the row's `_id` ASC so the order is
 * total and `rank()` always returns a deterministic 1-based position.
 */
interface RankSortKey {
    direction: "asc" | "desc";
    field: string;
}

/**
 * Declared rank index — a sorted companion table per `(partition tuple, sortBy)`
 * maintained by triggers, so:
 *
 * - `rank(row)` returns the row's 1-based position within its partition under
 * the declared `sortBy` order, plus the partition's total row count, in
 * O(log n) lookups against the SQLite btree on the companion table.
 * - `rankPage({ where, take, from })` walks the same companion table to return
 * rows in the declared order — a sorted-pagination accelerator.
 *
 * Fields mirror `AggregateIndexDefinition`:
 *
 * - `on` — the source table whose rows feed the rank.
 * - `sortBy` — ordered keys driving the rank. Required.
 * - `partitionBy` — columns that scope each rank context (e.g. `["channelId"]`
 * to rank within a channel). Omitted ⇒ one global rank across the table.
 * - `where` — static predicate baked into the index; only matching rows enter.
 */
interface RankIndexDefinition {
    name: string;
    on: string;
    partitionBy?: ReadonlyArray<string>;
    sortBy: ReadonlyArray<RankSortKey>;
    where?: Record<string, unknown>;
}

/** FK behavior when a referenced parent row is deleted (mirrors SQL `ON DELETE`). */
type OnDeleteAction = "cascade" | "restrict" | "set null";

/**
 * A declared relation between two tables, recorded by `.relations((r) => …)`.
 *
 * - `one` (many-to-one): the FK column `field` lives on **this** table and
 * points at `table`.`references` (default `_id`). Loads a single doc.
 * - `many` (one-to-many): the FK column `field` lives on the **target** table
 * and points back at this table's `references` (default `_id`). Loads an array.
 *
 * `onDelete` is meaningful only on `one`: it is the action applied to the
 * holder rows when the referenced parent row is deleted.
 */
interface RelationDefinition {
    field: string;
    kind: "many" | "one";
    onDelete?: OnDeleteAction;
    references: string;
    table: string;
}

/** Distance metric used by a Vectorize index. */
type VectorMetric = "cosine" | "dot-product" | "euclidean";

/**
 * Bring-your-own-embedder: a user-supplied fn turning a source string into a
 * numeric vector. The runtime calls it at upsert/query time so the framework
 * never couples to a single embedding provider.
 */
type VectorEmbedder = (input: string) => Promise<ReadonlyArray<number>> | ReadonlyArray<number>;

/**
 * Vector index declared inline on a table via `.vectorize(field, opts)`
 * (DSL Shape A). The source is always a single column on the owning table.
 */
interface TableVectorIndex {
    dimensions: number;
    embed: VectorEmbedder;
    field: string;
    metadata?: ReadonlyArray<string>;
    metric: VectorMetric;
    name: string;
}

interface TableDefinition<Shape extends Record<string, Validator> = Record<string, Validator>> {
    /**
     * Aggregate indexes declared via `.aggregateIndex(name, opts)`. The runtime
     * maintains a counter row per `by` group via the trigger seam, so reads
     * whose `where` keys all participate in the index's `by` set are answered
     * without scanning the underlying table.
     */
    aggregateIndexes: ReadonlyArray<AggregateIndexDefinition>;
    indexes: ReadonlyArray<IndexDefinition>;

    /**
     * Rank indexes declared via `.rankIndex(name, opts)`. The runtime maintains
     * a sorted companion table per declared rank with a btree on
     * `(partition, sortBy)` so `rank(row)` returns the row's 1-based position
     * within its partition in O(log n), and `rankPage()` walks the index for
     * sorted pagination.
     */
    rankIndexes: ReadonlyArray<RankIndexDefinition>;

    /**
     * Declared relations keyed by accessor name; empty unless `.relations()`
     * was called. Named `relationMap` (not `relations`) so the fluent
     * `.relations((r) => …)` builder method doesn't collide with this field.
     */
    relationMap: Record<string, RelationDefinition>;
    searchIndexes: ReadonlyArray<SearchIndexDefinition>;
    shape: Shape;
    shardMode: ShardMode;

    /**
     * Declared lifecycle triggers keyed by accessor name; empty unless
     * `.triggers()` was called. Named `triggerMap` (not `triggers`) so the
     * fluent `.triggers((t) => …)` builder method doesn't collide with this
     * field — same reasoning as {@link TableDefinition.relationMap}.
     */
    triggerMap: Record<string, TriggerDefinition>;
    vectorIndexes: ReadonlyArray<TableVectorIndex>;
}

/**
 * Standalone vector index declared via `defineVectorIndex(...)` (DSL Shape B).
 * Unlike {@link TableVectorIndex}, the source is a `select` function so it can
 * derive the embedded text from any computation (e.g. `title + body`).
 */
interface VectorIndexDefinition {
    readonly dimensions: number;
    readonly embed: VectorEmbedder;
    readonly kind: "vectorIndex";
    readonly metadata?: (row: Record<string, unknown>) => Record<string, unknown>;
    readonly metric: VectorMetric;
    readonly select: (row: Record<string, unknown>) => string;
    readonly table: string;
}

interface Schema<T extends Record<string, TableDefinition> = Record<string, TableDefinition>> {
    readonly tables: T;
    readonly vectorIndexes: Record<string, VectorIndexDefinition>;
}

// --- Function registration ---------------------------------------------------

type FunctionKind = "action" | "mutation" | "query" | "stream";

/**
 * Call surface a function is exposed on. `public` functions are reachable from
 * clients via the generated `api`; `internal` functions are reachable only
 * server-to-server (`ctx.runQuery`/`runMutation`/`runAction`) and are rejected
 * by the DO's external RPC path. Absence is treated as `public` for
 * back-compat with functions registered before visibility existed.
 */
type FunctionVisibility = "internal" | "public";

interface RegisteredFunction<A extends ArgsValidator, R, Kind extends FunctionKind> {
    readonly args: A;
    readonly handler: (context: unknown, args: InferArgs<A>) => Promise<R> | R;
    readonly kind: Kind;
    readonly visibility?: FunctionVisibility;
}

type RegisteredQuery<A extends ArgsValidator, R> = RegisteredFunction<A, R, "query">;
type RegisteredMutation<A extends ArgsValidator, R> = RegisteredFunction<A, R, "mutation">;
type RegisteredAction<A extends ArgsValidator, R> = RegisteredFunction<A, R, "action">;

/**
 * A streaming query registration. Unlike {@link RegisteredFunction} the handler
 * returns an `AsyncIterable&lt;R>` synchronously (it does NOT `Promise&lt;R>`); the
 * runtime drives it frame by frame and forwards each chunk to the caller. The
 * third `signal` argument is wired to the caller's cancel signal so the handler
 * can stop early — break out of the loop or check `signal.aborted` between
 * yields.
 */
interface RegisteredStream<A extends ArgsValidator, R> {
    readonly args: A;
    readonly handler: (context: unknown, args: InferArgs<A>, signal: AbortSignal) => AsyncIterable<R>;
    readonly kind: "stream";
    readonly visibility?: FunctionVisibility;
}

// --- Context types -----------------------------------------------------------

/**
 * Read-only handle bound to a table. Used by `query`/`mutation`/`action`. The
 * actual SQL implementation lives in `@cirrus/do`; these are signatures only.
 */
interface DatabaseReader {
    get: <T extends string>(id: Id<T>) => Promise<Record<string, unknown> | null>;
    query: (tableName: string) => TableReader;
}

/** Options for {@link TableReader.paginate} — Convex-compatible page request. */
interface PaginationOptions {
    /** Opaque cursor from the prior page's `continueCursor`; `null`/omitted starts at the first page. */
    cursor?: null | string;
    /** Maximum rows to return for this page. */
    numItems: number;
}

/** One page of a keyset-paginated query. */
interface PaginationResult<T = Record<string, unknown>> {
    /** Cursor to pass back for the next page, or `null` once `isDone`. */
    continueCursor: null | string;
    /** `true` when this page is the last one. */
    isDone: boolean;
    page: T[];
}

interface TableReader {
    collect: () => Promise<Record<string, unknown>[]>;
    filter: (predicate: (document: Record<string, unknown>) => boolean) => TableReader;
    first: () => Promise<Record<string, unknown> | null>;
    paginate: (options: PaginationOptions) => Promise<PaginationResult>;
    take: (limit: number) => Promise<Record<string, unknown>[]>;
    withIndex: (indexName: string, range?: (q: IndexRangeBuilder) => IndexRangeBuilder) => TableReader;

    /**
     * Restrict the query to a declared `.searchIndex()`. The builder's
     * `.search(field, query)` runs a full-text match against the index's
     * searchable field; `.eq(field, value)` narrows by a declared filter
     * field. Results come back ordered by relevance — pair with `.take(n)`
     * (`.paginate()` is not supported on a search query).
     */
    withSearchIndex: (indexName: string, search: (q: SearchFilterBuilder) => SearchFilterBuilder) => TableReader;
}

interface IndexRangeBuilder {
    eq: (field: string, value: unknown) => IndexRangeBuilder;
    gt: (field: string, value: unknown) => IndexRangeBuilder;
    gte: (field: string, value: unknown) => IndexRangeBuilder;
    lt: (field: string, value: unknown) => IndexRangeBuilder;
    lte: (field: string, value: unknown) => IndexRangeBuilder;
}

/** Builder passed to {@link TableReader.withSearchIndex}; mirrors Convex's search query. */
interface SearchFilterBuilder {
    /** Narrow by a declared filter field (exact match). */
    eq: (field: string, value: unknown) => SearchFilterBuilder;
    /** Full-text match `query` against the index's searchable `field`. Call exactly once. */
    search: (field: string, query: string) => SearchFilterBuilder;
}

interface DatabaseWriter extends DatabaseReader {
    delete: <T extends string>(id: Id<T>) => Promise<void>;
    insert: <T extends string>(tableName: T, document: Record<string, unknown>) => Promise<Id<T>>;
    patch: <T extends string>(id: Id<T>, patch: Record<string, unknown>) => Promise<void>;
    replace: <T extends string>(id: Id<T>, document: Record<string, unknown>) => Promise<void>;
}

/** Authenticated identity surfaced into every context. */
interface AuthState {
    getIdentity: () => Promise<Record<string, unknown> | null>;
    readonly userId: string | null;
}

interface Scheduler {
    runAfter: (delayMs: number, functionPath: string, args?: Record<string, unknown>) => Promise<string>;
    runAt: (timestampMs: number, functionPath: string, args?: Record<string, unknown>) => Promise<string>;
}

// --- Lifecycle triggers ------------------------------------------------------

/** Lifecycle phase relative to the SQL write. */
type TriggerTiming = "after" | "before";

/** The CRUD operation a trigger reacts to. `patch` and `replace` both map to `update`. */
type TriggerOp = "delete" | "insert" | "update";

/**
 * A row as observed by a trigger handler: the table's `Shape` (with the same
 * optionality rules as {@link InferArgs}) plus the system columns every stored
 * doc carries.
 */
type TriggerRow<Shape extends Record<string, Validator>> = { [K in keyof Shape as undefined extends Infer<Shape[K]> ? K : never]?: Infer<Shape[K]> } & {
    [K in keyof Shape as undefined extends Infer<Shape[K]> ? never : K]: Infer<Shape[K]>;
} & {
    readonly _creationTime: number;
    readonly _id: string;
};

/** What an `insert` trigger observes: the freshly written row. */
interface TriggerInsertEvent<Shape extends Record<string, Validator> = Record<string, Validator>> {
    readonly doc: TriggerRow<Shape>;
    readonly id: string;
    readonly op: "insert";
    readonly table: string;
}

/**
 * What an `update` trigger observes: the merged row plus the pre-write row.
 * `previous` is typed as always present (the row must exist to be updated); the
 * runtime supplies it best-effort and only omits it in the unreachable
 * row-vanished-mid-write case.
 */
interface TriggerUpdateEvent<Shape extends Record<string, Validator> = Record<string, Validator>> {
    readonly doc: TriggerRow<Shape>;
    readonly id: string;
    readonly op: "update";
    readonly previous: TriggerRow<Shape>;
    readonly table: string;
}

/**
 * What a `delete` trigger observes: the row about to be (or just) removed.
 * `previous` is typed as always present; the runtime supplies it best-effort
 * and only omits it in the unreachable row-vanished-mid-write case.
 */
interface TriggerDeleteEvent<Shape extends Record<string, Validator> = Record<string, Validator>> {
    readonly id: string;
    readonly op: "delete";
    readonly previous: TriggerRow<Shape>;
    readonly table: string;
}

/** Union of every trigger event, with the table `Shape` erased (as stored in `triggerMap`). */
type TriggerEvent = TriggerDeleteEvent | TriggerInsertEvent | TriggerUpdateEvent;

/** Page returned by {@link TriggerDatabase.findMany}; mirrors `@cirrus/do`'s `QueryPage`. */
interface TriggerQueryPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Record<string, unknown>[];
}

/** Args accepted by {@link TriggerDatabase} reads; mirrors `@cirrus/do`'s `QueryArgs`. */
interface TriggerQueryArgs {
    cursor?: null | string;
    limit?: number;
    orderBy?: ReadonlyArray<unknown>;
    where?: Record<string, unknown>;
    with?: Record<string, unknown>;
}

/**
 * Args accepted by {@link TriggerDatabase.aggregate} — structural mirror of
 * `@cirrus/do`'s `AggregateOptions`, kept local so trigger handlers in
 * `@cirrus/server` don't take a hard dep on the DO runtime.
 */
interface TriggerAggregateOptions {
    baseWhere?: Record<string, unknown>;
    field?: string;
    op: AggregateOp;
    restrictsCounts?: boolean;
    where?: Record<string, unknown>;
}

/** Args accepted by {@link TriggerDatabase.groupBy}. */
interface TriggerGroupByOptions {
    agg?: { field?: string; op: AggregateOp };
    baseWhere?: Record<string, unknown>;
    by: ReadonlyArray<string>;
    restrictsCounts?: boolean;
    where?: Record<string, unknown>;
}

/** One entry returned by {@link TriggerDatabase.groupBy}. */
interface TriggerGroupByEntry {
    key: Record<string, unknown>;
    value: null | number;
}

/** Args accepted by {@link TriggerDatabase.rank}. */
interface TriggerRankOptions {
    baseWhere?: Record<string, unknown>;
    restrictsCounts?: boolean;
    /** Either the row id or the full row document. */
    row: Record<string, unknown> | string;
    where?: Record<string, unknown>;
}

/** Result of {@link TriggerDatabase.rank} — 1-based position + partition total. */
interface TriggerRankResult {
    position: number;
    total: number;
}

/** Args accepted by {@link TriggerDatabase.rankPage}. */
interface TriggerRankPageOptions {
    baseWhere?: Record<string, unknown>;
    cursor?: null | string;
    take?: number;
    where?: Record<string, unknown>;
}

/**
 * Portable, table/id-addressed ORM writer handed to trigger handlers via
 * `ctx.db`. Mirrors `@cirrus/do`'s runtime `DatabaseWriterLike` surface — it is
 * **not** the generated per-table `ctx.db.&lt;table>` facade (which can't be typed
 * from inside `defineTable`, where the full schema isn't known).
 *
 * `aggregate`/`groupBy`/`count`/`rank`/`rankPage` route through the same
 * trigger-maintained counter and rank tables the user-facing reader uses, so
 * a handler's `ctx.db.&lt;table>.aggregate(...)` observes the just-staged write
 * within the same DO transaction (the counter step happens before the trigger
 * fires).
 */
interface TriggerDatabase {
    aggregate: (tableName: string, options: TriggerAggregateOptions) => Promise<null | number>;
    count: (tableName: string, where?: Record<string, unknown>) => Promise<number>;
    delete: (id: string) => Promise<void>;
    findFirst: (tableName: string, args?: TriggerQueryArgs) => Promise<Record<string, unknown> | null>;
    findMany: (tableName: string, args?: TriggerQueryArgs) => Promise<TriggerQueryPage>;
    get: (id: string) => Promise<Record<string, unknown> | null>;
    groupBy: (tableName: string, options: TriggerGroupByOptions) => Promise<ReadonlyArray<TriggerGroupByEntry>>;
    insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
    patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
    rank: (tableName: string, indexName: string, options: TriggerRankOptions) => Promise<null | TriggerRankResult>;
    rankPage: (tableName: string, indexName: string, options?: TriggerRankPageOptions) => Promise<TriggerQueryPage>;
    replace: (id: string, document: Record<string, unknown>) => Promise<void>;
}

/**
 * Handle injected into every trigger handler. `db` is the portable ORM writer;
 * `scheduler` enqueues async / cross-shard follow-up work (cross-shard work is
 * **not** transactional with the firing write).
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- public API name re-exported by src/index.ts; renaming would break consumers
interface TriggerCtx {
    readonly db: TriggerDatabase;
    readonly scheduler: Scheduler;
}

/** A user-declared trigger handler. Throwing from a `before*` handler aborts the write. */
type TriggerHandler<Event> = (context: TriggerCtx, event: Event) => Promise<void> | void;

/**
 * A single declared trigger, as stored in {@link TableDefinition.triggerMap}.
 * The handler's event type is erased to the {@link TriggerEvent} union here; the
 * per-op {@link TriggerBuilder} methods recover the precise event type for
 * authors.
 */
interface TriggerDefinition {
    readonly handler: TriggerHandler<TriggerEvent>;
    readonly op: TriggerOp;
    readonly timing: TriggerTiming;
}

/**
 * The `t` argument passed to `.triggers((t) => …)`. Each method binds a handler
 * to one `timing`+`op` pair, typing the event against the table's `Shape`.
 */
interface TriggerBuilder<Shape extends Record<string, Validator> = Record<string, Validator>> {
    afterDelete: (handler: TriggerHandler<TriggerDeleteEvent<Shape>>) => TriggerDefinition;
    afterInsert: (handler: TriggerHandler<TriggerInsertEvent<Shape>>) => TriggerDefinition;
    afterUpdate: (handler: TriggerHandler<TriggerUpdateEvent<Shape>>) => TriggerDefinition;
    beforeDelete: (handler: TriggerHandler<TriggerDeleteEvent<Shape>>) => TriggerDefinition;
    beforeInsert: (handler: TriggerHandler<TriggerInsertEvent<Shape>>) => TriggerDefinition;
    beforeUpdate: (handler: TriggerHandler<TriggerUpdateEvent<Shape>>) => TriggerDefinition;
}

/**
 * Read-only projection of `Storage` exposed on `QueryCtx` / `MutationCtx`.
 *
 * Queries are pure reads, and mutations run inside a transactional scope —
 * neither is allowed to perform side-effectful R2 writes (`upload`) or
 * deletes (`delete`). They can, however, **read** existing objects and
 * resolve signed URLs (the URL signing itself is HMAC-only — no R2 round
 * trip), so the read-only surface keeps `download` and `getSignedUrl`. The
 * full {@link Storage} surface stays on `ActionCtx`.
 */
interface ReadOnlyStorage {
    /** Fetch the body of an existing object. Returns `null` when absent. */
    download: (key: string) => Promise<ReadableStream | null>;
    /** Resolve a short-lived signed URL for an existing object. */
    getSignedUrl: (key: string, options?: { expiresInSeconds?: number }) => Promise<string>;
    /** Public URL pointing at the configured base for `key`. */
    getUrl: (key: string) => string;
}

interface Storage extends ReadOnlyStorage {
    delete: (key: string) => Promise<void>;
}

interface VectorMatch {
    id: string;
    metadata?: Record<string, unknown>;
    score: number;
}

interface VectorMatches {
    count: number;
    matches: ReadonlyArray<VectorMatch>;
}

interface VectorQueryInput {
    /** Embedder used when `input` is supplied instead of a precomputed `vector`. */
    embed?: VectorEmbedder;
    filter?: Record<string, unknown>;
    /** Natural-language input embedded via `embed`. Ignored when `vector` is set. */
    input?: string;
    namespace?: string;
    topK?: number;
    /** Precomputed query vector; skips `embed`. */
    vector?: ReadonlyArray<number>;
}

interface VectorUpsertInput {
    embed: VectorEmbedder;
    id: string;
    input: string;
    metadata?: Record<string, unknown>;
    namespace?: string;
}

interface VectorRecord {
    id: string;
    metadata?: Record<string, unknown>;
    values: ReadonlyArray<number>;
}

/**
 * Read-only vector surface exposed on {@link QueryCtx}. Mirrors the read half
 * of `@cirrus/vectors`' `CirrusVectors` so the live adapter is assignable.
 */
interface VectorSearchReader {
    getByIds: (indexName: string, ids: ReadonlyArray<string>) => Promise<ReadonlyArray<VectorRecord>>;
    query: (indexName: string, input: VectorQueryInput) => Promise<VectorMatches>;
}

/**
 * Mutating vector surface on {@link MutationCtx} / {@link ActionCtx}. `upsert`
 * is queued post-commit by default; `upsertNow` forces a synchronous write.
 * `db.delete` on a vectorized table auto-propagates the matching `deleteByIds`.
 */
interface VectorSearch extends VectorSearchReader {
    deleteByIds: (indexName: string, ids: ReadonlyArray<string>) => Promise<void>;
    upsert: (indexName: string, input: VectorUpsertInput) => Promise<void>;
    upsertNow: (indexName: string, input: VectorUpsertInput) => Promise<void>;
}

// eslint-disable-next-line unicorn/prevent-abbreviations -- public API name re-exported by src/index.ts; renaming would break consumers
interface QueryCtx {
    readonly auth: AuthState;
    readonly db: DatabaseReader;
    readonly storage: ReadOnlyStorage;
    readonly vectors: VectorSearchReader;
}

// eslint-disable-next-line unicorn/prevent-abbreviations -- public API name re-exported by src/index.ts; renaming would break consumers
interface MutationCtx {
    readonly auth: AuthState;
    readonly db: DatabaseWriter;
    readonly scheduler: Scheduler;
    readonly storage: ReadOnlyStorage;
    readonly vectors: VectorSearch;
}

// eslint-disable-next-line unicorn/prevent-abbreviations -- public API name re-exported by src/index.ts; renaming would break consumers
interface ActionCtx {
    readonly auth: AuthState;
    readonly db: DatabaseWriter;
    readonly fetch: typeof globalThis.fetch;
    readonly runAction: <A extends ArgsValidator, R>(reference: RegisteredAction<A, R>, args: InferArgs<A>) => Promise<R>;
    readonly runMutation: <A extends ArgsValidator, R>(reference: RegisteredMutation<A, R>, args: InferArgs<A>) => Promise<R>;
    readonly runQuery: <A extends ArgsValidator, R>(reference: RegisteredQuery<A, R>, args: InferArgs<A>) => Promise<R>;
    readonly scheduler: Scheduler;
    readonly storage: Storage;
    readonly vectors: VectorSearch;
}

// --- Generated API surface ---------------------------------------------------

/**
 * Stand-in returned by codegen so projects can `import { api } from "./_generated/api"`.
 * The runtime value is opaque; the types are filled in by generated declarations.
 */
type AnyApi = Record<string, Record<string, RegisteredFunction<ArgsValidator, unknown, FunctionKind>>>;

const anyApi: AnyApi = new Proxy(
    {},
    {
        get(_target, namespace: PropertyKey) {
            const cached = namespaceCache.get(namespace);

            if (cached) {
                return cached;
            }

            const refCache = new Map<PropertyKey, { __cirrusRef: string }>();
            const nsProxy = new Proxy(
                {},
                {
                    get(_inner, functionName: PropertyKey) {
                        const cachedRef = refCache.get(functionName);

                        if (cachedRef) {
                            return cachedRef;
                        }

                        const ref = { __cirrusRef: `${String(namespace)}:${String(functionName)}` };

                        refCache.set(functionName, ref);

                        return ref;
                    },
                },
            );

            namespaceCache.set(namespace, nsProxy);

            return nsProxy;
        },
    },
);

export { anyApi };

export type {
    ActionCtx,
    AggregateIndexDefinition,
    AggregateOp,
    AnyApi,
    ArgsValidator,
    AuthState,
    DatabaseReader,
    DatabaseWriter,
    FunctionKind,
    FunctionVisibility,
    IndexDefinition,
    IndexRangeBuilder,
    InferArgs,
    MutationCtx,
    OnDeleteAction,
    PaginationOptions,
    PaginationResult,
    QueryCtx,
    RankIndexDefinition,
    RankSortKey,
    ReadOnlyStorage,
    RegisteredAction,
    RegisteredFunction,
    RegisteredMutation,
    RegisteredQuery,
    RegisteredStream,
    RelationDefinition,
    Scheduler,
    Schema,
    SearchFilterBuilder,
    SearchIndexDefinition,
    ShardMode,
    Storage,
    TableDefinition,
    TableReader,
    TableVectorIndex,
    TriggerAggregateOptions,
    TriggerBuilder,
    TriggerCtx,
    TriggerDatabase,
    TriggerDefinition,
    TriggerDeleteEvent,
    TriggerEvent,
    TriggerGroupByEntry,
    TriggerGroupByOptions,
    TriggerHandler,
    TriggerInsertEvent,
    TriggerOp,
    TriggerQueryArgs,
    TriggerQueryPage,
    TriggerRankOptions,
    TriggerRankPageOptions,
    TriggerRankResult,
    TriggerRow,
    TriggerTiming,
    TriggerUpdateEvent,
    VectorEmbedder,
    VectorIndexDefinition,
    VectorMatch,
    VectorMatches,
    VectorMetric,
    VectorQueryInput,
    VectorRecord,
    VectorSearch,
    VectorSearchReader,
    VectorUpsertInput,
};
