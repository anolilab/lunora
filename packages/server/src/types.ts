import type { Id, Infer, Validator } from "@cirrus/values";

/** Map of validators describing a function's args record. */
export type ArgsValidator = Record<string, Validator>;

/** Infer the args object type from an {@link ArgsValidator}. */
export type InferArgs<A extends ArgsValidator> = {
    [K in keyof A as undefined extends Infer<A[K]> ? K : never]?: Infer<A[K]>;
} & { [K in keyof A as undefined extends Infer<A[K]> ? never : K]: Infer<A[K]> };

/** How a table is routed at runtime. */
export type ShardMode = { kind: "global" } | { field: string; kind: "shardBy" } | { kind: "root" };

export interface IndexDefinition {
    fields: ReadonlyArray<string>;
    name: string;
    unique?: boolean;
}

export interface SearchIndexDefinition {
    field: string;
    filterFields?: ReadonlyArray<string>;
    name: string;
}

/** FK behavior when a referenced parent row is deleted (mirrors SQL `ON DELETE`). */
export type OnDeleteAction = "cascade" | "restrict" | "set null";

/**
 * A declared relation between two tables, recorded by `.relations((r) => …)`.
 *
 * - `one` (many-to-one): the FK column `field` lives on **this** table and
 *   points at `table`.`references` (default `_id`). Loads a single doc.
 * - `many` (one-to-many): the FK column `field` lives on the **target** table
 *   and points back at this table's `references` (default `_id`). Loads an
 *   array.
 *
 * `onDelete` is meaningful only on `one`: it is the action applied to the
 * holder rows when the referenced parent row is deleted.
 */
export interface RelationDefinition {
    field: string;
    kind: "many" | "one";
    onDelete?: OnDeleteAction;
    references: string;
    table: string;
}

/** Distance metric used by a Vectorize index. */
export type VectorMetric = "cosine" | "dot-product" | "euclidean";

/**
 * Bring-your-own-embedder: a user-supplied fn turning a source string into a
 * numeric vector. The runtime calls it at upsert/query time so the framework
 * never couples to a single embedding provider.
 */
export type VectorEmbedder = (input: string) => Promise<ReadonlyArray<number>> | ReadonlyArray<number>;

/**
 * Vector index declared inline on a table via `.vectorize(field, opts)`
 * (DSL Shape A). The source is always a single column on the owning table.
 */
export interface TableVectorIndex {
    dimensions: number;
    embed: VectorEmbedder;
    field: string;
    metadata?: ReadonlyArray<string>;
    metric: VectorMetric;
    name: string;
}

export interface TableDefinition<Shape extends Record<string, Validator> = Record<string, Validator>> {
    indexes: ReadonlyArray<IndexDefinition>;
    /**
     * Declared relations keyed by accessor name; empty unless `.relations()`
     * was called. Named `relationMap` (not `relations`) so the fluent
     * `.relations((r) => …)` builder method doesn't collide with this field.
     */
    relationMap: Record<string, RelationDefinition>;
    searchIndexes: ReadonlyArray<SearchIndexDefinition>;
    shape: Shape;
    shardMode: ShardMode;
    vectorIndexes: ReadonlyArray<TableVectorIndex>;
}

/**
 * Standalone vector index declared via `defineVectorIndex(...)` (DSL Shape B).
 * Unlike {@link TableVectorIndex}, the source is a `select` function so it can
 * derive the embedded text from any computation (e.g. `title + body`).
 */
export interface VectorIndexDefinition {
    readonly dimensions: number;
    readonly embed: VectorEmbedder;
    readonly kind: "vectorIndex";
    readonly metadata?: (row: Record<string, unknown>) => Record<string, unknown>;
    readonly metric: VectorMetric;
    readonly select: (row: Record<string, unknown>) => string;
    readonly table: string;
}

export interface Schema<T extends Record<string, TableDefinition> = Record<string, TableDefinition>> {
    readonly tables: T;
    readonly vectorIndexes: Record<string, VectorIndexDefinition>;
}

// --- Function registration ---------------------------------------------------

export type FunctionKind = "action" | "mutation" | "query";

export interface RegisteredFunction<A extends ArgsValidator, R, Kind extends FunctionKind> {
    readonly args: A;
    readonly handler: (context: unknown, args: InferArgs<A>) => Promise<R> | R;
    readonly kind: Kind;
}

export type RegisteredQuery<A extends ArgsValidator, R> = RegisteredFunction<A, R, "query">;
export type RegisteredMutation<A extends ArgsValidator, R> = RegisteredFunction<A, R, "mutation">;
export type RegisteredAction<A extends ArgsValidator, R> = RegisteredFunction<A, R, "action">;

// --- Context types -----------------------------------------------------------

/**
 * Read-only handle bound to a table. Used by `query`/`mutation`/`action`. The
 * actual SQL implementation lives in `@cirrus/do`; these are signatures only.
 */
export interface DatabaseReader {
    get: <T extends string>(id: Id<T>) => Promise<Record<string, unknown> | null>;
    query: <T extends string>(tableName: T) => TableReader;
}

export interface TableReader {
    collect: () => Promise<Array<Record<string, unknown>>>;
    filter: (predicate: (document: Record<string, unknown>) => boolean) => TableReader;
    first: () => Promise<Record<string, unknown> | null>;
    take: (limit: number) => Promise<Array<Record<string, unknown>>>;
    withIndex: (indexName: string, range?: (q: IndexRangeBuilder) => IndexRangeBuilder) => TableReader;
}

export interface IndexRangeBuilder {
    eq: (field: string, value: unknown) => IndexRangeBuilder;
    gt: (field: string, value: unknown) => IndexRangeBuilder;
    gte: (field: string, value: unknown) => IndexRangeBuilder;
    lt: (field: string, value: unknown) => IndexRangeBuilder;
    lte: (field: string, value: unknown) => IndexRangeBuilder;
}

export interface DatabaseWriter extends DatabaseReader {
    delete: <T extends string>(id: Id<T>) => Promise<void>;
    insert: <T extends string>(tableName: T, document: Record<string, unknown>) => Promise<Id<T>>;
    patch: <T extends string>(id: Id<T>, patch: Record<string, unknown>) => Promise<void>;
    replace: <T extends string>(id: Id<T>, document: Record<string, unknown>) => Promise<void>;
}

/** Authenticated identity surfaced into every context. */
export interface AuthState {
    getIdentity: () => Promise<Record<string, unknown> | null>;
    readonly userId: string | null;
}

export interface Scheduler {
    runAfter: (delayMs: number, functionPath: string, args?: Record<string, unknown>) => Promise<string>;
    runAt: (timestampMs: number, functionPath: string, args?: Record<string, unknown>) => Promise<string>;
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
export interface ReadOnlyStorage {
    /** Fetch the body of an existing object. Returns `null` when absent. */
    download: (key: string) => Promise<ReadableStream | null>;
    /** Resolve a short-lived signed URL for an existing object. */
    getSignedUrl: (key: string, options?: { expiresInSeconds?: number }) => Promise<string>;
    /** Public URL pointing at the configured base for `key`. */
    getUrl: (key: string) => string;
}

export interface Storage extends ReadOnlyStorage {
    delete: (key: string) => Promise<void>;
}

export interface VectorMatch {
    id: string;
    metadata?: Record<string, unknown>;
    score: number;
}

export interface VectorMatches {
    count: number;
    matches: ReadonlyArray<VectorMatch>;
}

export interface VectorQueryInput {
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

export interface VectorUpsertInput {
    embed: VectorEmbedder;
    id: string;
    input: string;
    metadata?: Record<string, unknown>;
    namespace?: string;
}

export interface VectorRecord {
    id: string;
    metadata?: Record<string, unknown>;
    values: ReadonlyArray<number>;
}

/**
 * Read-only vector surface exposed on {@link QueryCtx}. Mirrors the read half
 * of `@cirrus/vectors`' `CirrusVectors` so the live adapter is assignable.
 */
export interface VectorSearchReader {
    getByIds: (indexName: string, ids: ReadonlyArray<string>) => Promise<ReadonlyArray<VectorRecord>>;
    query: (indexName: string, input: VectorQueryInput) => Promise<VectorMatches>;
}

/**
 * Mutating vector surface on {@link MutationCtx} / {@link ActionCtx}. `upsert`
 * is queued post-commit by default; `upsertNow` forces a synchronous write.
 * `db.delete` on a vectorized table auto-propagates the matching `deleteByIds`.
 */
export interface VectorSearch extends VectorSearchReader {
    deleteByIds: (indexName: string, ids: ReadonlyArray<string>) => Promise<void>;
    upsert: (indexName: string, input: VectorUpsertInput) => Promise<void>;
    upsertNow: (indexName: string, input: VectorUpsertInput) => Promise<void>;
}

export interface QueryCtx {
    readonly auth: AuthState;
    readonly db: DatabaseReader;
    readonly storage: ReadOnlyStorage;
    readonly vectors: VectorSearchReader;
}

export interface MutationCtx {
    readonly auth: AuthState;
    readonly db: DatabaseWriter;
    readonly scheduler: Scheduler;
    readonly storage: ReadOnlyStorage;
    readonly vectors: VectorSearch;
}

export interface ActionCtx {
    readonly auth: AuthState;
    readonly db: DatabaseWriter;
    readonly fetch: typeof globalThis.fetch;
    readonly runAction: <R>(reference: RegisteredAction<ArgsValidator, R>, args: Record<string, unknown>) => Promise<R>;
    readonly runMutation: <R>(reference: RegisteredMutation<ArgsValidator, R>, args: Record<string, unknown>) => Promise<R>;
    readonly runQuery: <R>(reference: RegisteredQuery<ArgsValidator, R>, args: Record<string, unknown>) => Promise<R>;
    readonly scheduler: Scheduler;
    readonly storage: Storage;
    readonly vectors: VectorSearch;
}

// --- Generated API surface ---------------------------------------------------

/**
 * Stand-in returned by codegen so projects can `import { api } from "./_generated/api"`.
 * The runtime value is opaque; the types are filled in by generated declarations.
 */
export type AnyApi = Record<string, Record<string, RegisteredFunction<ArgsValidator, unknown, FunctionKind>>>;

export const anyApi: AnyApi = new Proxy({} as AnyApi, {
    get(_target, namespace: string) {
        return new Proxy({} as Record<string, unknown>, {
            get(_inner, functionName: string) {
                return { __cirrusRef: `${namespace}:${functionName}` };
            },
        });
    },
});
