/**
 * Schema-independent type machinery for the generated data model.
 *
 * `@lunora/codegen` emits `lunora/_generated/dataModel.ts` with the
 * schema-specific pieces (the per-table `Doc_*` / `Insert_*` interfaces, the
 * `DataModel` / `Relations` / index-name maps) and then binds the generics
 * below to them. Everything here is identical for every project, so it lives
 * in the shipped package rather than in generated output — evolving the query
 * DSL or the table-facade API no longer regenerates a single line of a user's
 * `_generated` directory.
 *
 * The generics are parameterized over the generated maps:
 * - `DM`   — `DataModel`: table name → document type
 * - `IM`   — `InsertModel`: table name → insert shape
 * - `REL`  — `Relations`: table name → relation-descriptor map
 * - `RANK` — `RankIndexNamesByTable`: table name → declared rank-index names
 * - `SEARCH` — `SearchIndexNamesByTable`: table name → declared search-index names
 *
 * Relation descriptors are matched structurally (`{ __relationKind; __target }`)
 * so this module needs no reference to the project-local `OneRelation` /
 * `ManyRelation` aliases the codegen still emits.
 */
/* eslint-disable @typescript-eslint/no-empty-object-type -- `{}` is the deliberate identity element for the with-arg intersection machinery and the default `W` type param; `object`/`unknown` change the inference this module exists to provide. */
/* eslint-disable no-secrets/no-secrets -- the high-entropy strings flagged here are framework API type names quoted in doc comments, not credentials. */
/* eslint-disable import/exports-last -- internal helper type aliases sit next to the exported types that use them; grouping all exports last would scatter the with-arg machinery. */
/* eslint-disable unicorn/prevent-abbreviations -- `WithArg` is the public type name the generated dataModel binds as `WithArgOf`; renaming it breaks the codegen contract. */

/** A branded id for table `TName`. Structurally a `string` at runtime. */
export type Id<TName extends string> = string & { readonly __table: TName };

/** Field-level operators for the typed `where` DSL (see `@lunora/do`'s compiler). */
export interface WhereOperators<T> {
    contains?: string;
    eq?: T;
    gt?: T;
    gte?: T;
    in?: T[];
    isNull?: boolean;
    lt?: T;
    lte?: T;
    ne?: T;
    notIn?: T[];
}

/** A typed `where` tree over a document's columns. */
export type Where<TDocument> = {
    [K in keyof TDocument]?: TDocument[K] | WhereOperators<TDocument[K]>;
} & {
    AND?: Where<TDocument>[];
    NOT?: Where<TDocument>;
    OR?: Where<TDocument>[];
};

/** One `{ field: "asc" | "desc" }` ordering entry; `orderBy` is an ordered list. */
export type OrderBy<TDocument> = Partial<Record<keyof TDocument, "asc" | "desc">>;

export interface QueryArgs<TDocument> {
    cursor?: null | string;
    limit?: number;
    orderBy?: OrderBy<TDocument>[];

    /**
     * Project each returned row down to these columns (plus the system fields
     * `_id`/`_creationTime`, always retained). Trims wire payload for wide rows;
     * relations requested via `with` are still attached. Reactivity is unaffected —
     * the engine still reads the whole row to track dependencies.
     */
    select?: ReadonlyArray<keyof TDocument & string>;
    where?: Where<TDocument>;
}

/**
 * A to-one relation predicate node. `is` matches rows whose related record
 * satisfies `W`; `isNot` matches rows whose related record fails `W` *or* has
 * no related record at all (a null/dangling FK) — Prisma's semantics.
 */
export interface OneRelationWhere<W> {
    is?: W;
    isNot?: W;
}

/**
 * A to-many relation predicate node. `some` ⇒ at least one related row matches
 * `W`; `none` ⇒ no related row matches (childless parents included); `every` ⇒
 * every *readable* related row matches (vacuously true for childless parents).
 */
export interface ManyRelationWhere<W> {
    every?: W;
    none?: W;
    some?: W;
}

/**
 * The relation-predicate portion of {@link WhereOf}: each declared relation on
 * `T` contributes a kind-dispatched node — `one` → `{ is?; isNot? }`, `many` →
 * `{ some?; none?; every? }` — whose inner type is the target table's own
 * relation-aware `where` (so multi-hop predicates type-check inside-out).
 */
type RelationWhere<DM, REL extends Record<keyof DM, object>, T extends keyof DM> = {
    [K in keyof REL[T]]?: REL[T][K] extends { __relationKind: "one"; __target: infer Target extends keyof DM }
        ? OneRelationWhere<WhereOf<DM, REL, Target>>
        : REL[T][K] extends { __relationKind: "many"; __target: infer Target extends keyof DM }
          ? ManyRelationWhere<WhereOf<DM, REL, Target>>
          : never;
};

/**
 * Relation-aware `where` tree — the column predicates of {@link Where} plus
 * Prisma-style relation predicates resolved by the `@lunora/do` pre-resolver.
 * `Where<DM[T]>` stays the column-only structural mirror for back-compat; the
 * table facade threads `REL` through this richer form.
 */
export type WhereOf<DM, REL extends Record<keyof DM, object>, T extends keyof DM> = RelationWhere<DM, REL, T> & {
    [K in keyof DM[T]]?: DM[T][K] | WhereOperators<DM[T][K]>;
} & {
    AND?: WhereOf<DM, REL, T>[];
    NOT?: WhereOf<DM, REL, T>;
    OR?: WhereOf<DM, REL, T>[];
};

/** {@link QueryArgs} with the relation-aware {@link WhereOf} `where` typing. */
export interface QueryArgsOf<DM, REL extends Record<keyof DM, object>, T extends keyof DM> {
    cursor?: null | string;

    /**
     * Include soft-deleted rows (`.softDelete()` tables only). Default hides them;
     * `true` returns deleted rows alongside live ones. No effect on a table
     * without `.softDelete()`.
     */
    includeDeleted?: boolean;
    limit?: number;
    orderBy?: OrderBy<DM[T]>[];
    where?: WhereOf<DM, REL, T>;
}

export interface QueryPage<TDocument> {
    continueCursor: null | string;
    isDone: boolean;
    page: TDocument[];
}

/** The nested `with` sub-argument inside a relation's with-value, or `{}`. */
type NestedWithArgument<WK> = WK extends { with: infer NW } ? NW : {};

/** The nested `select` tuple inside a relation's with-value, or `undefined` (no projection). */
type NestedSelectArgument<WK> = WK extends { select: infer S } ? S : undefined;

/**
 * The `with` argument for table `T`: each relation can be `true` (load with no
 * refinements) or an object. `many` relations accept `where`/`orderBy`/`limit`/
 * `select` plus a nested `with`; `one` relations accept `select` + a nested
 * `with`. The reserved `_count` key requests per-relation aggregate counts.
 */
export type WithArg<DM, REL extends Record<keyof DM, object>, T extends keyof DM> = {
    [K in keyof REL[T]]?: REL[T][K] extends { __relationKind: "many"; __target: infer Target extends keyof DM }
        ? boolean | (QueryArgs<DM[Target]> & { with?: WithArg<DM, REL, Target> })
        : REL[T][K] extends { __relationKind: "one"; __target: infer Target extends keyof DM }
          ? boolean | { select?: ReadonlyArray<keyof DM[Target] & string>; with?: WithArg<DM, REL, Target> }
          : never;
} & {
    _count?: { [K in keyof REL[T]]?: true };
};

/**
 * Resolve a single relation descriptor + its with-value to the loaded type,
 * threading the nested `select` tuple into the projected child shape (the 5th
 * `LoadWith` arg) so `with: { author: { select: ["name"] } }` narrows the loaded
 * `author` to the selected columns + system fields.
 */
type LoadRelation<DM, REL extends Record<keyof DM, object>, R, WK> = R extends { __relationKind: "one"; __target: infer Target extends keyof DM }
    ? LoadWith<DM, REL, Target, NestedWithArgument<WK>, NestedSelectArgument<WK>> | null
    : R extends { __relationKind: "many"; __target: infer Target extends keyof DM }
      ? LoadWith<DM, REL, Target, NestedWithArgument<WK>, NestedSelectArgument<WK>>[]
      : never;

/** The relation keys of `W` that were actually requested (not `false`/`undefined`). */
type LoadedRelations<DM, REL extends Record<keyof DM, object>, T extends keyof DM, W> = {
    [K in keyof W as K extends keyof REL[T] ? (W[K] extends false | undefined ? never : K) : never]: K extends keyof REL[T]
        ? LoadRelation<DM, REL, REL[T][K], W[K]>
        : never;
};

/** The `_count` projection of `W`, if any. */
type LoadedCount<W> = W extends { _count: infer C } ? { _count: { [K in keyof C]: number } } : {};

/** System columns a `select` projection always retains, so cursors and by-id reuse keep working. */
type SelectAlwaysKeep<DM, T extends keyof DM> = ("_creationTime" | "_id") & keyof DM[T];

/**
 * `DM[T]` narrowed to the columns named by a `select` tuple `S` (plus the system
 * fields). `undefined` (the default — no `select`) keeps the full document.
 */
type ProjectDoc<DM, T extends keyof DM, S> =
    S extends ReadonlyArray<infer K> ? (K extends keyof DM[T] ? Pick<DM[T], (K & keyof DM[T]) | SelectAlwaysKeep<DM, T>> : DM[T]) : DM[T];

/**
 * `Doc<T>` narrowed to exactly the relations requested in the with-arg `W` and,
 * when a `select` tuple `S` is supplied, to its projected columns. `S` defaults
 * to `undefined` so the 4-argument form (the codegen-emitted callers) keeps the
 * full document.
 */
export type LoadWith<DM, REL extends Record<keyof DM, object>, T extends keyof DM, W, S = undefined> = LoadedCount<W> &
    LoadedRelations<DM, REL, T, W> &
    ProjectDoc<DM, T, S>;

/** Reducer applied by an aggregate (`avg`/`count`/`max`/`min`/`sum`). */
export type AggregateOp = "avg" | "count" | "max" | "min" | "sum";

/**
 * Query-options shape shared by every aggregate reader. The RLS-aware ctx
 * populates `baseWhere` so it composes here without a hard import.
 * `restrictsCounts: true` flips `count()` into a thrown `COUNT_RLS_UNSUPPORTED`
 * `LunoraError` rather than silently undercount.
 */
export interface RestrictableQueryOptions<TDocument> {
    baseWhere?: Where<TDocument>;
    restrictsCounts?: boolean;
    where?: Where<TDocument>;
}

/**
 * Relation-aware twin of {@link RestrictableQueryOptions}. The `@lunora/do`
 * pre-resolver now resolves relation predicates on the `count`/`aggregate`/
 * `groupBy` paths too (semijoin), so the typed surface threads `REL` through
 * `where`/`baseWhere` to match. `rank`/`rankPage` stay column-only — they use
 * `where` solely to pin a partition and fail closed on a relation predicate.
 */
export interface RestrictableQueryOptionsOf<DM, REL extends Record<keyof DM, object>, T extends keyof DM> {
    baseWhere?: WhereOf<DM, REL, T>;
    restrictsCounts?: boolean;
    where?: WhereOf<DM, REL, T>;
}

/** Args for `ctx.db.<table>.aggregate({ op, field?, where? })`. */
export interface TableAggregateOptions<TDocument> extends RestrictableQueryOptions<TDocument> {
    field?: keyof TDocument & string;
    op: AggregateOp;
}

/** Relation-aware twin of {@link TableAggregateOptions} (see {@link RestrictableQueryOptionsOf}). */
export interface TableAggregateOptionsOf<DM, REL extends Record<keyof DM, object>, T extends keyof DM> extends RestrictableQueryOptionsOf<DM, REL, T> {
    field?: keyof DM[T] & string;
    op: AggregateOp;
}

/** Args for `ctx.db.<table>.groupBy({ by, agg?, where? })`. */
export interface TableGroupByOptions<TDocument> extends RestrictableQueryOptions<TDocument> {
    agg?: { field?: keyof TDocument & string; op: AggregateOp };
    by: ReadonlyArray<keyof TDocument & string>;
}

/** Relation-aware twin of {@link TableGroupByOptions} (see {@link RestrictableQueryOptionsOf}). */
export interface TableGroupByOptionsOf<DM, REL extends Record<keyof DM, object>, T extends keyof DM> extends RestrictableQueryOptionsOf<DM, REL, T> {
    agg?: { field?: keyof DM[T] & string; op: AggregateOp };
    by: ReadonlyArray<keyof DM[T] & string>;
}

/** One entry returned by `groupBy` — the group's by-tuple plus the reducer value. */
export interface GroupByEntry<TDocument> {
    key: Partial<TDocument>;
    value: null | number;
}

/** Args for `ctx.db.<table>.rank(name, args)`. `row` is either an id or a row doc. */
export interface TableRankOptions<TDocument> extends RestrictableQueryOptions<TDocument> {
    row: string | TDocument;
}

/** Result of `rank` — 1-based position within the partition + partition total. */
export interface RankResult {
    position: number;
    total: number;
}

/** Args for `ctx.db.<table>.rankPage(name, args)`. */
export interface TableRankPageOptions<TDocument> extends RestrictableQueryOptions<TDocument> {
    cursor?: null | string;
    take?: number;
}

/** One page returned by `rankPage`. */
export interface RankPage<TDocument> {
    continueCursor: null | string;
    isDone: boolean;
    page: TDocument[];
}

/**
 * Builder passed to `.withSearchIndex(name, q => …)`. `.search(field, query)`
 * runs the full-text match against the index's searchable field; `.eq(field,
 * value)` narrows by a declared filter field. Field names are constrained to
 * the table's columns.
 */
export interface SearchFilterBuilder<TDocument> {
    eq: <F extends keyof TDocument & string>(field: F, value: TDocument[F]) => SearchFilterBuilder<TDocument>;
    search: (field: keyof TDocument & string, query: string) => SearchFilterBuilder<TDocument>;
}

/**
 * Chainable reader returned by `.withSearchIndex()` — rows come back ordered
 * by relevance. `.paginate()` is intentionally absent (a relevance-ordered
 * search can't keyset-paginate); cap the result set with `.take(n)`.
 */
export interface SearchReader<TDocument> {
    collect: () => Promise<TDocument[]>;

    /**
     * Like `.collect()`, but pairs each matched document with the relevance
     * score the FTS engine already computed to produce the descending order —
     * `.collect()` throws it away after sorting by it, this surfaces it
     * instead. Ordered by `score` descending, same order as `.collect()`.
     */
    collectWithScores: () => Promise<{ document: TDocument; score: number }[]>;
    first: () => Promise<TDocument | null>;
    take: (limit: number) => Promise<TDocument[]>;
    unique: () => Promise<TDocument | null>;
}

/** A latitude/longitude point (WGS84 decimal degrees) accepted by geo queries. */
export interface GeoPointInput {
    lat: number;
    lng: number;
}

/** An axis-aligned latitude/longitude bounding box (`sw`/`ne` corners). */
export interface GeoBoundingBox {
    ne: GeoPointInput;
    sw: GeoPointInput;
}

/**
 * Builder passed to `.withGeoIndex(name, q => …)`. Call exactly one of
 * `.near(point, radiusMeters)` (proximity, nearest-first) or `.within(box)`
 * (bounding-box).
 */
export interface GeoFilterBuilder {
    near: (point: GeoPointInput, radiusMeters: number) => GeoFilterBuilder;
    within: (box: GeoBoundingBox) => GeoFilterBuilder;
}

/**
 * Chainable reader returned by `.withGeoIndex()`. `.near()` results come back
 * ordered nearest-first; `.within()` results by row creation time. `.paginate()`
 * is intentionally absent — cap the result set with `.take(n)`.
 */
export interface GeoReader<TDocument> {
    collect: () => Promise<TDocument[]>;

    /**
     * Like `.collect()`, but pairs each matched document with the distance
     * (in meters) from `.near()`'s point that the read already computed to
     * produce the nearest-first order. `.within()` box matches have no
     * point-distance metric, so `distanceMeters` is `null` for those rows
     * rather than a misleading `0`.
     */
    collectWithScores: () => Promise<{ distanceMeters: null | number; document: TDocument }[]>;
    first: () => Promise<TDocument | null>;
    take: (limit: number) => Promise<TDocument[]>;
    unique: () => Promise<TDocument | null>;
}

/** Read-only typed table accessor exposed on `QueryCtx.db.<table>`. */
export interface TableReaderFacade<
    DM,
    REL extends Record<keyof DM, object>,
    RANK extends Record<keyof DM, string>,
    SEARCH extends Record<keyof DM, string>,
    T extends keyof DM,
    GEO extends Record<keyof DM, string> = Record<keyof DM, never>,
> {
    /**
     * Reduce rows in this table to a scalar (`avg`/`max`/`min`/`sum` — `count`
     * lives on its own method). Routes through a declared `aggregateIndex` when
     * the planner can prove the request is answerable; otherwise scans.
     */
    aggregate: (options: TableAggregateOptionsOf<DM, REL, T>) => Promise<null | number>;

    /**
     * Count rows. The planner routes `where` keys that match a declared
     * `aggregateIndex.by` set to the indexed counter (no scan); otherwise
     * falls back to a SCAN. Accepts either a bare `where` tree or the broader
     * `RestrictableQueryOptions` shape; the latter is the seam the RLS layer
     * uses to inject `baseWhere` and `restrictsCounts`.
     */
    count: (where?: RestrictableQueryOptionsOf<DM, REL, T> | WhereOf<DM, REL, T>) => Promise<number>;

    /** `true` when at least one row matches `where` (any row when omitted). RLS-filtered exactly like `findFirst`. */
    exists: (where?: WhereOf<DM, REL, T>) => Promise<boolean>;
    findFirst: <W extends WithArg<DM, REL, T> = {}, S extends ReadonlyArray<keyof DM[T] & string> | undefined = undefined>(
        args?: QueryArgsOf<DM, REL, T> & { select?: S; with?: W },
    ) => Promise<LoadWith<DM, REL, T, W, S> | null>;
    findFirstOrThrow: <W extends WithArg<DM, REL, T> = {}, S extends ReadonlyArray<keyof DM[T] & string> | undefined = undefined>(
        args?: QueryArgsOf<DM, REL, T> & { select?: S; with?: W },
    ) => Promise<LoadWith<DM, REL, T, W, S>>;
    findMany: <W extends WithArg<DM, REL, T> = {}, S extends ReadonlyArray<keyof DM[T] & string> | undefined = undefined>(
        args?: QueryArgsOf<DM, REL, T> & { select?: S; with?: W },
    ) => Promise<QueryPage<LoadWith<DM, REL, T, W, S>>>;
    get: (id: Id<string & T>) => Promise<DM[T] | null>;

    /**
     * Group rows by the named keys and apply `agg` per group (defaults to
     * `count`). Answered from the counter table when an aggregate index's
     * `by` matches `options.by` exactly; otherwise scans.
     */
    groupBy: (options: TableGroupByOptionsOf<DM, REL, T>) => Promise<ReadonlyArray<GroupByEntry<DM[T]>>>;

    /**
     * Return the 1-based position of `options.row` within its partition
     * under the declared rankIndex `indexName`, plus the partition's total
     * row count. `null` when the row isn't in the index. Honors the same
     * `baseWhere` / `restrictsCounts` RLS seam as `count()`.
     */
    rank: (indexName: RANK[T], options: TableRankOptions<DM[T]>) => Promise<null | RankResult>;

    /**
     * Walk the rank companion in declared sort order — sorted pagination
     * accelerator. `options.where` may pin the partition; `cursor`/`take`
     * follow the Convex-style keyset shape.
     */
    rankPage: (indexName: RANK[T], options?: TableRankPageOptions<DM[T]>) => Promise<RankPage<DM[T]>>;

    /**
     * Restrict the query to a declared `.geoIndex()` and run a proximity /
     * bounding-box match. `indexName` is constrained to this table's geo indexes
     * (`never` when it declares none). Returns a distance-ordered reader —
     * finish with `.take(n)` / `.collect()`.
     */
    withGeoIndex: (indexName: GEO[T], build: (q: GeoFilterBuilder) => GeoFilterBuilder) => GeoReader<DM[T]>;

    /**
     * Restrict the query to a declared `.searchIndex()` and run a full-text
     * match. `indexName` is constrained to this table's search indexes
     * (`never` when it declares none). Returns a relevance-ordered reader —
     * finish with `.take(n)` / `.collect()`.
     */
    withSearchIndex: (indexName: SEARCH[T], search: (q: SearchFilterBuilder<DM[T]>) => SearchFilterBuilder<DM[T]>) => SearchReader<DM[T]>;
}

/** Read-write typed table accessor exposed on `MutationCtx.db.<table>` / `ActionCtx.db.<table>`. */
export interface TableWriterFacade<
    DM,
    IM extends Record<keyof DM, object>,
    REL extends Record<keyof DM, object>,
    RANK extends Record<keyof DM, string>,
    SEARCH extends Record<keyof DM, string>,
    T extends keyof DM,
    GEO extends Record<keyof DM, string> = Record<keyof DM, never>,
> extends TableReaderFacade<DM, REL, RANK, SEARCH, T, GEO> {
    /**
     * Delete a row by id. On a `.softDelete()` table this flips the marker column
     * (and cascades as a soft delete) instead of removing the row; use
     * {@link TableWriterFacade.hardDelete} to force physical removal.
     */
    delete: (id: Id<string & T>) => Promise<void>;

    /**
     * Delete many rows in this table. Pass an array of ids (requested count is
     * returned; unknown ids are no-ops) or `{ where }` to delete matching rows
     * (actual removed count is returned). Atomic within a mutation.
     */
    deleteMany: {
        (ids: ReadonlyArray<Id<string & T>>, options?: { limit?: number }): Promise<{ deleted: number }>;
        (args: { limit?: number; where: Partial<DM[T]> }): Promise<{ deleted: number }>;
    };

    /** Physically remove a row (and physically cascade `onDelete`), bypassing `.softDelete()`. Same as `delete()` on a non-soft table. */
    hardDelete: (id: Id<string & T>) => Promise<void>;

    /**
     * Insert a document, returning its minted id. With `{ skipDuplicates: true }`
     * a UNIQUE-constraint breach resolves to `null` (the row already exists)
     * instead of throwing — the return type widens to `Id | null` on that overload.
     */
    insert: {
        (values: IM[T], options: { skipDuplicates: true }): Promise<Id<string & T> | null>;
        (values: IM[T], options?: { skipDuplicates?: boolean }): Promise<Id<string & T>>;
    };

    /**
     * Insert many documents into this table in one call, returning the minted ids
     * in input order. With `{ skipDuplicates: true }`, UNIQUE breaches resolve to
     * `null` for that row instead of failing the batch. Atomic within a mutation.
     */
    insertMany: {
        (values: ReadonlyArray<IM[T]>, options: { limit?: number; skipDuplicates: true }): Promise<(Id<string & T> | null)[]>;
        (values: ReadonlyArray<IM[T]>, options?: { limit?: number; skipDuplicates?: boolean }): Promise<Id<string & T>[]>;
    };
    patch: (id: Id<string & T>, values: Partial<IM[T]>) => Promise<void>;

    /**
     * Patch many rows in this table. Pass an array of `{ id, values }` or
     * `{ where, values }` to patch matching rows with the same values. Returns
     * the actual patched count. Atomic within a mutation.
     */
    patchMany: {
        (patches: ReadonlyArray<{ id: Id<string & T>; values: Partial<IM[T]> }>, options?: { limit?: number }): Promise<{ patched: number }>;
        (args: { limit?: number; values: Partial<IM[T]>; where: Partial<DM[T]> }): Promise<{ patched: number }>;
    };
    replace: (id: Id<string & T>, values: IM[T]) => Promise<void>;

    /** Un-soft-delete a row by id: clears the `.softDelete()` marker so list reads see it again. Throws on a non-soft table. */
    restore: (id: Id<string & T>) => Promise<void>;

    /**
     * Insert when no existing row matches `target`, otherwise patch the match with
     * `update` (defaulting to `create`). `target` names a `.unique()` column (or a
     * tuple) used to look it up. Returns the row id and whether it was `created`.
     * Composes `findFirst` + `insert`/`patch`, so RLS gates each step.
     */
    upsert: (args: { create: IM[T]; target: UpsertTargetOf<DM, T>; update?: Partial<IM[T]> }) => Promise<{ created: boolean; id: Id<string & T> }>;

    /** Sequential {@link TableWriterFacade.upsert} over many rows sharing one `target`; one result per input row, in order. */
    upsertMany: (args: {
        rows: ReadonlyArray<{ create: IM[T]; update?: Partial<IM[T]> }>;
        target: UpsertTargetOf<DM, T>;
    }) => Promise<{ created: boolean; id: Id<string & T> }[]>;
}

/** Conflict target for `upsert`/`upsertMany`: one column of table `T`, or a tuple of them. */
export type UpsertTargetOf<DM, T extends keyof DM> = ReadonlyArray<keyof DM[T] & string> | (keyof DM[T] & string);

/** Per-table read facade — `ctx.db.<table>` on a `QueryCtx`. */
export type DatabaseReaderFacade<
    DM,
    REL extends Record<keyof DM, object>,
    RANK extends Record<keyof DM, string>,
    SEARCH extends Record<keyof DM, string>,
    GEO extends Record<keyof DM, string> = Record<keyof DM, never>,
> = {
    readonly [T in keyof DM]: TableReaderFacade<DM, REL, RANK, SEARCH, T, GEO>;
};

/** Per-table read-write facade — `ctx.db.<table>` on a `MutationCtx` / `ActionCtx`. */
export type DatabaseWriterFacade<
    DM,
    IM extends Record<keyof DM, object>,
    REL extends Record<keyof DM, object>,
    RANK extends Record<keyof DM, string>,
    SEARCH extends Record<keyof DM, string>,
    GEO extends Record<keyof DM, string> = Record<keyof DM, never>,
> = {
    readonly [T in keyof DM]: TableWriterFacade<DM, IM, REL, RANK, SEARCH, T, GEO>;
};
