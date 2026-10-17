/**
 * Schema, tables, indexes, relations, migrations: what the app declares about its data.
 */

/**
 * AST-observable subset of a column's modifier chain (`.unique()`, `.default()`,
 * …). Function-valued modifiers (`.$defaultFn`/`.$onUpdateFn`) can't be
 * serialized, so only their *presence* is recorded.
 */
export interface ColumnMetaIR {
    /** `.default(...)` or `.$defaultFn(...)` present — field is optional on insert. */
    hasDefault?: boolean;
    /** `.$onUpdateFn(...)` present. */
    hasOnUpdate?: boolean;
    /** Default `true`; `.nullable()` flips it to `false`. */
    notNull: boolean;
    /** `.unique()` present. */
    unique?: boolean;
}

/** Reflective representation of a single validator call from the schema. */
export interface ValidatorIR {
    /** For `v.storage(bucket?)` — the named typed bucket the object key lives in, when given. */
    bucket?: string;
    /** Column modifiers (`.unique()`, `.default()`, `.nullable()`, …) when present. */
    column?: ColumnMetaIR;

    /**
     * `true` when this validator carries a refinement (`.check(...)`, `.max(n)`,
     * `.email()`, …) — anything that narrows the accepted values without changing
     * the kind. `schema-drift` hashes this, so a bound counts here even when it is
     * modelled below. `.meta(...)` is pure metadata with no parse effect and does
     * NOT set it.
     */
    hasRefinement?: boolean;
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

    /**
     * The `n` of a `v.string().max(n)` written with a numeric literal — the one
     * refinement predicate the IR can represent exactly (`value.length <= n`).
     * The AOT compiler emits it as a guard instead of declining the node, which
     * is what keeps a length-bounded public argument on the fast path.
     */
    stringMaxLength?: number;
    /** For `v.id("table")` — the table name. */
    tableName?: string;

    /**
     * For `v.from(externalSchema)` — the wrapped Standard Schema's inferred type,
     * rendered as TS source. Recovered through the type checker from
     * `~standard.types.output`, mirroring the runtime's `InferStandardOutput`.
     * Absent when it could not be recovered safely, in which case the emitted
     * type falls back to `unknown`.
     */
    tsType?: string;

    /**
     * `true` when this validator carries a refinement the IR could NOT model — a
     * `.check(...)` closure, `.email()`, `.pattern(re)`, a `.max()` whose bound is
     * not a literal. The AOT args-validator compiler declines any node with this
     * flag, because compiling it would silently skip the predicate.
     */
    unmodelledRefinement?: boolean;
    valueType?: ValidatorIR;
}

export interface IndexIR {
    fields: ReadonlyArray<string>;
    name: string;
    unique?: boolean;
}

export interface SearchIndexIR {
    /** Primary text-search field; a dot-separated path reads a nested field. */
    field: string;
    /** Optional filter fields surfaced alongside the FTS column. */
    filterFields?: ReadonlyArray<string>;
    /** Text-analysis profile (accent folding + that language's stopwords). */
    language?: string;
    name: string;
    /** Skip the migration-time backfill of the search companion (large tables index out-of-band). */
    staged?: boolean;
    /** `"native"` opts into the engine's own full-text index where it has one (Postgres). */
    strategy?: string;
}

/** A `.geoIndex(name, { field, precision? })` declaration — a geohash companion over a `v.geoPoint()` column. */
export interface GeoIndexIR {
    /** The `v.geoPoint()` column feeding the geohash. */
    field: string;
    name: string;
    /** Geohash precision (characters) maintained on the companion; omitted ⇒ the runtime default. */
    precision?: number;
}

/** A `.ttl(field, { after? })` declaration — declarative table-level auto-expiry. */
export interface TtlIR {
    /** Millisecond offset added to `field` to derive the expiry (`field + after`); omitted ⇒ `field` is the absolute expiry. */
    after?: number;
    /** The epoch-millisecond expiry column. */
    field: string;
}

export interface VectorIndexIR {
    dimensions?: number;
    /** Shape A: the single source column. Shape B: undefined (derived via a `select` fn). */
    field?: string;
    /** Shape A: metadata field names mirrored into Vectorize. */
    metadata?: ReadonlyArray<string>;
    metric?: "cosine" | "dot-product" | "euclidean";
    name: string;
    /** Owning table the vectors are sourced from. */
    table: string;
}

/**
 * One ordering key on a rank index's `sortBy`: the column and direction.
 * Mirrors the runtime `RankSortKey` (defaults `direction` to `"asc"`).
 */
export interface RankSortKeyIR {
    direction: "asc" | "desc";
    field: string;
}

/**
 * A `.rankIndex(name, { sortBy, partitionBy?, where? })` declaration. The owning
 * table is always the table the index is declared on, so — unlike a vector index
 * — there is no separate `on`/`table` reference to carry: it rides along on its
 * {@link TableIR}. Only the fields needed for type emission are captured.
 */
export interface RankIndexIR {
    name: string;
    /** Columns scoping each ranking; omitted ⇒ one global rank over the table. */
    partitionBy?: ReadonlyArray<string>;
    /** Ordered sort keys driving the rank. */
    sortBy: ReadonlyArray<RankSortKeyIR>;
}

/** A `one` / `many` relation backed by one foreign-key column. */
export interface KeyedRelationIR {
    /** FK column: on this table for `one`, on the target table for `many`. */
    field: string;
    kind: "many" | "one";
    /** Accessor name the relation is loaded under (the `with` key). */
    name: string;
    /** FK behaviour applied to holder rows when the referenced parent is deleted. */
    onDelete?: "cascade" | "restrict" | "set null";
    /** Referenced column (defaults to `_id`). */
    references: string;
    /** Target table name. */
    table: string;
    through?: never;
}

/** A many-to-many relation: `r.many(target, { through: { table, from, to } })`. */
export interface ThroughRelationIR {
    kind: "many";
    /** Accessor name the relation is loaded under (the `with` key). */
    name: string;
    /** Target table name. */
    table: string;
    /** The join table and its two keys: `from` points at the declaring table, `to` at `table`. */
    through: { from: string; table: string; to: string };
}

export type RelationIR = KeyedRelationIR | ThroughRelationIR;

/**
 * Statically-discovered `.source(...)` config (plan 077). Only the bits the
 * advisor lints + DO wiring need are captured; `map`/`tenantBy` are functions and
 * cannot be serialized, so their presence is recorded as `hasTenantBy` rather than
 * the function itself.
 */
export interface ExternalSourceIR {
    /** The wrangler Hyperdrive binding name. */
    binding: string;
    /** Whether a `columns` projection allow-list was given. */
    columns?: ReadonlyArray<string>;
    /** `true` when a `reconcileEveryMs` was given — one of the two incremental delete-visibility paths the `external_source_incremental_no_delete_path` lint checks. */
    hasReconcile?: boolean;
    /** `true` when a `softDeleteColumn` was given — the other incremental delete-visibility path. */
    hasSoftDelete?: boolean;
    /** `true` when a `tenantBy` mapper was given — the tenant-isolation boundary the `external_source_unscoped` lint checks. */
    hasTenantBy: boolean;
    /** The `idColumn` literal, when given (defaults to `"id"` at runtime). */
    idColumn?: string;
    /** Delete-detection mode literal, when given (`"full-pull"` today). */
    mode?: string;
    /** The membership query literal, when statically knowable. */
    query?: string;

    /**
     * `true` when `.source(...)` was present but its argument was **not** a static
     * object literal (e.g. `.source(buildConfig())`), so none of the fields above
     * could be read. The source still exists — this flag lets `hasSourcedTables`
     * (codegen) and the `external_source_*` lints treat it as a source that can't be
     * verified, instead of mistaking it for no `.source()` at all.
     */
    unanalyzable?: boolean;
}

export interface TableIR {
    /**
     * `true` when the table declares an aggregate index that can answer a `count()`
     * without a scan: an inline `.aggregateIndex(…)`, a standalone `defineAggregateIndex`
     * naming it, or every table when the standalone argument cannot be read. Optional:
     * absent means no such index was found.
     */
    aggregateIndexed?: true;

    /**
     * `true` when the table chain carried `.commitOrdered()` — every row carries
     * `_commitSeq`, a per-shard integer allocated once per mutation and strictly
     * increasing in commit order. Optional: hand-built IR and tables that never
     * called `.commitOrdered()` default it to `false`.
     */
    commitOrdered?: boolean;

    /**
     * `true` when that extension was resolved from a package in `node_modules`
     * rather than from source under `lunora/` (a registry copy-in). Decides
     * whether the component's module owns a `lunora/<key>/` folder.
     */
    extensionFromPackage?: true;

    /**
     * The `defineSchemaExtension` key that contributed this table, set when it
     * arrived through `defineSchema(...).extend(...)`. Absent for a table the app
     * declared itself.
     *
     * Drives the generated `AppTableName` union: an add-on's tables
     * (`ratelimit_buckets`, …) are real tables and stay in `TableName`, but an app
     * enumerating "my tables" should not have to know about them.
     */
    extensionKey?: string;

    /**
     * `true` when the table chain carried `.externallyManaged()` — its rows are
     * written outside Lunora's discoverable insert path (adapter/migration/
     * middleware), so advisor insert-path lints skip it. Optional: hand-built
     * IR and the runtime `fromServerSchema` path default it to `false`.
     */
    externallyManaged?: boolean;

    /**
     * Set when the chain carried `.source(...)` — the table is materialized from an
     * external Hyperdrive-backed database by a system poll loop (plan 077). Carries
     * the statically-knowable bits the advisor lints read; the functions (`map`,
     * `tenantBy`) are not serialized, only their presence (`hasTenantBy`).
     */
    externalSource?: ExternalSourceIR;

    /** Geospatial indexes declared inline via `.geoIndex(name, …)`. Optional so hand-built IR may omit it (discovery always sets it). */
    geoIndexes?: ReadonlyArray<GeoIndexIR>;

    /**
     * Storage backend for a `.global()` table: `"d1"` (default) or
     * `"hyperdrive"` (a Postgres/MySQL database via Cloudflare Hyperdrive). Only
     * meaningful when `shardMode === "global"`; absent for sharded/root tables.
     *
     * Read it through `isD1GlobalTable` / `isHyperdriveGlobalTable` rather than
     * comparing here — discovery normalises the absent case to `"d1"`, and only
     * those predicates encode which comparison is right for hand-built IR.
     */
    globalBackend?: "d1" | "hyperdrive";

    indexes: ReadonlyArray<IndexIR>;

    /**
     * `true` when the table chain carried `.public()` — an explicit opt-OUT of
     * the schema's `.rls("required")` enforcement for this one table. Optional:
     * hand-built IR and tables that never called `.public()` default it to
     * `false`.
     */
    isPublic?: boolean;

    /**
     * `true` when the table chain carried `.memory()` — its rows are cleared on
     * every Durable Object cold start and never reach the CDC changelog.
     * Optional: hand-built IR and tables that never called `.memory()` default it
     * to `false`.
     */
    memory?: boolean;
    name: string;
    /** Rank indexes declared inline via `.rankIndex(name, …)`. */
    rankIndexes: ReadonlyArray<RankIndexIR>;
    /** Declared relations (via `.relations((r) => …)`), keyed in source order. */
    relations: ReadonlyArray<RelationIR>;
    searchIndexes: ReadonlyArray<SearchIndexIR>;
    shape: Record<string, ValidatorIR>;
    shardMode: "global" | "root" | { field: string; kind: "shardBy" };
    /** Set when the chain carried `.softDelete()` — the marker column's name (default `deletedAt`). The column is injected into `shape` so `Doc_*` carries it. */
    softDelete?: { field: string };
    /** Set when the chain carried `.ttl(field, { after? })` — the declarative auto-expiry policy read by the DO alarm sweep. */
    ttl?: TtlIR;
    /** Vector indexes declared inline via `.vectorize()` (DSL Shape A). */
    vectorIndexes: ReadonlyArray<VectorIndexIR>;
}

/** The Cloudflare DO data-residency jurisdictions the schema may declare. Canonical literal set for the codegen package. */
export type JurisdictionIR = "eu" | "fedramp" | "us";

export interface SchemaIR {
    /**
     * Cloudflare data-residency jurisdiction declared via
     * `defineSchema(...).jurisdiction("…")`. Emitted into the generated worker's
     * `createWorker({ jurisdiction })` (and `ctx.scheduler` / `ctx.containers`).
     * Absent ⇒ un-pinned.
     */
    jurisdiction?: JurisdictionIR;

    /**
     * `.jurisdiction("…", { pinAuth: true })` — the acknowledgement that
     * DO-backed auth, unpinned before, moves into the jurisdiction (and so to a
     * new, empty object until its rows are copied). Without it codegen refuses a
     * project that has DO-backed auth, and does not pin it.
     */
    jurisdictionPinsAuth?: true;

    /**
     * Set when `defineSchema(...).rls("required")` was chained onto the schema —
     * every table's `ctx.db` write path is denied without an RLS-covering
     * procedure unless the table itself is `.public()` (see {@link TableIR.isPublic}).
     * Absent when the schema never called `.rls("required")`.
     */
    rlsMode?: "required";
    tables: ReadonlyArray<TableIR>;
    /** All vector indexes (inline Shape A hoisted + standalone Shape B), flattened. */
    vectorIndexes: ReadonlyArray<VectorIndexIR>;
}

/**
 * Statically-read mirror of `@lunora/server`'s `RestCacheConfig`. Every field is
 * optional because discovery only records literals it could actually read off the
 * `.expose({ cache: … })` object.
 */
export interface ExposeCacheIR {
    credentialHeaders?: ReadonlyArray<string>;
    maxAge?: number;
    scope?: "private" | "public";
    staleWhileRevalidate?: number;
    tag?: string;
    vary?: string;
}

/**
 * A `defineMigration({...})` declaration discovered in the user's lunora
 * sources. The emitted `LUNORA_MIGRATIONS` registry keys on {@link MigrationIR.id}; the
 * import wiring needs {@link MigrationIR.exportName}/{@link MigrationIR.filePath}. The runtime object
 * carries the authoritative {@link MigrationIR.table}, but the lifted value is
 * load-bearing at build time: the schema-drift gate matches it against the
 * tables with breaking drift, so a migration left at `""` covers nothing.
 */
export interface MigrationIR {
    /** Export binding name, used to reference the module member in generated imports. */
    exportName: string;
    /** Path relative to `<projectRoot>/lunora/` without extension, e.g. "migrations". */
    filePath: string;
    /** Stable migration id — the registry key and per-shard run-state key. */
    id: string;
    /** Table the migration iterates; `""` when not a static string literal. */
    table: string;
}

/**
 * One `ctx.db.<table>.findMany({ includeDeleted })` list read whose
 * `includeDeleted` is either a hardcoded `true` or derived from the handler's
 * `args` — the `soft_delete_include_deleted_from_args` lint input. The lint joins
 * `table` against the schema's soft-delete tables and `visibility` against
 * `.public()` before flagging. Structurally identical to `AdvisorSoftDeleteRead`
 * so values pass straight through without conversion.
 */
export interface SoftDeleteReadIR {
    /** Export binding name of the procedure performing the read. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** `true` when `includeDeleted` was derived from the handler's `args` (any caller can flip it). */
    fromArgs: boolean;
    /** `true` when `includeDeleted` was a hardcoded `true` literal (always resurfaces soft-deleted rows). */
    hardcodedTrue: boolean;
    /** 1-based line of the read call. */
    line: number;
    /** Table read, or `""` when the table-arg form's first argument wasn't a string literal. */
    table: string;
    /** `"internal"` for `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
}

/**
 * One `ctx.db.<table>.findMany({ with: { <rel> } })` relation-hydrating list read
 * — the `masked_relation_leak_via_with` lint input. Column masking does not
 * descend into `with`-hydrated relations, so a masked table surfaced only through
 * a `with` on an unprotected parent read is returned in the clear. The lint
 * resolves each relation accessor to its target table and joins it against the
 * discovered mask evidence before flagging. Structurally identical to
 * `AdvisorRelationLoad` so values pass straight through without conversion.
 */
export interface RelationLoadIR {
    /** Export binding name of the procedure performing the read. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the read call. */
    line: number;
    /** Parent table the read targets, or `""` when the table-arg form's first argument wasn't a string literal. */
    parentTable: string;
    /** Relation accessor names named in the read's `with: { … }` map — matched against the parent table's declared relations. */
    relations: string[];
    /** `"internal"` for `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
}

/**
 * One import of a migrated-away platform's SDK still present in `lunora/`
 * source. Structurally identical to the advisor's `AdvisorStaleMigrationImport`
 * so it passes through the feeder without conversion.
 */
export interface StaleMigrationImportIR {
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the import, or `0` when unknown. */
    line: number;
    /** The imported module, e.g. `@supabase/supabase-js`. */
    moduleSpecifier: string;
    /** Which migration guide covers this platform. */
    platform: "convex" | "firebase" | "supabase";
}

/**
 * Whether a table is `.shardBy()` — the one spelling of that check. `shardMode`
 * has exactly one object-typed member today, so `.kind === "shardBy"` is a no-op
 * under the current type; it is kept so this still discriminates correctly if
 * the union ever grows a second object-shaped shard mode.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see comment above
export const isShardByTable = (table: Pick<TableIR, "shardMode">): boolean => typeof table.shardMode === "object" && table.shardMode.kind === "shardBy";
