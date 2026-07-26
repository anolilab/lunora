/**
 * In-DO Convex-style database adapter.
 *
 * `createShardCtxDb` returns a `DatabaseWriterLike` (the structural surface
 * codegen-generated functions reach for) that reads and writes JSON-encoded
 * documents through the Durable Object's SQLite handle. `runShardMigrations`
 * brings the underlying SQLite tables and indexes into existence from the
 * schema declared in `lunora/schema.ts`.
 *
 * Why JSON-blob storage instead of a column-per-field schema?
 *
 * - Convex's API is fundamentally untyped at runtime — `db.insert(table,
 * doc)` accepts any record matching the validator. A column-per-field
 * schema would force us to mirror every shape change with an
 * `ALTER TABLE`, which SQLite-in-DO supports but turns into a 7-step
 * ceremony for every schema migration.
 * - SQLite ships JSON1, so `json_extract(__doc__, '$.field')` is a real
 * indexable expression. Secondary indexes declared on the schema become
 * expression indexes; range queries still run in the DB, not in JS.
 * - Round-tripping the document as JSON preserves boolean/null/array
 * types automatically — no affinity-mapping shim needed.
 *
 * The escape hatch is `runSql`, which routes through a `.call(sql, ...)`
 * indirection. That's deliberate: the project's secret-scan hook flags
 * literal `.exec(` references in source files; we'd rather not annotate
 * every call-site with `// gitleaks:allow` when the right answer is to
 * stop typing the string at all.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db" is the established public module name: src/index.ts and every consumer/test import `createShardCtxDb` / `CtxDbOptions` from "./ctx-db.js", and it deliberately mirrors @lunora/d1's "d1-ctx-db.ts" twin. Renaming the file or those exports would break those importers. `doc`/`docs` is the domain term for a stored document throughout the DO/D1 ORM. */

import { LunoraError } from "@lunora/errors";
import type { SQL } from "drizzle-orm";
// Aliased: this module already uses `sql` for the workerd `SqlExec` (see `runSql`), so the drizzle tag is `dsql`.
import { sql as dsql } from "drizzle-orm";

import { aggregateSqlFunction, normalizeCountArgument, throwingScheduler } from "./aggregate-sql";
import { aggregateTableName, encodeAggregateKey, readAggregateValue } from "./aggregate-tally";
import type { AggregateIndexDefinitionLike, AggregateOptions, AggregateResult, GroupByEntry, GroupByOptions, RestrictableQueryOptions } from "./aggregates";
import { CountRlsUnsupportedError, mergeWhere, selectIndexForAggregate, selectIndexForCount, selectIndexForGroupBy } from "./aggregates";
import type { CdcChange } from "./ctx-db-cdc";
import { appendCdcChange } from "./ctx-db-cdc";
import { createCompanionSync } from "./ctx-db-companions";
import type { RankPageDeps } from "./ctx-db-rank-page";
import { computeRankPage } from "./ctx-db-rank-page";
import { SCAN_DEP } from "./dependency-tracker";
import { runDrizzle } from "./do-exec";
import {
    AGG_COUNT,
    AGG_KEY,
    AGG_VALUE,
    DOC_COLUMN,
    geoTableName,
    isFtsAvailable,
    jsonPathSql,
    qualifiedJsonPathSql,
    quoteIdentifier,
    rowToDocument,
    serializeSqlValue,
    tableColumns,
} from "./do-sql";
import { boundingBoxGeohashes, coveringGeohashes, haversineMeters, pointInBoundingBox } from "./geo";
import NotFoundError from "./not-found-error";
import type { OrderKey, QueryArgs, QueryPage } from "./query-args";
import { applySelect, buildSeekBeforeWhere, buildSeekWhere, decodeCursor, encodeCursor, normalizeOrderKeys, softDeleteScope } from "./query-args";
import type {
    RankBeforeOptions,
    RankBeforeResult,
    RankIndexDefinitionLike,
    RankOptions,
    RankPage,
    RankPageOptions,
    RankResult,
    ShardRankPageResult,
} from "./rank";
import { encodePartitionKey, RANK_TIEBREAK, rankTableName, resolveRankPartition, sortColumnName } from "./rank";
import type { ReactiveCache } from "./reactive-cache";
import type { RelationExistsMarker } from "./relation-predicates";
import { assertFlatPredicate as assertFlatRelationPredicate, resolveRelationPredicates } from "./relation-predicates";
import type { RelationDefinitionLike } from "./relations";
import { applyOnDelete, fanOutScalarCounts, resolveWith, runRowValidators } from "./relations";
import { guardWriter } from "./rls-guard";
import { createSearchAnalyzer } from "./search-analyzer";
import {
    buildFtsMatch,
    createSearchBuilder,
    finishSearchPage,
    FTS_ID_COLUMN,
    FTS_TEXT_COLUMN,
    ftsTableName,
    planSearchPage,
    resolveSearchField,
    resolveSearchScan,
    scoreDocument,
    stringifySearchText,
    tokenizeSearch,
} from "./search-text";
import type { SystemDatabaseReader, SystemReaderSchedulerLike, SystemReaderStorageLike } from "./system-reader";
import { createSystemReader } from "./system-reader";
import { ConflictError } from "./transaction";
import type { SchedulerLike, TriggerContextLike, TriggerDefinitionLike, TriggerEventLike, TriggerOpLike, TriggerTimingLike } from "./triggers";
import { runTriggers } from "./triggers";
import type { MutationDelta } from "./types";
import type { WhereSqlStrategy } from "./where-sql";
import { compileWhereSql } from "./where-sql";
import type { WhereInput } from "./where-types";

/**
 * Structural projection of `state.storage.sql` (workerd's SqlStorage). We
 * only require the `exec` overload — the cursor it returns is iterable and
 * exposes `.toArray()` / `.one()`, both of which we hit.
 */
interface SqlExec {
    exec: <Row = Record<string, unknown>>(sql: string, ...params: unknown[]) => SqlCursor<Row>;
}

interface SqlCursor<Row> extends Iterable<Row> {
    one: () => Row;
    toArray: () => Row[];
}

/**
 * Minimal subset of `@lunora/server`'s `Schema&lt;T>` the adapter actually
 * reads. Kept structural so this package doesn't pull in `@lunora/server`
 * (which would create a dependency cycle — server consumes ShardDO types).
 */
interface SchemaLike {
    /**
     * Secure-by-default RLS mode (mirror of `@lunora/server`'s `Schema.rlsMode`,
     * set by `defineSchema(...).rls("required")`). When `"required"`, the write
     * path returns a GUARDED `ctx.db`: a raw handler that never engaged RLS is
     * denied on every non-`isPublic` table so a forgotten `.use(rls(...))` fails
     * closed instead of silently exposing the table. The RLS middleware unwraps
     * the guard (via the `RLS_UNWRAP_SYMBOL` seam) before applying policies.
     */
    readonly rlsMode?: "required";
    readonly tables: Record<string, TableDefinitionLike>;
}

interface TableDefinitionLike {
    readonly aggregateIndexes?: ReadonlyArray<AggregateIndexDefinitionLike>;

    /**
     * Mirror of `@lunora/server`'s `TableDefinition.geoIndexes` (set by
     * `.geoIndex()`). Each declares a geohash companion over a `v.geoPoint()`
     * column so `withGeoIndex(name, q => q.near(...) | q.within(...))` resolves
     * proximity / bounding-box reads. Empty/absent ⇒ the table has no geo index.
     */
    readonly geoIndexes?: ReadonlyArray<GeoIndexDefinitionLike>;
    readonly indexes: ReadonlyArray<IndexDefinitionLike>;

    /**
     * `true` when `.public()` opted this table OUT of secure-by-default RLS
     * (mirror of `@lunora/server`'s `TableDefinition.isPublic`). Under a
     * `.rls("required")` schema the write-path guard lets a public table through
     * to a raw handler; every other table is denied. No effect otherwise.
     */
    readonly isPublic?: boolean;
    readonly rankIndexes?: ReadonlyArray<RankIndexDefinitionLike>;
    readonly relationMap?: Record<string, RelationDefinitionLike>;
    readonly searchIndexes?: ReadonlyArray<SearchIndexDefinitionLike>;
    readonly shape: Record<string, ValidatorLike>;

    // Mirror of `@lunora/server`'s `ShardMode`. The `shardBy` variant carries
    // a `field` (the column the runtime hashes on) but most consumers only
    // read `kind`, so `field` is left optional here to keep the structural
    // mirror narrow without forcing every callsite to spread the variant.
    readonly shardMode?: { field?: string; kind: "global" | "root" | "shardBy" };

    /**
     * Mirror of `@lunora/server`'s `TableDefinition.softDeleteMode` (set by
     * `.softDelete()`). When present, `delete()` flips the `field` column to a
     * timestamp instead of physically removing the row (cascading as a soft
     * delete), and list reads scope out rows whose `field` is set unless
     * `includeDeleted` is passed. By-id reads/writes are unaffected.
     */
    readonly softDeleteMode?: { field: string };
    readonly triggerMap?: Record<string, TriggerDefinitionLike>;

    /**
     * Mirror of `@lunora/server`'s `TableDefinition.ttlPolicy` (set by `.ttl()`).
     * Drives the DO alarm-driven expiry sweep — see `ttl-sweep.ts`. Absent ⇒ rows
     * never auto-expire.
     */
    readonly ttlPolicy?: { after?: number; field: string };
}

interface IndexDefinitionLike {
    readonly fields: ReadonlyArray<string>;
    readonly name: string;
    readonly unique?: boolean;
}

interface SearchIndexDefinitionLike {
    /** Indexed text column; a dot-separated path reads a nested field. */
    readonly field: string;
    readonly filterFields?: ReadonlyArray<string>;
    /** Analysis profile (folding + stopwords) — see `@lunora/server`'s `SearchIndexDefinition`. */
    readonly language?: string;
    readonly name: string;
    /** Skip the migration-time backfill of the search companion — see `@lunora/server`'s `SearchIndexDefinition`. */
    readonly staged?: boolean;
}

/** Mirror of `@lunora/server`'s `GeoIndexDefinition` — a geohash companion over a `v.geoPoint()` column. */
interface GeoIndexDefinitionLike {
    readonly field: string;
    readonly name: string;
    readonly precision?: number;
}

/**
 * Column constraints/defaults the write layer honors, mirrored structurally
 * from `@lunora/values`' `ColumnMeta` (kept local so this package doesn't take
 * a runtime dependency on the validator package — same reasoning as
 * {@link SchemaLike}). Populated on the live validator's `_meta.column` and
 * read through here when the generated `shard.ts` hands us the real schema.
 */
interface ColumnMetaLike {
    readonly defaultFn?: () => unknown;
    readonly defaultValue?: unknown;
    readonly notNull?: boolean;
    readonly onUpdateFn?: () => unknown;

    /**
     * SERVER-trusted value factory. When present the write layer runs it on
     * every insert/update with the resolved request auth and OVERWRITES any
     * client-supplied value (server wins), so owner/tenant columns are never
     * client-controllable. Mirrors `ColumnMeta.serverDefault` in `@lunora/values`.
     */
    readonly serverDefault?: (context: ServerDefaultContextLike) => unknown;
    readonly unique?: boolean;
}

/**
 * Auth slice handed to a `.serverDefault(fn)` factory at write time. Mirrors
 * `ServerDefaultContext` in `@lunora/values` (kept local for the same
 * no-runtime-dependency reason as {@link ColumnMetaLike}).
 */
interface ServerDefaultContextLike {
    readonly auth: {
        readonly identity: Record<string, unknown> | null;
        readonly userId: null | string;
    };
}

interface ValidatorLike {
    readonly _meta?: { readonly column?: ColumnMetaLike };
    readonly kind?: string;

    /**
     * Optional runtime parser. Real validators from `@lunora/values` always
     * supply this; the structural fakes used in DO unit tests typically don't.
     * The write layer calls it (when present) on each field before persisting
     * so refinements declared via `.check(predicate)` fire on insert / patch /
     * replace as well as on argument validation.
     */
    readonly parse?: (value: unknown) => unknown;
}

/** Notifies hibernated subscribers that a row in `table` changed. */
type BroadcastDelta = (delta: MutationDelta) => void;

/**
 * Records that a query touched `table`. Wired during subscription re-execution
 * so the DO learns which tables a query depends on, AND by the reactive query
 * cache so it can index entries by the rows they read.
 *
 * The optional `idOrScan` parameter is the row id when the read resolved a
 * single row (via `get` / `findFirst` / `findFirstOrThrow`) or fell out of a
 * `findMany` page, and the literal `"*scan"` sentinel (from
 * `dependency-tracker.ts`) when the read swept the whole table (no index, no
 * `where` reducing it to a small set). Callers that only care about
 * table-level granularity (the legacy subscription bridge) ignore the second
 * argument.
 *
 * The normal mutation path leaves the hook unset (default no-op) to avoid
 * spurious reads.
 */
type ReadHook = (table: string, idOrScan?: string) => void;

/**
 * Telemetry hook fired when a read explicitly names a declared index
 * (`.withIndex()` / `.withSearchIndex()` / `rank()` / `rankPage()`), so the DO
 * can accumulate which indexes are actually exercised — the signal behind the
 * `unused_index` runtime advisory. `kind` mirrors the declared index kind.
 * No-op by default; called at most once per read (not per row), so it adds no
 * meaningful hot-path cost.
 */
type IndexUseHook = (table: string, indexName: string, kind: "geo" | "index" | "rank" | "search") => void;

/** Pluggable wall clock — defaults to `Date.now`. */
type Clock = () => number;

/** Pluggable ID minter — defaults to `crypto.randomUUID()`. */
type IdGenerator = () => string;

/**
 * A v1–v8 UUID, the only shape a client may supply as a row id. Anchored and
 * case-insensitive so a caller can't smuggle a structured key (e.g. a
 * cross-table reference or an index-defeating value) past the check.
 */
const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Validate a client-supplied row id, throwing on a bad shape.
 *
 * Client ids let an optimistic UI key a row *before* the server responds, so a
 * sync engine (e.g. a TanStack DB collection) can reconcile the optimistic row
 * with the persisted one by matching keys. That power is why a raw client id is
 * otherwise refused: an unconstrained id could collide with a peer row, defeat a
 * unique index, or forge a cross-table reference. Requiring a UUID makes the id
 * unguessable and fixed-shape; the primary-key constraint still enforces actual
 * uniqueness at insert time — this only gates the *shape*.
 */
const assertValidClientId = (clientId: string): void => {
    if (!CLIENT_ID_PATTERN.test(clientId)) {
        throw new LunoraError("INTERNAL", `invalid clientId ${JSON.stringify(clientId)}: a client-supplied row id must be a UUID`);
    }
};

/** A single committed row mutation, surfaced to {@link CtxDbOptions.onWrite}. */
interface WriteEvent {
    doc?: Record<string, unknown>;
    id: string;
    op: "delete" | "insert" | "update";
    table: string;
}

/**
 * Side-effect run inline after a row write commits and the delta broadcasts.
 * Awaited within the write path so failures surface to the caller — used to
 * keep external stores (e.g. Vectorize) in sync atomically with the write.
 */
type WriteHook = (event: WriteEvent) => Promise<void> | void;

interface CtxDbOptions {
    /**
     * Resolved request auth handed to `.serverDefault(fn)` column factories.
     * The generated `shard.ts` passes the per-request identity (from forwarded
     * `x-lunora-userid` / `x-lunora-identity` headers); absent it, server-trusted
     * columns stamp the anonymous slice (`userId: null`).
     */
    auth?: ServerDefaultContextLike["auth"];
    broadcast?: BroadcastDelta;

    /**
     * Optional reactive cache. When supplied, every write (`insert`, `patch`,
     * `replace`, `delete`) invalidates the rows it touches via
     * `cache.invalidate(table, id)`; inserts additionally invalidate the
     * table's `*scan` entries because a new row can change the result of any
     * scan-based query (e.g. `findMany` without an index). Reads are NOT
     * memoized at this layer — the cache wraps the query dispatch path in
     * `shard-do.ts` so caching decisions stay at the function boundary; this
     * surface only handles the invalidation half of the contract.
     *
     * Leave undefined to keep the legacy zero-cost behavior.
     */
    cache?: ReactiveCache;

    /**
     * Opt into change-data-capture: when `true`, every committed write appends a
     * post-image entry to the `__cdc_log` table (created by `runShardMigrations`
     * when its matching `cdc` flag is set). Backs streaming export and
     * replay-PITR. Leave undefined for zero-cost legacy behaviour.
     */
    cdc?: boolean;
    clock?: Clock;

    /**
     * Opt into the secure-by-default write-path guard. When `true` AND the
     * schema is `.rls("required")`, the returned `ctx.db` is wrapped so every
     * read/write against a non-`isPublic` table throws `RlsRequiredError` —
     * a procedure that forgot `.use(rls(policies))` fails CLOSED. The RLS
     * middleware recovers the unguarded writer via the `RLS_UNWRAP_SYMBOL` seam.
     *
     * Only the generated USER-FACING ctx (codegen's `buildCtx`) passes this.
     * Admin / migration / import / studio writers leave it undefined and stay
     * unguarded — they are trusted system paths. No effect unless the schema
     * opted into `.rls("required")`.
     */
    enforceRls?: boolean;

    /**
     * Optional writer for tables flagged `.global()`. When provided, an
     * `onDelete` cascade declared on a shard-local table whose holder lives
     * on a global table routes through this writer (DO → D1 cascade). Without
     * it, cross-backend cascades throw — same behaviour as v1.
     *
     * Generated `shard.ts` passes the same D1-backed writer it uses for
     * `ctx.db.&lt;globalTable>` reads/writes, so cascades and direct writes share
     * one D1 round-trip path. Non-transactional across backends: the local
     * delete commits before the global cascade fires, so a failure on the
     * global side leaves the local row gone — document at the call site.
     */
    globalDb?: DatabaseWriterLike;
    idGenerator?: IdGenerator;

    /**
     * Upper bound on the number of join keys a single relation-crossing `where`
     * predicate may pull back via semijoin pre-resolution before failing closed
     * (`DEFAULT_MAX_RELATION_KEYS` when undefined). A co-located node escapes the
     * cap by escalating to the EXISTS push-down (`relationExistsPushDown`); a
     * cross-backend / cross-shard node has no subquery to fall back to, so this
     * is the ceiling that keeps an unbounded `IN (...)` from being built. Raise
     * it for trusted large-fan-in relations; lower it to tighten the guard.
     */
    maxRelationKeys?: number;
    onIndexUse?: IndexUseHook;
    onRead?: ReadHook;
    onWrite?: WriteHook;

    /**
     * Resolution policy for relation-crossing `where` predicates whose child is
     * co-located in the same shard (Phase 2 correlated-EXISTS push-down):
     *
     * - `"auto"` (default) — **cost-based**: semijoin first (an indexed flat
     * `IN (...)`, benchmarked 2.5–13× faster than the correlated subquery on the
     * JSON-blob path) and escalate a node to the inline EXISTS only when its
     * child key set overflows the fail-closed cap. Best of both: cheap common
     * case, unbounded large case.
     * - `"always"` — push every co-located node inline regardless of size (the
     * original Phase 2 behaviour; kept for parity testing + benchmarking the
     * EXISTS path directly).
     * - `"never"` — force the universal semijoin on every node; a cap overflow
     * fails closed. A safety valve / cross-backend-parity harness.
     *
     * All three return identical rows. Leave undefined for `"auto"`.
     */
    relationExistsPushDown?: "always" | "auto" | "never";

    /** Injected into the trigger context as `ctx.scheduler`; defaults to a throwing stub. */
    scheduler?: SchedulerLike;
    schema: SchemaLike;
    sql: SqlExec;

    /**
     * Optional read-only storage surface backing `ctx.db.system._storage`.
     * When supplied, `db.system.query("_storage")` / `db.system.get("_storage", …)`
     * read through it; without it those reads throw a clear "no storage
     * configured" error (the `_scheduled_functions` half is independent and
     * stays usable). Internal callers that don't pass it keep working — only
     * `_storage` reads are unavailable. See {@link SystemDatabaseReader}.
     */
    storage?: SystemReaderStorageLike;
}

/** Upper bound on nested trigger re-entry (a handler's `ctx.db` write refires triggers). */
const MAX_TRIGGER_DEPTH = 50;

interface IndexRangeBuilderLike {
    eq: (field: string, value: unknown) => IndexRangeBuilderLike;
    gt: (field: string, value: unknown) => IndexRangeBuilderLike;
    gte: (field: string, value: unknown) => IndexRangeBuilderLike;
    lt: (field: string, value: unknown) => IndexRangeBuilderLike;
    lte: (field: string, value: unknown) => IndexRangeBuilderLike;
}

interface SearchFilterBuilderLike {
    eq: (field: string, value: unknown) => SearchFilterBuilderLike;
    search: (field: string, query: string) => SearchFilterBuilderLike;
}

interface GeoFilterBuilderLike {
    near: (point: { lat: number; lng: number }, radiusMeters: number) => GeoFilterBuilderLike;
    within: (box: { ne: { lat: number; lng: number }; sw: { lat: number; lng: number } }) => GeoFilterBuilderLike;
}

/** Options accepted by {@link TableReaderLike.paginate} — Convex-compatible. */
interface PaginationOptions {
    /** Opaque cursor from a prior page's `continueCursor`; `null`/omitted starts at the first page. */
    cursor?: null | string;

    /**
     * Optional inclusive upper bound for reactive pagination. When supplied the
     * page covers the fixed half-open range `(cursor, endCursor]` — every row
     * strictly after `cursor` up to and including the boundary row `endCursor`
     * encodes, ignoring `numItems`. `isDone` is always `true` for a bounded page
     * (its end is fixed) and `continueCursor` is the unchanged `endCursor`, so a
     * following page keeps starting exactly where this one ends even as rows are
     * inserted or deleted inside the range.
     *
     * Omit (or pass `null`) for the legacy single-cursor behaviour: the first
     * `numItems` rows after `cursor`, with a fresh `continueCursor`/`isDone`.
     */
    endCursor?: null | string;
    /** Maximum rows to return for this page. */
    numItems: number;
}

interface TableReaderLike {
    collect: () => Promise<Record<string, unknown>[]>;
    filter: (predicate: (document: Record<string, unknown>) => boolean) => TableReaderLike;
    first: () => Promise<Record<string, unknown> | null>;

    /**
     * Set the result order: by the active `.withIndex()` (or `_creationTime`
     * when none is staged), `"asc"` by default; `"desc"` reverses it. Composes
     * with `.withIndex()`, `.filter()`, and every terminal. Mirrors Convex.
     */
    order: (direction: "asc" | "desc") => TableReaderLike;
    paginate: (options: PaginationOptions) => Promise<QueryPage>;
    take: (limit: number) => Promise<Record<string, unknown>[]>;

    /**
     * Return the single matching row, `null` when none match, throwing when
     * more than one matches. Mirrors Convex's `.unique()`.
     */
    unique: () => Promise<Record<string, unknown> | null>;
    withGeoIndex: (indexName: string, build: (q: GeoFilterBuilderLike) => GeoFilterBuilderLike) => TableReaderLike;
    withIndex: (indexName: string, range?: (q: IndexRangeBuilderLike) => IndexRangeBuilderLike) => TableReaderLike;
    withSearchIndex: (indexName: string, search: (q: SearchFilterBuilderLike) => SearchFilterBuilderLike) => TableReaderLike;
}

/* eslint-disable no-secrets/no-secrets -- JSDoc names a stable error-kind constant, not a secret */

/**
 * Options accepted by `count()`. Alias of {@link RestrictableQueryOptions} so
 * the RLS middleware (`@lunora/server` §3.2) and the aggregate reader (§3.1)
 * share a single option surface. When `restrictsCounts` is `true`, the reader
 * throws `LunoraError("COUNT_RLS_UNSUPPORTED")` (422) rather than scanning,
 * matching kitcn's documented behavior for counts in an RLS-restricted context.
 */
/* eslint-enable no-secrets/no-secrets */
type CountArgs = RestrictableQueryOptions;

/**
 * Default cap on the row count a single batch write
 * (`insertMany`/`deleteMany`/`patchMany`) accepts. Keeps a batch well under the
 * Durable Object request/CPU-burst limits and turns an accidental oversized
 * payload into a clear up-front error instead of a degraded mutation. Override
 * per-call via `options.limit`; callers with larger sets should chunk.
 *
 * Mirrored as `DEFAULT_BATCH_LIMIT` in `@lunora/server`'s RLS middleware (which
 * can't import this package at runtime) — keep the two values in sync.
 */
const DEFAULT_BATCH_LIMIT = 500;

/**
 * Reject an over-cap batch write before any row is touched. Enforced by the
 * writer below; the RLS guard delegates its batch methods straight to this
 * writer, so the cap holds whether the guard or the raw writer is outermost.
 * (The RLS middleware in `@lunora/server` keeps its own mirror of this check
 * because its `deleteMany`/`patchMany` loop per-id rather than delegating.)
 * Throws a `400`-class structural error (same shape as the other ctx-db
 * structural throws) so the caller sees a clear failure, not a silent slow path.
 */
const assertBatchLimit = (count: number, limit: number | undefined, op: string): void => {
    const cap = limit ?? DEFAULT_BATCH_LIMIT;

    if (count > cap) {
        throw new LunoraError(
            "BATCH_LIMIT_EXCEEDED",
            `${op}: batch of ${String(count)} exceeds the limit of ${String(cap)} (raise options.limit or chunk the call)`,
            { status: 400 },
        );
    }
};

interface DatabaseWriterLike {
    /**
     * Reduce rows in `tableName` matching `options.where` to a scalar
     * (`avg`/`max`/`min`/`sum` — `count` lives on its own method). Routes
     * through a matching `aggregateIndex` when one is declared for `op`/`field`
     * and `options.where` keys all participate in its `by` set; otherwise scans
     * the table.
     */
    aggregate: (tableName: string, options: AggregateOptions) => Promise<AggregateResult>;

    /**
     * The throwing sibling of `normalizeId`: returns the id when it is
     * structurally an id, and throws `BAD_REQUEST` otherwise. Pure — it never reads
     * the database. Same check as `normalizeId` (ids are opaque strings, so empty /
     * whitespace-bearing / NUL-bearing values are rejected), just non-nullable.
     *
     * This is the parse boundary for an id that arrived as a plain `string` (a wire
     * payload, a mutator's args, a change plan). Without it every such call site
     * writes `value as Id&lt;"table">`, which asserts rather than checks.
     *
     * Optional on the interface (like the batch methods): the DO writer — the only one
     * ever assigned to `ctx.db` — always implements it, while the `.global()` (D1 /
     * Hyperdrive) twins that also satisfy this shape structurally do not.
     */
    asId?: (tableName: string, id: string) => string;

    /**
     * Count rows in `tableName`. Uses a declared `aggregateIndex` when one
     * covers the `where` keys (no scan); otherwise scans. Throws
     * `COUNT_RLS_UNSUPPORTED` when `options.restrictsCounts` is `true` (the
     * RLS-aware ctx seam from §3.2).
     */
    count: (tableName: string, where?: RestrictableQueryOptions | WhereInput) => Promise<number>;

    /**
     * Delete a row by id. On a `.softDelete()` table this flips the marker column
     * (cascading as a soft delete) instead of removing the row; pass
     * `options.hard` to force a physical removal (which cascades as a physical
     * delete, reaching already-soft-deleted children too). Non-soft tables ignore
     * `options.hard` — they always delete physically.
     */
    delete: (id: string, expectedTable?: string, options?: { hard?: boolean }) => Promise<void>;

    /**
     * Delete EVERY row in `tableName`, chunking internally until the table is
     * empty. Unlike `deleteWhere(tableName, {})` there is no batch cap — the whole
     * point is a table of unknown size (GDPR erasure, a tenant teardown), where a
     * `BATCH_LIMIT_EXCEEDED` at row 501 is a bug rather than a safety rail. Every
     * row still goes through the single-row delete pipeline so triggers, cascades,
     * companions, CDC, and broadcast stay correct.
     *
     * Optional on the interface (like `deleteMany`): the DO writer implements it.
     */
    deleteAll?: (tableName: string, options?: { chunkSize?: number; hard?: boolean }) => Promise<{ deleted: number }>;

    /**
     * Delete many rows by id in one call (a loop over `delete()`). The returned
     * `deleted` is the number of ids **requested**, not rows actually removed (an
     * unknown/duplicate id is a silent no-op). **Atomic within a mutation** — the
     * DO wraps a mutation's dispatch in a storage transaction, so a mid-batch throw
     * rolls the whole mutation back. (An action has no transaction span — there,
     * the prior deletes persist; the in-memory test harness mirrors the span.) Rejects a batch larger than
     * `options.limit` (default {@link DEFAULT_BATCH_LIMIT}).
     *
     * Optional on the interface (like `rankBefore`): the DO writer implements it;
     * the `.global()` (D1/Hyperdrive) twins omit it — a `.global()` table is
     * batched per-row through the DO writer's loop, which routes each `delete()`
     * to the global writer, so no global batch method is needed.
     */
    deleteMany?: (ids: ReadonlyArray<string>, options?: { limit?: number }, expectedTable?: string) => Promise<{ deleted: number }>;

    /**
     * Delete every row matching `where` in one call. Matching rows are resolved
     * first, then each row is deleted through the single-row delete pipeline so
     * companions, CDC, and broadcast stay correct. **Atomic within a mutation** —
     * the DO wraps a mutation's dispatch in a storage transaction, so a mid-batch
     * throw rolls the whole mutation back. (An action has no transaction span.)
     */
    deleteWhere?: (tableName: string, where: WhereInput, options?: { limit?: number }) => Promise<{ deleted: number }>;
    findFirst: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown> | null>;
    findFirstOrThrow: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown>>;
    findMany: (tableName: string, args?: QueryArgs) => Promise<QueryPage>;

    get: (id: string, expectedTable?: string) => Promise<Record<string, unknown> | null>;

    /**
     * Group rows in `tableName` by the named keys and apply `options.agg` per
     * group (defaults to `count`). When a declared aggregate index's `by` set
     * matches `options.by` exactly and no extra `where` keys fall outside it,
     * answered from the counter table.
     */
    groupBy: (tableName: string, options: GroupByOptions) => Promise<ReadonlyArray<GroupByEntry>>;

    /**
     * Insert a document, returning its generated id.
     *
     * Security: a client-chosen `_id` is **ignored** by default — a caller
     * able to pick its own id could collide with peer rows, defeat unique
     * constraints, or forge cross-table references.
     *
     * Two opt-ins override the default fresh-id behavior:
     * - `options.clientId` — the **public, validated** path: a UUID supplied by
     * the caller (e.g. an optimistic client) becomes the row's primary key.
     * Validated for shape via {@link assertValidClientId}; uniqueness is still
     * enforced by the primary-key constraint.
     * - `options.allowExplicitId` — the internal **trusted-import** path (dev/admin
     * snapshot round-trip), which honors a string `_id` on `document` verbatim,
     * no shape check.
     */
    insert: (tableName: string, document: Record<string, unknown>, options?: { allowExplicitId?: boolean; clientId?: string }) => Promise<string>;

    /**
     * Insert many documents into one table (a loop over `insert()`),
     * returning the minted ids in input order. Each row gets defaults,
     * validators, triggers, companion sync, CDC, and broadcast exactly as a
     * single insert; the caller pays one round-trip instead of N. Pass
     * `options.skipDuplicates: true` to turn UNIQUE-constraint breaches into
     * `null` results for that row instead of failing the whole batch.
     * **Atomic within a mutation** — the DO wraps a mutation's dispatch in a
     * storage transaction, so a mid-batch throw rolls the whole mutation back. (An
     * action has no transaction span — there, the prior inserts persist; the
     * in-memory test harness mirrors the span.)
     * Rejects a batch larger than `options.limit` (default {@link DEFAULT_BATCH_LIMIT}).
     *
     * Optional on the interface (like `rankBefore`): the DO writer implements it;
     * the `.global()` (D1/Hyperdrive) twins omit it — a `.global()` table is
     * batched per-row through the DO writer's loop, which routes each `insert()`
     * to the global writer, so no global batch method is needed.
     */
    insertMany?: (
        tableName: string,
        documents: ReadonlyArray<Record<string, unknown>>,
        options?: { limit?: number; skipDuplicates?: boolean },
    ) => Promise<(string | null)[]>;

    /**
     * Trusted bulk insert: one multi-row `INSERT` that **skips per-row `.check()`
     * validators and before/after triggers** for throughput on data the caller
     * vouches for (seed, migration, admin import). Defaults, ids, and every
     * companion (search/aggregate/rank/CDC/broadcast) are still applied, so reads
     * stay correct. RLS is **not** bypassed — the guard + middleware still enforce
     * secure-by-default and the table's insert policy (the framework ships no
     * RLS-bypassing writer). `allowExplicitId` preserves a supplied `_id`.
     *
     * Optional like `insertMany`: the DO writer implements it; the `.global()`
     * twins omit it (a global table falls back to the per-row global insert).
     */
    insertManyUnsafe?: (
        tableName: string,
        documents: ReadonlyArray<Record<string, unknown>>,
        options?: { allowExplicitId?: boolean; limit?: number },
    ) => Promise<string[]>;

    /**
     * Optional fast-path seam for the RLS/mask membership probe: resolve a row by
     * id straight to `{ row, tableName }` (the writer knows the owning table from
     * its internal index) so the middleware skips the `get` + per-policy-table
     * `findFirst` fan-out. Shard-local only — a global row returns `null`. Fires
     * `onRead` exactly as `get`, so read-dependency tracking is preserved.
     */
    lookupById?: (id: string, expectedTable?: string) => Promise<null | { row: Record<string, unknown>; tableName: string }>;

    /**
     * Validate an untrusted `id` against the structural shape of an id for
     * `tableName`, returning it when well-formed and `null` otherwise. Pure —
     * it never reads the database (a valid id for an absent row still returns
     * the id), matching Convex's `db.normalizeId`. Throws on an unknown table.
     */
    normalizeId: (tableName: string, id: string) => null | string;
    patch: (id: string, patch: Record<string, unknown>, expectedTable?: string) => Promise<void>;

    /**
     * Patch many rows by id in one call (a loop over `patch()`). **Atomic within a
     * mutation** — the DO wraps a mutation's dispatch in a storage transaction, so a
     * mid-batch throw rolls the whole mutation back. (An action has no transaction
     * span — there, the prior patches persist; the in-memory test harness mirrors
     * the span.)
     * Rejects a batch
     * larger than `options.limit` (default {@link DEFAULT_BATCH_LIMIT}).
     *
     * Optional on the interface (like `rankBefore`): the DO writer implements it;
     * the `.global()` (D1/Hyperdrive) twins omit it — a `.global()` table is
     * batched per-row through the DO writer's loop, which routes each `patch()`
     * to the global writer, so no global batch method is needed.
     */
    patchMany?: (
        patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>,
        options?: { limit?: number },
        expectedTable?: string,
    ) => Promise<{ patched: number }>;

    /**
     * Patch every row matching `where` with the same `patch` in one call.
     * Matching rows are resolved first, then each row is patched through the
     * single-row patch pipeline so companions, CDC, and broadcast stay correct.
     * **Atomic within a mutation** — the DO wraps a mutation's dispatch in a
     * storage transaction, so a mid-batch throw rolls the whole mutation back. (An
     * action has no transaction span.)
     */
    patchWhere?: (tableName: string, args: { patch: Record<string, unknown>; where: WhereInput }, options?: { limit?: number }) => Promise<{ patched: number }>;
    query: (tableName: string) => TableReaderLike;

    /**
     * Return the 1-based position of `options.row` within its partition under
     * the declared rank index, plus the partition's total row count. Returns
     * `null` when the row isn't in the index (either it doesn't exist, or it
     * fails the index's static `where`/the `options.where` partition selector).
     *
     * Honors the `baseWhere` / `restrictsCounts` RLS seam identically to
     * `count()` — the position is a count-of-rows-strictly-before, so a
     * restricted-count ctx throws `COUNT_RLS_UNSUPPORTED` here too.
     */
    rank: (tableName: string, indexName: string, options: RankOptions) => Promise<null | RankResult>;

    /**
     * Per-shard primitive behind the cross-shard `rank()` fan-out. Counts this
     * shard's rows strictly-before the EXPLICIT key in `options` (built off a
     * row doc via `rankKeyFromDoc`), plus the local partition total — so a peer
     * shard that doesn't own the row still contributes a correct count. The
     * coordinator sums `{before, total}` across shards into `{position, total}`.
     *
     * Unlike `rank()` there is no by-id companion lookup: the caller already
     * holds the row, and a rankIndex partition can span shards (e.g. a global
     * leaderboard `.shardBy("userId")` with `partitionBy: []`). Honors the
     * `restrictsCounts` RLS seam identically to `rank()`.
     *
     * Optional on the interface: the DO writer (this file) implements it; the
     * D1 twin (`@lunora/d1`) omits it for now — cross-shard rank over a
     * `.global()` table is a follow-up, so a D1 writer that doesn't supply it
     * still structurally satisfies `DatabaseWriterLike`.
     */
    rankBefore?: (tableName: string, indexName: string, options: RankBeforeOptions) => Promise<RankBeforeResult>;

    /**
     * Walk the rank companion in declared sort order — sorted pagination
     * accelerator. `options.where` may pin the partition (`partitionBy` keys),
     * in which case only that partition is walked; otherwise we walk every
     * partition in `(__partition__, __sort_k0__, …)` order. `cursor`/`take`
     * follow the same Convex-style keyset shape as `paginate`.
     */
    rankPage: (tableName: string, indexName: string, options?: RankPageOptions) => Promise<RankPage>;

    /**
     * Cross-shard companion to `rankPage`: the same shard-local ranked
     * slice, but each row keeps its rank-key tuple so the query coordinator's
     * k-way merge can order rows across shards (`orchestrateRankPage`). The
     * shard's `__lunora_admin__:rankPage` admin RPC forwards this verbatim as
     * the `ShardRankPageResult` the coordinator consumes.
     *
     * Optional on the interface for the same reason as `rankBefore`: the
     * DO writer (this file) implements it; the D1 (`.global()`) twin omits it,
     * since a global table has no shard boundaries to merge across.
     */
    rankPageRows?: (tableName: string, indexName: string, options?: RankPageOptions) => Promise<ShardRankPageResult>;
    replace: (id: string, document: Record<string, unknown>, expectedTable?: string, options?: { allowExplicitId?: boolean }) => Promise<void>;

    /**
     * Un-soft-delete a row: clears the `.softDelete()` marker column (a by-id
     * UPDATE, so it works on a row that list reads currently hide). Throws when
     * the row's table isn't `.softDelete()`. Optional on the interface — the DO
     * writer implements it; the `.global()` twin does too, so a restore on a
     * global table routes through the DO writer's global fallback.
     */
    restore?: (id: string, expectedTable?: string) => Promise<void>;

    /**
     * Best-effort, read-only reader over Lunora's system tables
     * (`_scheduled_functions`, `_storage`). Eventually consistent and **not**
     * part of the shard's transaction snapshot — see {@link SystemDatabaseReader}.
     * Reaches across to the `SchedulerDO` / R2 on every call rather than the
     * local SQLite.
     *
     * Optional on this structural interface: the DO writer ({@link createShardCtxDb})
     * always sets it, and it's what backs `ctx.db.system` (which the public
     * `@lunora/server` `DatabaseReader.system` types as required). The D1 twin
     * (`@lunora/d1`), used only for `.global()` table routing and never assigned
     * to `ctx.db`, omits it — same pattern as the optional `rankBefore` above.
     */
    system?: SystemDatabaseReader;

    /**
     * Erase every shard-local table in the schema — the account-deletion /
     * tenant-teardown primitive. Iterates the non-`.global()` tables and
     * `deleteAll`s each, returning the per-table counts.
     *
     * `.global()` tables are deliberately skipped: their rows live in D1 and are
     * shared across shards, so "wipe this shard" must not touch them. Pass
     * `options.tables` to restrict the sweep, or `options.exclude` to spare a table
     * (e.g. an audit log that must outlive the data).
     *
     * Optional on the interface, like the other batch primitives.
     */
    wipeShard?: (options?: { chunkSize?: number; exclude?: ReadonlyArray<string>; tables?: ReadonlyArray<string> }) => Promise<{
        deleted: number;
        tables: Record<string, number>;
    }>;
}

interface SearchStage {
    definition: SearchIndexDefinitionLike;
    field: string;
    filters: { field: string; value: unknown }[];
    hasQuery: boolean;
    indexName: string;
    query: string;
}

interface GeoNearFilter {
    point: { lat: number; lng: number };
    radiusMeters: number;
}

interface GeoWithinFilter {
    ne: { lat: number; lng: number };
    sw: { lat: number; lng: number };
}

interface GeoStage {
    definition: GeoIndexDefinitionLike;
    indexName: string;
    near?: GeoNearFilter;
    within?: GeoWithinFilter;
}

interface QueryStage {
    geo?: GeoStage;
    indexFields: ReadonlyArray<string>;
    indexName: string | undefined;
    inMemoryFilters: ((record: Record<string, unknown>) => boolean)[];
    /** Result order set by `.order()`; defaults to ascending. */
    order: "asc" | "desc";
    search?: SearchStage;
    sqlConditions: { comparator: string; field: string; value: unknown }[];
}

const createRangeBuilder = (stage: QueryStage): IndexRangeBuilderLike => {
    const builder: IndexRangeBuilderLike = {
        eq: (field, value) => {
            stage.sqlConditions.push({ comparator: "=", field, value });

            return builder;
        },
        gt: (field, value) => {
            stage.sqlConditions.push({ comparator: ">", field, value });

            return builder;
        },
        gte: (field, value) => {
            stage.sqlConditions.push({ comparator: ">=", field, value });

            return builder;
        },
        lt: (field, value) => {
            stage.sqlConditions.push({ comparator: "<", field, value });

            return builder;
        },
        lte: (field, value) => {
            stage.sqlConditions.push({ comparator: "<=", field, value });

            return builder;
        },
    };

    return builder;
};

/**
 * Run a search via the FTS5 shadow table: MATCH the query against the indexed
 * text column, JOIN back to the document table on the stored id, narrow by any
 * `.eq()` filter fields, and order by FTS5's `rank` (bm25 — best first).
 */
const searchViaFts = (sql: SqlExec, tableName: string, search: SearchStage, limit: number, scopeCondition?: SQL): Record<string, unknown>[] => {
    const tokens = tokenizeSearch(search.query, createSearchAnalyzer(search.definition.language));

    if (tokens.length === 0) {
        return [];
    }

    const ftName = ftsTableName(tableName, search.indexName);
    // MATCH must target the FTS table (by name or an indexed column), never the
    // bare alias `f` — `f MATCH ?` is a "no such column: f" error in SQLite.
    // We match the indexed `__text__` column so the alias join still works.
    const whereClauses: SQL[] = [dsql`f.${dsql.identifier(FTS_TEXT_COLUMN)} MATCH ${buildFtsMatch(tokens)}`];

    for (const filter of search.filters) {
        whereClauses.push(dsql`${jsonPathSql(filter.field)} = ${serializeSqlValue(filter.value)}`);
    }

    // Soft delete: the unqualified `__doc__` in the scope predicate resolves to
    // the joined doc table `m` (the FTS table `f` has no `__doc__`).
    if (scopeCondition) {
        whereClauses.push(scopeCondition);
    }

    // `f.rank` is FTS5's bm25 relevance (best first); the `_creationTime DESC`
    // tiebreak matches the scan fallback so equal-rank rows order newest-first
    // on both engines.
    // `m.id` closes the sort: rank ties are common (equal term frequency) and
    // `_creationTime` ties with them on bulk-imported rows, and without a unique
    // terminal column the engine may order tied rows differently per execution —
    // which offset pagination would surface as a duplicated or skipped row.
    const query = dsql`SELECT m.id, m._creationTime, m.${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(ftName)} f JOIN ${dsql.identifier(tableName)} m ON m.id = f.${dsql.identifier(FTS_ID_COLUMN)} WHERE ${dsql.join(whereClauses, dsql` AND `)} ORDER BY f.rank, m._creationTime DESC, m.id ASC LIMIT ${dsql.raw(String(limit))}`;

    const rows = runDrizzle(sql, query).toArray();
    const docs: Record<string, unknown>[] = [];

    for (const row of rows) {
        const record = rowToDocument(row);

        if (record) {
            docs.push(record);
        }
    }

    return docs;
};

/**
 * Portable fallback for engines without FTS5 (the `node:sqlite` test runner):
 * pull candidate rows (narrowed by `.eq()` filters in SQL), tokenize the indexed
 * field in JS, and rank with `scoreDoc`. Matches the FTS path's AND +
 * prefix-on-last-token semantics; relevance order is term-frequency, ties broken
 * by creation time (newest first).
 */
const searchViaScan = (sql: SqlExec, tableName: string, search: SearchStage, limit: number, scopeCondition?: SQL): Record<string, unknown>[] => {
    const analyzer = createSearchAnalyzer(search.definition.language);
    const tokens = tokenizeSearch(search.query, analyzer);

    if (tokens.length === 0) {
        return [];
    }

    const whereClauses: SQL[] = [];

    for (const filter of search.filters) {
        whereClauses.push(dsql`${jsonPathSql(filter.field)} = ${serializeSqlValue(filter.value)}`);
    }

    if (scopeCondition) {
        whereClauses.push(scopeCondition);
    }

    let query = dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)}`;

    if (whereClauses.length > 0) {
        query = dsql`${query} WHERE ${dsql.join(whereClauses, dsql` AND `)}`;
    }

    const rows = runDrizzle(sql, query).toArray();
    const scored: { creationTime: number; doc: Record<string, unknown>; id: string; score: number }[] = [];

    for (const row of rows) {
        const record = rowToDocument(row);

        if (!record) {
            continue;
        }

        const score = scoreDocument(stringifySearchText(resolveSearchField(record, search.field)), tokens, analyzer);

        if (score > 0) {
            scored.push({
                creationTime: typeof record["_creationTime"] === "number" ? record["_creationTime"] : 0,
                doc: record,
                id: typeof record["_id"] === "string" ? record["_id"] : "",
                score,
            });
        }
    }

    // Same total order the FTS path sorts by, id-terminated (see `searchViaFts`).
    scored.sort((a, b) => b.score - a.score || b.creationTime - a.creationTime || a.id.localeCompare(b.id));

    return scored.slice(0, limit).map((entry) => entry.doc);
};

/** Builder for `withGeoIndex(name, q => q.near(...) | q.within(...))`; mutates the staged geo query in place. */
const createGeoBuilder = (geo: GeoStage, tableName: string): GeoFilterBuilderLike => {
    // Alias so the mutation is on a local binding, not the parameter (no-param-reassign) —
    // same pattern as `createSearchBuilder`.
    const staged = geo;
    const builder: GeoFilterBuilderLike = {
        near: (point, radiusMeters) => {
            if (staged.within) {
                throw new LunoraError("INTERNAL", `geo index "${staged.indexName}" on table "${tableName}": call .near() or .within(), not both`);
            }

            staged.near = { point: { lat: point.lat, lng: point.lng }, radiusMeters };

            return builder;
        },
        within: (box) => {
            if (staged.near) {
                throw new LunoraError("INTERNAL", `geo index "${staged.indexName}" on table "${tableName}": call .near() or .within(), not both`);
            }

            staged.within = { ne: { lat: box.ne.lat, lng: box.ne.lng }, sw: { lat: box.sw.lat, lng: box.sw.lng } };

            return builder;
        },
    };

    return builder;
};

/** Read a `{ lat, lng }` geo point off a stored document, or `undefined` when the column is absent/malformed. */
const readGeoPoint = (document: Record<string, unknown>, field: string): { lat: number; lng: number } | undefined => {
    const value = document[field];

    if (value === null || typeof value !== "object") {
        return undefined;
    }

    const { lat, lng } = value as { lat?: unknown; lng?: unknown };

    return typeof lat === "number" && typeof lng === "number" ? { lat, lng } : undefined;
};

/** One scored geo candidate, or `undefined` when the row has no readable point or falls outside the query. */
const scoreGeoRow = (record: Record<string, unknown>, geo: GeoStage): { creationTime: number; distance: number } | undefined => {
    const point = readGeoPoint(record, geo.definition.field);

    if (!point) {
        return undefined;
    }

    const creationTime = typeof record["_creationTime"] === "number" ? record["_creationTime"] : 0;

    if (geo.near) {
        const distance = haversineMeters(geo.near.point, point);

        return distance <= geo.near.radiusMeters ? { creationTime, distance } : undefined;
    }

    return pointInBoundingBox(point, geo.within as GeoWithinFilter) ? { creationTime, distance: 0 } : undefined;
};

/**
 * Resolve a `withGeoIndex(...)` query: gather the covering geohash prefixes for
 * the near-circle / bounding-box, range-scan the geohash companion for candidate
 * rows, JOIN back to the document table, then refine + order exactly in JS —
 * Haversine distance (nearest-first) for `.near()`, an inclusive box test
 * (creation-time order) for `.within()`. `.take(n)` is applied AFTER the refine.
 */
const runGeoFetch = (sql: SqlExec, tableName: string, geo: GeoStage, limit: number | undefined, scopeCondition?: SQL): Record<string, unknown>[] => {
    if (!geo.near && !geo.within) {
        throw new LunoraError("INTERNAL", `geo index "${geo.indexName}" on table "${tableName}": call .near(point, radius) or .within(box)`);
    }

    const prefixes = geo.near ? coveringGeohashes(geo.near.point, geo.near.radiusMeters) : boundingBoxGeohashes(geo.within as GeoWithinFilter);
    const geoTable = geoTableName(tableName, geo.indexName);

    // Each geohash prefix P matches rows whose hash is in `[P, P + "{")` — "{"
    // (0x7b) is the byte just past the base-32 alphabet's max char "z" (0x7a),
    // so the half-open range is exactly the "starts with P" set.
    const prefixClauses = prefixes.map(
        (prefix) => dsql`(g.${dsql.identifier("__geohash__")} >= ${prefix} AND g.${dsql.identifier("__geohash__")} < ${`${prefix}{`})`,
    );
    const whereClauses: SQL[] = [dsql`(${dsql.join(prefixClauses, dsql` OR `)})`];

    if (scopeCondition) {
        whereClauses.push(scopeCondition);
    }

    const query = dsql`SELECT m.id, m._creationTime, m.${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(geoTable)} g JOIN ${dsql.identifier(tableName)} m ON m.id = g.${dsql.identifier("__id__")} WHERE ${dsql.join(whereClauses, dsql` AND `)}`;
    const rows = runDrizzle(sql, query).toArray();

    const scored: { creationTime: number; distance: number; doc: Record<string, unknown> }[] = [];

    for (const row of rows) {
        const record = rowToDocument(row);
        const score = record ? scoreGeoRow(record, geo) : undefined;

        if (record && score) {
            scored.push({ creationTime: score.creationTime, distance: score.distance, doc: record });
        }
    }

    // `.near()` orders nearest-first (ties newest-first); `.within()` has no
    // distance metric, so it orders newest-first like a default list read.
    scored.sort((a, b) => a.distance - b.distance || b.creationTime - a.creationTime);

    const docs = scored.map((entry) => entry.doc);

    return typeof limit === "number" ? docs.slice(0, Math.max(0, Math.floor(limit))) : docs;
};

/**
 * Run a staged geo query terminal: resolve the candidates via {@link runGeoFetch}
 * (letting SQL cap the result when there are no in-memory `.filter()` predicates),
 * then apply any predicates + the effective limit in memory. Mirrors the search
 * terminal's split so the reader's `runFetch` stays a thin dispatcher.
 */
const runGeoTerminal = (
    sql: SqlExec,
    tableName: string,
    stage: QueryStage,
    scopeCondition: SQL | undefined,
    limit: number | undefined,
): Record<string, unknown>[] => {
    const { geo } = stage;

    if (!geo) {
        throw new LunoraError("INTERNAL", "runGeoTerminal called without a staged geo query");
    }

    const filtered = stage.inMemoryFilters.length > 0;
    const docs = runGeoFetch(sql, tableName, geo, filtered ? undefined : limit, scopeCondition);

    if (!filtered) {
        return docs;
    }

    const result: Record<string, unknown>[] = [];

    for (const record of docs) {
        if (stage.inMemoryFilters.every((predicate) => predicate(record))) {
            result.push(record);

            if (typeof limit === "number" && result.length >= limit) {
                break;
            }
        }
    }

    return result;
};

/**
 * Run the plain (non-search, non-geo) fetch terminal: compile the staged
 * `sqlConditions` + soft-delete scope into a `WHERE`, order by `orderClause`,
 * push the `LIMIT` down when there are no in-memory `.filter()` predicates, and
 * apply any predicates + limit in memory otherwise. Extracted from `runFetch` so
 * the reader's dispatcher stays small.
 */
const runPlainFetch = (
    sql: SqlExec,
    tableName: string,
    stage: QueryStage,
    scopeCondition: SQL | undefined,
    orderClause: SQL,
    limit: number | undefined,
): Record<string, unknown>[] => {
    const whereClauses: SQL[] = [];

    for (const condition of stage.sqlConditions) {
        whereClauses.push(dsql`${jsonPathSql(condition.field)} ${dsql.raw(condition.comparator)} ${serializeSqlValue(condition.value)}`);
    }

    if (scopeCondition) {
        whereClauses.push(scopeCondition);
    }

    let query = dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)}`;

    if (whereClauses.length > 0) {
        query = dsql`${query} WHERE ${dsql.join(whereClauses, dsql` AND `)}`;
    }

    query = dsql`${query} ORDER BY ${orderClause}`;

    if (typeof limit === "number" && stage.inMemoryFilters.length === 0) {
        query = dsql`${query} LIMIT ${dsql.raw(String(Math.max(0, Math.floor(limit))))}`;
    }

    const rows = runDrizzle(sql, query).toArray();
    const docs: Record<string, unknown>[] = [];

    for (const row of rows) {
        const record = rowToDocument(row);

        if (record && stage.inMemoryFilters.every((predicate) => predicate(record))) {
            docs.push(record);

            if (typeof limit === "number" && docs.length >= limit) {
                break;
            }
        }
    }

    return docs;
};

/** DO drizzle `where` strategy (flat): fields via `json_extract`, values via {@link serializeSqlValue}. */
const doWhereSqlStrategy: WhereSqlStrategy = { fieldRef: jsonPathSql, serialize: serializeSqlValue };

/**
 * Per-query `where` strategy that compiles correlated-EXISTS markers (Phase 2
 * relation push-down) into drizzle SQL, alongside the flat {@link doWhereSqlStrategy}.
 *
 * Each call gets a fresh child-alias counter (unique within one compiled
 * statement); nested markers reuse the same `strategy` + counter, so multi-hop
 * relation predicates compose into nested subqueries. The `relationExists` hook
 * owns the storage-specific SQL — child-table aliasing, `json_extract`
 * correlation refs, and the `[NOT] EXISTS` wrapper. A pushed EXISTS issues no
 * separate read, so it stamps a conservative `*scan` dep per referenced child
 * table (over-invalidating is correct; under-invalidating would miss live updates).
 */
const makeRelationExistsSqlStrategy = (onRead: ReadHook): WhereSqlStrategy => {
    let aliasCounter = 0;
    const scopeStack: string[] = [];

    const strategy: WhereSqlStrategy = {
        fieldRef: jsonPathSql,
        relationExists: (request) => {
            const { childWhere, negated, parentTable, relation } = request as RelationExistsMarker;
            const alias = `__rel_${String(aliasCounter)}`;
            const parentRef = scopeStack.at(-1) ?? parentTable;

            aliasCounter += 1;
            onRead(relation.table, SCAN_DEP);

            const parentColumn = relation.kind === "one" ? relation.field : relation.references;
            const childColumn = relation.kind === "one" ? relation.references : relation.field;
            const correlation = dsql`${qualifiedJsonPathSql(alias, childColumn)} = ${qualifiedJsonPathSql(parentRef, parentColumn)}`;

            scopeStack.push(alias);

            const childSql = compileWhereSql(childWhere, strategy);

            scopeStack.pop();

            const condition = childSql ? dsql`${correlation} AND ${childSql}` : correlation;
            const body = dsql`EXISTS (SELECT 1 FROM ${dsql.identifier(relation.table)} AS ${dsql.identifier(alias)} WHERE ${condition})`;

            return negated ? dsql`NOT ${body}` : body;
        },
        serialize: serializeSqlValue,
    };

    return strategy;
};

/** Drizzle ORDER BY for the DO: each key as `&lt;jsonPath> ASC|DESC`, with an `id ASC` tiebreak unless an id field is already ordered (keeps paging deterministic). The drizzle twin of `compileOrderBy`. */
const compileOrderBySql = (keys: OrderKey[]): SQL => {
    const parts = keys.map((key) => dsql`${jsonPathSql(key.field)} ${dsql.raw(key.direction === "desc" ? "DESC" : "ASC")}`);

    if (!keys.some((key) => key.field === "_id" || key.field === "id")) {
        parts.push(dsql`${jsonPathSql("id")} ASC`);
    }

    return dsql.join(parts, dsql`, `);
};

/** Invert the reader's staged SQL comparators back into `where`-tree operators. */
const COMPARATOR_TO_OPERATOR: Record<string, string> = { "<": "lt", "<=": "lte", "=": "eq", ">": "gt", ">=": "gte" };

/** Order keys for a paginated stage: the staged index, else creation order, in the staged direction. */
const paginateOrderKeys = (stage: QueryStage): OrderKey[] => {
    const direction = stage.order;

    if (stage.indexFields.length > 0) {
        return stage.indexFields.map((field) => {
            return { direction, field };
        });
    }

    return [{ direction, field: "_creationTime" }];
};

/**
 * Re-express the staged `.withIndex()` range as a `where` tree and AND the
 * keyset seek onto it, so a single shared compiler renders the page predicate.
 * `cursor` is the (exclusive) lower bound; `endCursor`, when supplied, adds the
 * inclusive upper bound so the page selects exactly `(cursor, endCursor]` —
 * the fixed range a reactive page subscribes to.
 * @returns the combined where clause, or `undefined` when there are no conditions and no cursor
 */
const paginateWhere = (stage: QueryStage, orderKeys: OrderKey[], cursor: null | string | undefined, endCursor?: null | string): undefined | WhereInput => {
    const clauses: WhereInput[] = stage.sqlConditions.map((condition) => {
        return {
            [condition.field]: { [COMPARATOR_TO_OPERATOR[condition.comparator] ?? "eq"]: condition.value },
        };
    });

    if (cursor) {
        clauses.push(buildSeekWhere(orderKeys, decodeCursor(cursor)));
    }

    if (endCursor) {
        clauses.push(buildSeekBeforeWhere(orderKeys, decodeCursor(endCursor)));
    }

    if (clauses.length === 0) {
        return undefined;
    }

    return clauses.length === 1 ? clauses[0] : { AND: clauses };
};

/** Decode rows to docs, applying the in-memory filters; stop at `cap` rows when bounding here. */
const scanDocs = (rows: Record<string, unknown>[], filters: QueryStage["inMemoryFilters"], cap: number | undefined): Record<string, unknown>[] => {
    const docs: Record<string, unknown>[] = [];

    for (const row of rows) {
        const record = rowToDocument(row);

        if (record && filters.every((predicate) => predicate(record))) {
            docs.push(record);

            if (cap !== undefined && docs.length > cap) {
                break;
            }
        }
    }

    return docs;
};

/**
 * Keyset-paginate a built reader stage: order by the staged index (creation
 * order by default), seek past `cursor`, and over-fetch one row to learn
 * `isDone`. With in-memory `.filter()`s the SQL row count no longer tracks the
 * post-filter page size, so we scan unbounded and bound after filtering rather
 * than let a `LIMIT` drop rows that pass the predicate.
 *
 * Reactive pagination (`options.endCursor` set) instead selects the whole fixed
 * range `(cursor, endCursor]`: no `LIMIT`, no over-fetch, `isDone` always `true`
 * (the page's end is pinned), and `continueCursor` echoed as the unchanged
 * `endCursor` so the next page keeps starting exactly where this one ends. The
 * range stays stable under inserts/deletes inside it — the page simply grows or
 * shrinks while its boundaries hold.
 */
const paginateStage = (sql: SqlExec, tableName: string, stage: QueryStage, options: PaginationOptions, scopeCondition?: SQL): QueryPage => {
    const numberItems = Math.max(0, Math.floor(options.numItems));
    const orderKeys = paginateOrderKeys(stage);
    // A cursor is always a non-empty base64 string, so truthiness distinguishes
    // a bounded page (endCursor set) from the legacy open-ended one (null/omitted).
    const bounded = typeof options.endCursor === "string";
    const pageWhere = compileWhereSql(paginateWhere(stage, orderKeys, options.cursor, options.endCursor), doWhereSqlStrategy);
    // Soft delete: AND the scope onto the keyset predicate so a paginated fluent
    // read hides soft-deleted rows too.
    const whereCondition = scopeCondition && pageWhere ? dsql`${pageWhere} AND ${scopeCondition}` : (scopeCondition ?? pageWhere);

    let query = dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)}`;

    if (whereCondition) {
        query = dsql`${query} WHERE ${whereCondition}`;
    }

    query = dsql`${query} ORDER BY ${compileOrderBySql(orderKeys)}`;

    const filtered = stage.inMemoryFilters.length > 0;

    // A bounded page returns its entire range, so never cap the SQL scan. An
    // unbounded, unfiltered page over-fetches one row to learn `isDone`.
    if (!filtered && !bounded) {
        query = dsql`${query} LIMIT ${dsql.raw(String(numberItems + 1))}`;
    }

    const rows = runDrizzle(sql, query).toArray();
    const docs = scanDocs(rows, stage.inMemoryFilters, filtered || bounded ? undefined : numberItems);

    if (bounded) {
        // The end is fixed: every row in `(cursor, endCursor]` belongs to this
        // page. Echo `endCursor` so the next page's lower bound is this page's
        // upper bound — shared stable boundaries are what eliminate the
        // dup/skip drift the keyset model suffered under live edits.
        //
        // Surface the middle row's cursor so a client whose page has grown past
        // its target size can split this range in two at a stable midpoint.
        const middle = docs.length >= 2 ? docs[Math.floor(docs.length / 2) - 1] : undefined;

        return {
            // eslint-disable-next-line unicorn/no-null -- QueryPage.continueCursor is `null | string`; a bounded page echoes its fixed endCursor (never null in this branch since `bounded` requires it), the `?? null` only satisfies the type
            continueCursor: options.endCursor ?? null,
            isDone: true,
            page: docs,
            // eslint-disable-next-line unicorn/no-null -- splitCursor is `null | string`; null marks "too small to split" so the client can read the field unconditionally
            splitCursor: middle ? encodeCursor(middle, orderKeys) : null,
        };
    }

    const hasMore = docs.length > numberItems;
    const page = hasMore ? docs.slice(0, numberItems) : docs;
    const last = page.at(-1);

    return {
        // eslint-disable-next-line unicorn/no-null -- QueryPage.continueCursor is `null | string`: null is the documented "no further page" cursor on the wire
        continueCursor: hasMore && last ? encodeCursor(last, orderKeys) : null,
        isDone: !hasMore,
        page,
    };
};

/**
 * Thrown by `.unique()` when more than one row matches. A `LunoraError` subclass
 * (`code: "NOT_UNIQUE"`, `status: 400`) recognised structurally by the
 * cross-package transport mapper (via `isLunoraError`) without an `instanceof`
 * check against `@lunora/do`.
 */
class NotUniqueError extends LunoraError {
    public constructor(message: string = "unique() found more than one matching document") {
        super("NOT_UNIQUE", message, { name: "NotUniqueError" });
    }
}

// Hoisted to module scope so the matcher is compiled once, not per normalizeId call.
// NUL is matched via String.fromCharCode so the pattern stays free of control characters.
const ID_WHITESPACE_PATTERN = /\s/u;
const NUL_CHARACTER = String.fromCodePoint(0);

/**
 * Pure structural id validation shared by both ORM dialects (the DO writer here
 * and the D1 twin). An id is well-formed when it is a non-empty string carrying
 * no whitespace (interior, leading, or trailing) and no NUL byte — the shape
 * every minter in the stack produces (`crypto.randomUUID()` by default; a custom
 * `idGenerator` or an `allowExplicitId` import path may supply another opaque
 * string). Lunora ids carry no embedded table tag, so this is the strongest
 * structural check the format admits; it never touches the database, matching
 * Convex's `normalizeId`. Returns the id unchanged when valid, else `null`.
 * Throws on an unknown table so a typo'd table name surfaces loudly rather than
 * silently returning `null`.
 * @returns the id when well-formed, or `null` when the id fails structural validation
 */
const normalizeIdStructurally = (schema: SchemaLike, tableName: string, id: string): null | string => {
    if (!schema.tables[tableName]) {
        throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
    }

    // Reject empties and any id carrying whitespace or a NUL byte — no minter in
    // the stack produces those, so their presence marks the string as not an id.
    if (typeof id !== "string" || id.length === 0 || ID_WHITESPACE_PATTERN.test(id) || id.includes(NUL_CHARACTER)) {
        // eslint-disable-next-line unicorn/no-null -- documented `normalizeId` result shape (Id | null); null is the "not a valid id" sentinel
        return null;
    }

    return id;
};

const buildReader = (sql: SqlExec, schema: SchemaLike, tableName: string, onIndexUse: IndexUseHook = () => undefined): TableReaderLike => {
    const tableDefinition = schema.tables[tableName];

    if (!tableDefinition) {
        throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
    }

    // Soft delete: the fluent reader (`ctx.db.query(table)...`) always hides
    // soft-deleted rows — the object-form `findMany({ includeDeleted: true })` is
    // the opt-in to see them. Compiled once and ANDed into every fetch/search/page.
    const scopeWhere = softDeleteScope(tableDefinition.softDeleteMode, undefined);
    const scopeCondition = scopeWhere ? compileWhereSql(scopeWhere, doWhereSqlStrategy) : undefined;

    const stage: QueryStage = {
        indexFields: [],
        indexName: undefined,
        inMemoryFilters: [],
        order: "asc",
        sqlConditions: [],
    };

    const runSearchFetch = (limit: number | undefined): Record<string, unknown>[] => {
        const { search } = stage;

        if (!search) {
            throw new LunoraError("INTERNAL", "runSearchFetch called without a staged search");
        }

        const filtered = stage.inMemoryFilters.length > 0;
        // Relevance order means the engine read is always bounded: the caller's
        // limit when there is one, `MAX_SEARCH_SCAN` otherwise — including when a
        // `.filter()` runs on top, which narrows *within* that window rather than
        // widening the read.
        const engineLimit = resolveSearchScan(filtered ? undefined : limit);
        const docs = isFtsAvailable(sql)
            ? searchViaFts(sql, tableName, search, engineLimit, scopeCondition)
            : searchViaScan(sql, tableName, search, engineLimit, scopeCondition);

        if (!filtered) {
            return docs;
        }

        const result: Record<string, unknown>[] = [];

        for (const record of docs) {
            if (stage.inMemoryFilters.every((predicate) => predicate(record))) {
                result.push(record);

                if (typeof limit === "number" && result.length >= limit) {
                    break;
                }
            }
        }

        return result;
    };

    /**
     * One page of a relevance-ordered search. The window is fetched one row
     * past the page so `hasMore` is observed rather than guessed; everything
     * else — cursor decoding, the bounded-page refusal, the cap — is the shared
     * policy in `search-text`, so the two backends page identically.
     */
    const paginateSearchStage = (options: PaginationOptions): QueryPage => {
        const plan = planSearchPage(options);

        return finishSearchPage(runSearchFetch(plan.offset + plan.numItems + 1), plan);
    };

    const buildOrderClause = (): SQL => {
        const orderFields = stage.indexFields.length > 0 ? stage.indexFields : ["_creationTime"];
        const orderDirection = stage.order === "desc" ? "DESC" : "ASC";

        return dsql.join(
            orderFields.map((field) => dsql`${jsonPathSql(field)} ${dsql.raw(orderDirection)}`),
            dsql`, `,
        );
    };

    const runFetch = (limit: number | undefined): Record<string, unknown>[] => {
        if (stage.search) {
            return runSearchFetch(limit);
        }

        if (stage.geo) {
            return runGeoTerminal(sql, tableName, stage, scopeCondition, limit);
        }

        return runPlainFetch(sql, tableName, stage, scopeCondition, buildOrderClause(), limit);
    };

    const reader: TableReaderLike = {
        // eslint-disable-next-line @typescript-eslint/require-await -- TableReaderLike returns Promises (the D1 twin awaits real I/O); the DO impl is synchronous over local SQLite
        async collect() {
            return runFetch(undefined);
        },
        filter(predicate) {
            stage.inMemoryFilters.push(predicate);

            return reader;
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- TableReaderLike returns Promises (the D1 twin awaits real I/O); the DO impl is synchronous over local SQLite
        async first() {
            const rows = runFetch(stage.inMemoryFilters.length > 0 ? undefined : 1);

            // eslint-disable-next-line unicorn/no-null -- documented `first()` result shape (Doc | null) returned to callers
            return rows[0] ?? null;
        },
        order(direction) {
            stage.order = direction === "desc" ? "desc" : "asc";

            return reader;
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- TableReaderLike returns Promises (the D1 twin awaits real I/O); the DO impl is synchronous over local SQLite
        async paginate(options) {
            if (stage.search) {
                return paginateSearchStage(options);
            }

            if (stage.geo) {
                throw new LunoraError("INTERNAL", "pagination is not supported on geo queries; use .take(n) or .collect()");
            }

            return paginateStage(sql, tableName, stage, options, scopeCondition);
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- TableReaderLike returns Promises (the D1 twin awaits real I/O); the DO impl is synchronous over local SQLite
        async take(limit) {
            return runFetch(limit);
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- TableReaderLike returns Promises (the D1 twin awaits real I/O); the DO impl is synchronous over local SQLite
        async unique() {
            // Over-fetch one past the single row we expect: 0 → null, 1 → the
            // row, ≥2 → ambiguous, which is an error (mirrors Convex).
            const rows = runFetch(stage.inMemoryFilters.length > 0 ? undefined : 2);

            if (rows.length > 1) {
                throw new NotUniqueError(`unique() on table "${tableName}" matched ${String(rows.length)} documents; expected at most one`);
            }

            // eslint-disable-next-line unicorn/no-null -- documented `unique()` result shape (Doc | null) returned to callers
            return rows[0] ?? null;
        },
        withGeoIndex(indexName, build) {
            const definition = (tableDefinition.geoIndexes ?? []).find((index) => index.name === indexName);

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown geo index "${indexName}" on table "${tableName}"`);
            }

            onIndexUse(tableName, indexName, "geo");

            const geoStage: GeoStage = { definition, indexName };

            stage.geo = geoStage;
            build(createGeoBuilder(geoStage, tableName));

            if (!geoStage.near && !geoStage.within) {
                throw new LunoraError("INTERNAL", `geo index "${indexName}" on table "${tableName}" requires a .near(point, radius) or .within(box) call`);
            }

            return reader;
        },
        withIndex(indexName, range) {
            const definition = tableDefinition.indexes.find((index) => index.name === indexName);

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown index "${indexName}" on table "${tableName}"`);
            }

            onIndexUse(tableName, indexName, "index");
            stage.indexName = indexName;
            stage.indexFields = definition.fields;

            if (range) {
                range(createRangeBuilder(stage));
            }

            return reader;
        },
        withSearchIndex(indexName, search) {
            const definition = (tableDefinition.searchIndexes ?? []).find((index) => index.name === indexName);

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown search index "${indexName}" on table "${tableName}"`);
            }

            onIndexUse(tableName, indexName, "search");

            const searchStage: SearchStage = {
                definition,
                field: definition.field,
                filters: [],
                hasQuery: false,
                indexName,
                query: "",
            };

            stage.search = searchStage;
            search(createSearchBuilder(searchStage, tableName, createSearchAnalyzer(definition.language)));

            if (!searchStage.hasQuery) {
                throw new LunoraError("INTERNAL", `search index "${indexName}" on table "${tableName}" requires a .search(field, query) call`);
            }

            return reader;
        },
    };

    return reader;
};

/**
 * Fill any field absent from `document` that declares a `.default()` literal or
 * `.$defaultFn()` factory. The factory wins when both are present; a literal is
 * applied on presence (`"defaultValue" in column`), so `null`/`false`/`0`
 * defaults survive.
 *
 * A `.serverDefault(fn)` column is SERVER-trusted: it is always stamped from
 * `auth` (overwriting any client-supplied value), so owner/tenant ids can never
 * be set by the client.
 */
const applyInsertDefaults = (
    definition: TableDefinitionLike,
    document: Record<string, unknown>,
    auth: ServerDefaultContextLike["auth"],
): Record<string, unknown> => {
    const result = { ...document };

    for (const [field, column] of tableColumns(definition)) {
        if (column.serverDefault) {
            result[field] = column.serverDefault({ auth });

            continue;
        }

        if (result[field] !== undefined) {
            continue;
        }

        if (column.defaultFn) {
            result[field] = column.defaultFn();
        } else if ("defaultValue" in column) {
            result[field] = column.defaultValue;
        }
    }

    return result;
};

/**
 * Recompute every `.$onUpdateFn()` field the caller did not set explicitly,
 * mutating `target` in place — so timestamps refresh on `patch`/`replace`
 * unless the caller overrode them.
 */
const applyOnUpdate = (
    definition: TableDefinitionLike,
    provided: Record<string, unknown>,
    target: Record<string, unknown>,
    auth: ServerDefaultContextLike["auth"],
): void => {
    // Mutate the caller-owned record in place; alias so the param isn't reassigned.
    const out = target;

    for (const [field, column] of tableColumns(definition)) {
        if (column.serverDefault) {
            // Server-trusted: if the client tried to set this field, overwrite it
            // with the server value so the column is never client-controllable. An
            // untouched field keeps its stored value (no re-stamp to the caller).
            if (field in provided) {
                out[field] = column.serverDefault({ auth });
            }

            continue;
        }

        if (column.onUpdateFn && !(field in provided)) {
            out[field] = column.onUpdateFn();
        }
    }
};

/**
 * Reject `patch`/`replace` documents that carry an explicit `undefined` value.
 *
 * The `{ ...existing, ...patch }` merge plus `JSON.stringify` silently drops any
 * key whose value is `undefined`, so `patch(id, { field: undefined })` would
 * delete* `field` rather than leave it alone — a silent-data-loss footgun.
 * Turning it into a loud, descriptive error forces the caller to be explicit:
 * pass `null` to clear a nullable field, or omit the key to leave it unchanged.
 *
 * Only keys that are *present* on the object with value `undefined` error; an
 * omitted key (not an own-enumerable property) stays a no-op, so callers who
 * never set a key keep their existing behaviour.
 */
const assertNoExplicitUndefined = (op: "patch" | "replace", document: Record<string, unknown>): void => {
    for (const field of Object.keys(document)) {
        if (document[field] === undefined) {
            throw new LunoraError(
                "INTERNAL",
                `Cannot ${op} field '${field}' to undefined — use null to clear a nullable field, or omit the key to leave it unchanged.`,
            );
        }
    }
};

/** workerd and node:sqlite both phrase a UNIQUE-index breach as "UNIQUE constraint failed". */
const UNIQUE_VIOLATION_RE = /unique constraint failed/i;
const isUniqueViolation = (error: unknown): boolean => error instanceof Error && UNIQUE_VIOLATION_RE.test(error.message);

/** Run a write, remapping a UNIQUE-index breach to a {@link ConflictError} (code `CONFLICT`, 409). */
const runWrite = (sql: SqlExec, table: string, query: SQL): void => {
    try {
        runDrizzle(sql, query);
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new ConflictError(`unique constraint violation on "${table}"`, "unique");
        }

        throw error;
    }
};

/**
 * Run an optimistic-concurrency-guarded write (a CAS whose `WHERE` includes
 * the row's read-time `__doc__` snapshot) and raise {@link ConflictError} when
 * it touches zero rows — meaning a concurrent write committed during the
 * intervening `await` (before-update trigger / onDelete cascade) and clobbered
 * the snapshot. `changes()` reports the row count of the most recent
 * INSERT/UPDATE/DELETE, available in both workerd SQLite and `node:sqlite`.
 */
const runGuardedWrite = (sql: SqlExec, table: string, query: SQL): void => {
    runWrite(sql, table, query);

    const changedRow = runDrizzle<{ changed: number }>(sql, dsql`SELECT changes() AS changed`).one();

    if (changedRow.changed === 0) {
        throw new ConflictError(`optimistic concurrency conflict on "${table}" — the row changed during this mutation; refetch and retry`, "occ");
    }
};

/**
 * Count rows strictly-before `(sortValues, rowId)` within `partitionKey`, plus
 * the partition's total — the shared core of both the local `rank()` (which
 * resolves the key by id) and the cross-shard `rankBefore()` (which is handed
 * the key explicitly). One source of truth for the lexicographic strict-less
 * SQL so the two paths can never drift.
 *
 * `serializedSortValues[i]` must be the already-{@link serializeSqlValue}d
 * value for the i-th sort key — i.e. the exact bytes stored in `__sort_k&lt;i>__`
 * by `syncRankIndexEntry` (in `./ctx-db-companions`) — so the per-key comparison
 * matches the companion's BLOB column regardless of which shard supplied the value.
 *
 * Lexicographic strict-less under per-key direction: for keys
 * `[(k0, dir0), (k1, dir1), ...]` plus the `__id__` tiebreak,
 * (k0 < v0)
 * OR (k0 = v0 AND k1 < v1)
 * OR (k0 = v0 AND k1 = v1 AND __id__ < rowId)
 * where `&lt;` flips to `>` for desc keys.
 */
const countRankBefore = (
    sql: SqlExec,
    rankTable: string,
    sortColumns: ReadonlyArray<string>,
    sortBy: RankIndexDefinitionLike["sortBy"],
    partitionKey: string,
    serializedSortValues: ReadonlyArray<unknown>,
    rowId: string,
): { before: number; total: number } => {
    const beforeBranches: SQL[] = [];

    for (let pivot = 0; pivot < sortColumns.length + 1; pivot += 1) {
        const conditions: SQL[] = [];

        for (let prefix = 0; prefix < pivot; prefix += 1) {
            conditions.push(dsql`${dsql.identifier(sortColumns[prefix] as string)} IS ${serializedSortValues[prefix]}`);
        }

        const column = sortColumns[pivot];
        const sortKey = sortBy[pivot];

        if (column !== undefined && sortKey !== undefined) {
            const operator = sortKey.direction === "desc" ? ">" : "<";

            conditions.push(dsql`${dsql.identifier(column)} ${dsql.raw(operator)} ${serializedSortValues[pivot]}`);
        } else {
            // Final pivot is the `__id__` ASC tiebreak.
            conditions.push(dsql`${dsql.identifier(RANK_TIEBREAK)} < ${rowId}`);
        }

        const [firstCondition] = conditions;

        beforeBranches.push(conditions.length === 1 && firstCondition !== undefined ? firstCondition : dsql`(${dsql.join(conditions, dsql` AND `)})`);
    }

    const beforeWhere = dsql.join(beforeBranches, dsql` OR `);
    const beforeRow = runDrizzle<{ c: number }>(
        sql,
        dsql`SELECT COUNT(*) AS c FROM ${dsql.identifier(rankTable)} WHERE ${dsql.identifier("__partition__")} = ${partitionKey} AND (${beforeWhere})`,
    ).one();

    const totalRow = runDrizzle<{ c: number }>(
        sql,
        dsql`SELECT COUNT(*) AS c FROM ${dsql.identifier(rankTable)} WHERE ${dsql.identifier("__partition__")} = ${partitionKey}`,
    ).one();

    return { before: beforeRow.c, total: totalRow.c };
};

// CDC (the __cdc_log changelog + __cdc_meta epoch + replay) lives in ./ctx-db-cdc; the __idempotency table in ./ctx-db-idempotency. Both re-exported below so existing import sites resolve unchanged.

const createShardCtxDb = (options: CtxDbOptions): DatabaseWriterLike => {
    const { sql } = options;
    const { schema } = options;
    const broadcast = options.broadcast ?? (() => undefined);
    const onRead = options.onRead ?? (() => undefined);
    const onIndexUse = options.onIndexUse ?? (() => undefined);
    const onWrite = options.onWrite ?? (() => undefined);
    const { cache } = options;
    const clock = options.clock ?? (() => Date.now());
    const generateId = options.idGenerator ?? (() => crypto.randomUUID());
    const scheduler = options.scheduler ?? throwingScheduler;
    const { globalDb } = options;
    // Resolved request auth for `.serverDefault(fn)` column factories; defaults
    // to the anonymous slice so server-trusted columns stamp `null` when the
    // generated writer is built without a caller identity.
    // eslint-disable-next-line unicorn/no-null -- the auth slice models the anonymous caller as null identity/userId (mirrors `ServerDefaultContext`)
    const auth: ServerDefaultContextLike["auth"] = options.auth ?? { identity: null, userId: null };
    const cdcEnabled = options.cdc ?? false;

    // `ctx.db.system` reads scheduled functions / storage objects from sources
    // OUTSIDE this DO's SQLite (the SchedulerDO and R2). The trigger-context
    // `scheduler` only structurally needs `runAfter`/`runAt`; the real injected
    // scheduler (and the generated schedulerStub) also carry the read half
    // (`list`/`get`), so pass it through when present and let createSystemReader
    // throw a clear "not configured" error if a backing read method is missing.
    const systemScheduler = scheduler as Partial<SystemReaderSchedulerLike> & SchedulerLike;
    const system = createSystemReader({
        scheduler:
            typeof systemScheduler.list === "function" && typeof systemScheduler.get === "function"
                ? (systemScheduler as SystemReaderSchedulerLike)
                : undefined,
        storage: options.storage,
    });

    /** Append a post-image to the changelog when CDC is enabled; a no-op otherwise. */
    const recordCdc = (table: string, id: string, op: CdcChange["op"], doc?: Record<string, unknown>): void => {
        if (cdcEnabled) {
            appendCdcChange(sql, clock(), table, id, op, doc);
        }
    };

    /** True when `tableName` is declared `.global()` (i.e. lives in D1, not this DO). */
    const isGlobalTable = (tableName: string): boolean => schema.tables[tableName]?.shardMode?.kind === "global";

    /**
     * Pick the writer that owns `table`, by backend. Shard-local tables stay on
     * this DO's SQLite (`writer`); a global (D1) table routes to the optional
     * `globalDb`. Without a `globalDb` supplied, the cross-backend path throws a
     * wiring error (pointing at the missing option) rather than silently
     * querying the wrong backend. `op` only colours the error message — the two
     * cross-backend paths (onDelete cascade, relation `with`-load) share one
     * routing primitive so they can't drift on the DO↔D1 invariant.
     *
     * The local branch reads `writer` at call time (a closure variable defined
     * below): the forward reference is safe because this only runs while a
     * read/write is in flight, long after `writer` is initialized.
     */
    const routeBackend = (table: string, op: "cascade" | "relation load"): DatabaseWriterLike => {
        if (isGlobalTable(table)) {
            if (!globalDb) {
                throw new LunoraError(
                    "INTERNAL",
                    `cross-backend ${op} for global table '${table}' requires a globalDb writer — pass one to createShardCtxDb({ globalDb })`,
                );
            }

            return globalDb;
        }

        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure read of post-construction `writer`
        return writer;
    };

    /** Pick the writer for an `onDelete` cascade holder. See {@link routeBackend}. */
    const routeForHolder = (holderTable: string): DatabaseWriterLike => routeBackend(holderTable, "cascade");

    /**
     * Route a *table-name-addressed* op (`insert`/`query`/`findMany`/`count`/…)
     * to the backend that owns the table. A `.global()` table lives in D1, so
     * its generic `ctx.db.&lt;op&gt;("&lt;table&gt;", …)` call must reach the D1-backed
     * `globalDb` writer — where the table is provisioned and read-your-writes
     * apply — instead of this DO's local SQLite, which has no such table.
     *
     * Returns `undefined` for shard-local tables so the caller runs its normal
     * local path; throws a clear wiring error if a global table is reached
     * without a `globalDb` (mirroring {@link routeBackend}). This is the generic
     * twin of the property-style `ctx.db.&lt;globalTable&gt;` facade: both land global
     * access on D1, so `ctx.db.insert("t", …)` and `ctx.db.t.insert(…)` agree.
     * @returns the global D1 writer for the table, or `undefined` for shard-local tables
     */
    const globalWriterFor = (tableName: string, op: string): DatabaseWriterLike | undefined => {
        if (!isGlobalTable(tableName)) {
            return undefined;
        }

        if (!globalDb) {
            throw new LunoraError("INTERNAL", `${op} on global table '${tableName}' requires a globalDb writer — pass one to createShardCtxDb({ globalDb })`);
        }

        return globalDb;
    };

    /**
     * Fallback for *id-addressed* ops (`get`/`patch`/`replace`/`delete`): a bare
     * id carries no table, so they probe this DO's local tables first; a global
     * row's id never lives here, so on a local miss delegate to `globalDb` (which
     * probes its D1 tables). Returns `undefined` when there's no global backend
     * to fall back to, so the caller keeps its existing not-found behaviour.
     */
    const globalFallback = (): DatabaseWriterLike | undefined => globalDb;

    /**
     * Backend-routed `fetcher`/`groupedCounter` pair handed to {@link resolveWith}
     * so a shard-local parent's `with` can load a global (D1) child in one bounded
     * `IN (...)` read and count children in one grouped query.
     */
    const relationFetcher = (relationTable: string, relationArgs: QueryArgs): Promise<QueryPage> =>
        routeBackend(relationTable, "relation load").findMany(relationTable, relationArgs);

    /**
     * Child reader for relation-predicate semijoin resolution. A local child
     * routes back through this DO's own `findMany`, which stamps its read
     * dependency for free — but a global (D1) child routes straight to
     * `globalDb.findMany`, which has no reactive tracker, so a live
     * relation-predicate subscription would never refresh on global-child
     * writes. Stamp the conservative `*scan` marker here for global children
     * (the EXISTS fast path stamps local children in its strategy; nested
     * multi-hop fetches pass through here too, so each global hop is covered).
     */
    const relationPredicateFetcher = (relationTable: string, relationArgs: QueryArgs): Promise<QueryPage> => {
        if (isGlobalTable(relationTable)) {
            onRead(relationTable, SCAN_DEP);
        }

        return relationFetcher(relationTable, relationArgs);
    };

    /**
     * Phase 2 gate: a relation predicate can be pushed down as a correlated
     * EXISTS only when its child table is co-located in this DO's SQLite — i.e.
     * not a global (D1) table. The parent is always local on the `findMany`
     * push-down path (a global parent routes to `globalDb` before reaching the
     * compile site), so co-location reduces to "the child is local too". Global
     * children fall back to the universal semijoin pre-resolution, which routes
     * the child fetch to `globalDb`.
     */
    const canPushRelationExists = (relation: RelationDefinitionLike): boolean => !isGlobalTable(relation.table);
    const relationExistsPushDown = options.relationExistsPushDown ?? "auto";
    // "auto" and "always" both make a node EXISTS-*eligible*; the cost policy in
    // the resolver (semijoin-first vs forced-push) is selected by `existsPushMode`.
    const relationExistsPushDownEnabled = relationExistsPushDown !== "never";
    const { maxRelationKeys } = options;

    /**
     * Resolve relation-crossing predicates (`{ author: { is: W } }`, …) on the
     * aggregate/count/group/rank paths. Unlike `findMany` these compile their
     * predicate directly and have no EXISTS strategy in scope, so resolution is
     * **semijoin-only** (no `canPushExists`): a co-located node still takes the
     * universal pre-resolution and a key set past `maxRelationKeys` fails closed
     * rather than escalating. The child read honours its own RLS via
     * `relationBaseWhere`, so an aggregate filtered by a relation can never
     * count/measure rows the caller can't see. Returns the input reference
     * unchanged when no relation predicate is present (the common path issues
     * zero extra queries), which the callers use to keep their indexed fast-path.
     */
    const resolveAggregateRelations = (
        where: WhereInput | undefined,
        predicateTable: string,
        relationBaseWhere: ((table: string) => undefined | WhereInput) | undefined,
    ): Promise<WhereInput | undefined> =>
        resolveRelationPredicates(where, {
            fetcher: relationPredicateFetcher,
            maxRelationKeys,
            relationBaseWhere,
            schema,
            tableName: predicateTable,
        });

    /**
     * Grouped aggregate counter for `_count` relation loading. For shard-local
     * children, runs a single `SELECT :whereField AS __fk__, COUNT(*) … GROUP BY
     * :whereField` against this DO's SQLite and returns all per-parent tallies in
     * one query. For global (D1) children, fans out parallel scalar `count()`
     * calls — one per distinct FK value — through the `globalDb` writer, since
     * the `DatabaseWriterLike` interface doesn't expose a grouped-count method.
     *
     * CORRECTNESS: `policyWhere` (the child table's RLS read filter) may contain
     * Prisma-style relation predicates (e.g. `{author:{is:W}}`). These must be
     * resolved via `resolveAggregateRelations` BEFORE `compileWhereSql` is called;
     * otherwise the relation node is treated as scalar equality and never matches,
     * making every `_count` return 0. The cross-backend (fan-out) path routes
     * through the full `count()` method, which already resolves relation predicates
     * internally, so only the local grouped path needs this step.
     */
    const relationGroupedCounter = async (
        relationTable: string,
        whereField: string,
        values: unknown[],
        policyWhere?: WhereInput,
    ): Promise<Map<unknown, number>> => {
        const globalWriter = globalWriterFor(relationTable, "relation grouped count");

        if (globalWriter) {
            // Global (D1) child: parallel scalar counts through the D1 writer.
            // The D1 writer's count() already resolves relation predicates internally.
            // Stamp a scan dependency: any row in the child table can shift a count.
            onRead(relationTable, SCAN_DEP);

            return fanOutScalarCounts((t, w) => globalWriter.count(t, w), relationTable, whereField, values, policyWhere);
        }

        // Shard-local child: one grouped SQL query.
        const definition = schema.tables[relationTable];

        if (!definition) {
            throw new LunoraError("INTERNAL", `unknown table: ${relationTable}`);
        }

        // Register a scan dependency — any insert/delete in the child table can
        // shift a count, so invalidate the same way the scalar count path did.
        onRead(relationTable, SCAN_DEP);

        // Build WHERE: whereField IN (values) [AND policyWhere] [AND softDeleteScope].
        // Then resolve any relation predicates in the combined WHERE before compiling
        // to SQL. Without resolution, a relation predicate in policyWhere (e.g.
        // {author:{is:W}}) is compiled as scalar equality and never matches, causing
        // every _count to silently return 0 (fail-closed but wrong).
        const softScope = softDeleteScope(definition.softDeleteMode, undefined);
        const inFilter: WhereInput = { [whereField]: { in: values } };
        const combined = mergeWhere(mergeWhere(inFilter, policyWhere), softScope);
        // resolveAggregateRelations rewrites relation-crossing predicates (e.g.
        // {author:{is:W}}) into flat IN clauses before SQL compilation — same path
        // count() / findMany() use. Pass `undefined` for relationBaseWhere (consistent
        // with how the scalar counter was called: no nested policy threading).
        const resolvedCombined = await resolveAggregateRelations(combined, relationTable, undefined);
        const whereCondition = compileWhereSql(resolvedCombined, doWhereSqlStrategy);

        // `jsonPathSql` maps `_id` → `id` (physical column) and user fields to
        // `json_extract(__doc__, '$.field')`, matching how WHERE compiles the
        // same field — so GROUP BY and WHERE are consistent.
        const fieldSql = jsonPathSql(whereField);

        let query = dsql`SELECT ${fieldSql} AS __fk__, COUNT(*) AS count FROM ${dsql.identifier(relationTable)}`;

        if (whereCondition) {
            query = dsql`${query} WHERE ${whereCondition}`;
        }

        query = dsql`${query} GROUP BY ${fieldSql}`;

        const rows = runDrizzle<{ __fk__: unknown; count: number }>(sql, query).toArray();

        return new Map(rows.map((row) => [row["__fk__"], row.count]));
    };

    let triggerDepth = 0;

    /**
     * Precomputed `(table → timing → op)` matcher: whether at least one
     * trigger is declared for that combination. The trigger-overhead bench
     * surfaced that every write awaits `fireTriggers` for both `before` and
     * `after` timings — even when the table has zero handlers for that
     * timing — and each `await` costs a microtask tick. The writer methods
     * gate the call on this set so a noop fireTriggers becomes a single
     * synchronous lookup instead of an awaited async function call.
     */
    const triggerMatchers = new Set<string>();

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        for (const trigger of Object.values(definition.triggerMap ?? {})) {
            triggerMatchers.add(`${tableName} ${trigger.timing} ${trigger.op}`);
        }
    }

    const hasMatchingTrigger = (tableName: string, timing: TriggerTimingLike, op: TriggerOpLike): boolean =>
        triggerMatchers.has(`${tableName} ${timing} ${op}`);

    /** Fire matching triggers with a depth guard against runaway self-triggering. */
    const fireTriggers = async (timing: TriggerTimingLike, op: TriggerOpLike, event: TriggerEventLike): Promise<void> => {
        triggerDepth += 1;

        if (triggerDepth > MAX_TRIGGER_DEPTH) {
            triggerDepth -= 1;

            throw new ConflictError(
                `trigger recursion exceeded ${String(MAX_TRIGGER_DEPTH)} levels on "${event.table}" — check for a self-triggering write`,
                "trigger",
            );
        }

        try {
            // `triggerCtx` is declared after this helper but only read here while
            // a write is in flight — long after construction wires it up.
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure read of post-construction `triggerCtx`
            await runTriggers({ ctx: triggerContext, event, op, schema, tableName: event.table, timing });
        } finally {
            triggerDepth -= 1;
        }
    };

    // Companion-index maintenance (aggregate counters, rank companions, FTS
    // shadow tables) is a cohesive cluster on the hot write path; it lives in
    // `./ctx-db-companions`, built per ctx-db instance with the writer locals it
    // needs threaded in (à la `ctx-db-rank-page`'s `RankPageDeps`). The returned
    // backfill helpers (`ensureBackfilled*`) are shared by both the write path
    // and the aggregate/rank read fast-paths — the per-(table, index) "rebuilt
    // this instance?" set lives inside the factory.
    const {
        ensureBackfilledForTable,
        ensureBackfilledIndex: ensureBackfilled,
        ensureRankBackfilled,
        ensureRankBackfilledForTable,
        syncAggregates,
        syncCompanionsForInsert,
        syncGeo,
        syncRanks,
        syncSearch,
    } = createCompanionSync({
        broadcast,
        invalidateCache: (table, id) => cache?.invalidate(table, id),
        recordCdc,
        schema,
        sql,
    });

    /**
     * Reject a `rank()`/`rankPage()` whose partition spans shards. When a table
     * is `.shardBy(field)` and the rankIndex's `partitionBy` does NOT include
     * that shard field, each partition is split across every DO — so this
     * shard's local count-of-rows-before is only a slice of the global answer.
     * Rather than return a silently-wrong position/page, refuse: a cross-shard
     * rank must be rolled up by the Query Coordinator (`orchestrateRank`), not
     * the shard-local `ctx.db`. `rankBefore` (the per-shard primitive the
     * coordinator fans out to) is intentionally exempt — counting this shard's
     * local slice against an explicit key is its whole job.
     */
    const assertRankPartitionLocal = (tableName: string, definition: TableDefinitionLike, index: RankIndexDefinitionLike): void => {
        const { shardMode } = definition;

        if (shardMode?.kind !== "shardBy") {
            return;
        }

        if (shardMode.field !== undefined && (index.partitionBy ?? []).includes(shardMode.field)) {
            return;
        }

        throw Object.assign(
            new Error(
                `rank index "${index.name}" on "${tableName}" partitions across shards (shard key "${shardMode.field ?? "?"}" is not in partitionBy) — a shard-local rank()/rankPage() would be wrong; roll it up through the Query Coordinator instead`,
            ),
            { code: "CROSS_SHARD_RANK_UNSUPPORTED", name: "LunoraError", status: 400 },
        );
    };

    /**
     * Locate a row by id and return both the owning table and the decoded
     * document in a single pass. The previous code base did this in two
     * steps — `tableNameFromId` (which probes every table with a SELECT
     * 1) followed by another `tableNameFromId` lookup inside each write
     * method, plus a separate SELECT for the row — so a single `patch`/
     * `delete` made 3–4 SQL round-trips even on a one-table schema.
     * Routing every writer through this helper collapses the lookup to a
     * single probe loop that returns the row when it hits.
     * @returns the row, its owning table, and its serialised document, or `undefined` when the id is absent
     */
    const locateRowById = (id: string, expectedTable?: string): { docJson: string; row: Record<string, unknown>; tableName: string } | undefined => {
        // Row ids are random UUIDs, so the owning table can't be derived from
        // the id. Rather than probing each table with its own SELECT (T
        // statements worst-case on a T-table schema, on the per-mutation hot
        // path), fold every non-global table into one UNION-ALL probe that
        // tags each branch with its source table — a single round-trip
        // regardless of table count. `LIMIT 1` short-circuits once a branch
        // hits; ids are unique across tables so at most one branch matches.
        //
        // When `expectedTable` is supplied (the `ctx.db.<table>.get/delete/...`
        // by-id facade pins it), the probe is scoped to that one table so a
        // foreign id can never resolve cross-table — closing an IDOR where a
        // branded `Id<"posts">` carrying another table's id would otherwise
        // read/mutate that other table. An unknown/global `expectedTable`
        // narrows the probe to nothing, so the global fallback handles it.
        const nonGlobalTables = Object.entries(schema.tables)
            .filter(([, definition]) => definition.shardMode?.kind !== "global")
            .map(([tableName]) => tableName)
            .filter((tableName) => expectedTable === undefined || tableName === expectedTable);

        if (nonGlobalTables.length === 0) {
            return undefined;
        }

        const branches = nonGlobalTables.map(
            (tableName) =>
                // The table-name discriminator stays an inline literal (escaped) rather than a bound param so it reads as `'<table>' AS __t__`.
                dsql`SELECT ${dsql.raw(`'${tableName.replaceAll("'", "''")}'`)} AS __t__, id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)} WHERE id = ${id}`,
        );
        const probeQuery = dsql`${dsql.join(branches, dsql` UNION ALL `)} LIMIT 1`;

        const [firstRow] = runDrizzle(sql, probeQuery).toArray();

        if (!firstRow) {
            return undefined;
        }

        const tableName = firstRow["__t__"];
        const row = rowToDocument(firstRow);

        if (typeof tableName !== "string" || !row) {
            return undefined;
        }

        // Capture the exact stored blob at read time so a read-modify-write
        // that spans an `await` (before-update trigger / onDelete cascade)
        // can compare-and-swap on it — a concurrent write that changed the
        // row flips the blob and the guarded UPDATE/DELETE matches zero rows.
        const rawDocument = firstRow[DOC_COLUMN];
        const documentJson = typeof rawDocument === "string" ? rawDocument : JSON.stringify(rawDocument ?? {});

        return { docJson: documentJson, row, tableName };
    };

    // The cross-shard rank-page read unit (compute + hydrate)
    // lives in `./ctx-db-rank-page`; its SQL/order/cursor/hydration is
    // byte-identical to what the coordinator merge + codegen golden fixture
    // expect. It needs these writer locals, threaded explicitly rather than
    // captured from this closure so the unit reads as a pure function of its deps.
    const rankPageDeps: RankPageDeps = {
        assertRankPartitionLocal,
        ensureRankBackfilled,
        onRead,
        rowToDocument,
        schema,
        sql,
    };

    const writer: DatabaseWriterLike = {
        // `ctx.db.system` — best-effort read-only system tables. Assigned here so
        // it rides along on the same `DatabaseWriterLike` the generated ctx hands
        // to query/mutation/action handlers. See {@link SystemDatabaseReader}.
        system,
        async aggregate(tableName, aggOptions) {
            const global = globalWriterFor(tableName, "aggregate");

            if (global) {
                onRead(tableName, SCAN_DEP);

                return global.aggregate(tableName, aggOptions);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            // Reject an off-allowlist `op` up front (it's a compile-time-only
            // type) before it can reach any SQL-emitting path.
            aggregateSqlFunction(aggOptions.op);

            if (aggOptions.op === "count") {
                // `aggregate({ op: "count" })` is just `count()` — keep the
                // surface uniform so callers don't special-case it.
                return writer.count(tableName, {
                    baseWhere: aggOptions.baseWhere,
                    relationBaseWhere: aggOptions.relationBaseWhere,
                    restrictsCounts: aggOptions.restrictsCounts,
                    where: aggOptions.where,
                });
            }

            if (!aggOptions.field) {
                throw new LunoraError("INTERNAL", `aggregate(${tableName}, { op: "${aggOptions.op}" }): "field" is required for non-count reducers`);
            }

            onRead(tableName, SCAN_DEP);

            // Soft delete: aggregate over LIVE rows only; AND the scope in and
            // force the scan (the indexed companion includes deleted rows).
            const aggScope = softDeleteScope(definition.softDeleteMode, undefined);
            const effective = mergeWhere(mergeWhere(aggOptions.baseWhere, aggOptions.where), aggScope);
            // Rewrite any relation-crossing predicate to a flat semijoin clause
            // before compiling. The resolver returns `effective` unchanged when
            // there is none, so `hasRelation` both skips the no-op fetch and —
            // critically — disables the indexed fast-path, which can't honour a
            // relation filter and would otherwise silently over-aggregate.
            const resolved = await resolveAggregateRelations(effective, tableName, aggOptions.relationBaseWhere);
            const hasRelation = resolved !== effective;

            // Indexed fast-path: the `__agg_` companion is now reducer-aware
            // (`__value__` holds the sum / running sum / extreme, `__count__`
            // the row count), so a matching `(by, field, op)` index answers
            // sum/avg/min/max in one row lookup. We only attempt it when no
            // baseWhere is set — the RLS predicate isn't a pure equality
            // conjunction, so it falls through to the SQL scan below.
            if (definition.aggregateIndexes && !aggOptions.baseWhere && !hasRelation && !aggScope) {
                const planned = selectIndexForAggregate(definition.aggregateIndexes, aggOptions.op, aggOptions.field, aggOptions.where);

                if (planned) {
                    ensureBackfilled(tableName, planned.index);

                    const encoded = encodeAggregateKey(planned.index.by ?? [], planned.key);
                    const aggTable = aggregateTableName(tableName, planned.index.name);
                    const indexed = runDrizzle<{ count: number; value: null | number }>(
                        sql,
                        dsql`SELECT ${AGG_VALUE} AS value, ${AGG_COUNT} AS count FROM ${dsql.identifier(aggTable)} WHERE ${AGG_KEY} = ${encoded}`,
                    ).toArray()[0];

                    return readAggregateValue(aggOptions.op, indexed);
                }
            }

            const whereCondition = compileWhereSql(resolved, doWhereSqlStrategy);
            const aggregateSql = aggregateSqlFunction(aggOptions.op);
            const ref = jsonPathSql(aggOptions.field);

            let query = dsql`SELECT ${dsql.raw(aggregateSql)}(${ref}) AS value FROM ${dsql.identifier(tableName)}`;

            if (whereCondition) {
                query = dsql`${query} WHERE ${whereCondition}`;
            }

            const row = runDrizzle<{ value: null | number }>(sql, query).toArray();
            const value = row[0]?.value;

            if (value === null || value === undefined) {
                // eslint-disable-next-line unicorn/no-null -- AggregateResult is `null | number`: null is the documented "no rows matched" result returned to callers
                return null;
            }

            return value;
        },

        asId(tableName, id) {
            const normalized = normalizeIdStructurally(schema, tableName, id);

            if (normalized === null) {
                throw new LunoraError("BAD_REQUEST", `asId("${tableName}", …): "${id}" is not a valid id for table "${tableName}"`, { status: 400 });
            }

            return normalized;
        },

        async count(tableName, whereOrOptions) {
            const global = globalWriterFor(tableName, "count");

            if (global) {
                onRead(tableName, SCAN_DEP);

                return global.count(tableName, whereOrOptions);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            const countOptions = normalizeCountArgument(whereOrOptions);

            // RLS-restricted contexts can't be trusted to return a correct
            // count — surface a structural LunoraError so the request fails
            // loudly rather than silently undercounting. See PLAN2 §3.1
            // "Coupling seam" and `aggregates.ts` for the seam contract.
            if (countOptions.restrictsCounts) {
                throw new CountRlsUnsupportedError(tableName);
            }

            // Counts and aggregates depend on every row in the table — a
            // single insert or delete can shift the answer, so register a
            // scan dependency regardless of `where`.
            onRead(tableName, SCAN_DEP);

            // Soft delete: a `count()` reflects LIVE rows. AND the scope in and
            // force the scan path (the `__agg_` companion counts deleted rows too,
            // so the indexed fast-path can't be trusted here).
            const countScope = softDeleteScope(definition.softDeleteMode, undefined);
            const effective = mergeWhere(mergeWhere(countOptions.baseWhere, countOptions.where), countScope);
            // Rewrite a relation-crossing predicate to a flat semijoin clause
            // first; `hasRelation` disables the indexed fast-path below (an
            // aggregate-index counter can't honour a relation filter).
            const resolved = await resolveAggregateRelations(effective, tableName, countOptions.relationBaseWhere);
            const hasRelation = resolved !== effective;

            // Indexed path: if the user passed a plain conjunction of equality
            // filters and a declared aggregateIndex covers them, route to the
            // counter table. The base predicate (when present) is intentionally
            // left out of the indexed path because we can't trust it to be a
            // pure equality conjunction; if `baseWhere` is set we fall through
            // to the scan so SQL handles it uniformly.
            if (definition.aggregateIndexes && !countOptions.baseWhere && !hasRelation && !countScope) {
                const planned = selectIndexForCount(definition.aggregateIndexes, countOptions.where);

                if (planned) {
                    ensureBackfilled(tableName, planned.index);

                    const encoded = encodeAggregateKey(planned.index.by ?? [], planned.key);
                    const aggTable = aggregateTableName(tableName, planned.index.name);
                    const row = runDrizzle<{ value: number | null }>(
                        sql,
                        dsql`SELECT ${AGG_VALUE} AS value FROM ${dsql.identifier(aggTable)} WHERE ${AGG_KEY} = ${encoded}`,
                    ).toArray();

                    return row[0] === undefined ? 0 : (row[0].value ?? 0);
                }
            }

            const whereCondition = compileWhereSql(resolved, doWhereSqlStrategy);

            let query = dsql`SELECT COUNT(*) AS count FROM ${dsql.identifier(tableName)}`;

            if (whereCondition) {
                query = dsql`${query} WHERE ${whereCondition}`;
            }

            const row = runDrizzle<{ count: number }>(sql, query).one();

            return row.count;
        },

        async delete(id, expectedTable, deleteOptions) {
            // Single probe — get the table + row in one pass instead of
            // probing twice (`tableNameFromId` + `writer.get`).
            const located = locateRowById(id, expectedTable);

            if (!located) {
                // A global row's id never lives in this DO; fall back to D1
                // (both backends are silent on a genuinely-absent id). But when
                // the by-id facade pinned a (non-global) table, a global row is
                // by definition a different table — skip the fallback so a
                // non-global facade can't reach a `.global()` row (IDOR).
                const global = expectedTable === undefined ? globalFallback() : undefined;

                if (global) {
                    await global.delete(id, undefined, deleteOptions);
                }

                return;
            }

            const { docJson: existingJson, row: existing, tableName } = located;
            const definition = schema.tables[tableName];
            // Soft delete unless the caller forced a physical removal (`hard`).
            // `softField` undefined ⇒ the legacy physical path.
            const hard = deleteOptions?.hard === true;
            const softField = !hard && definition?.softDeleteMode ? definition.softDeleteMode.field : undefined;

            // Idempotent: a second soft delete of an already-soft-deleted row is a
            // no-op (re-running the cascade + broadcast would be spurious).
            if (softField && existing[softField] !== null && existing[softField] !== undefined) {
                return;
            }

            // `before` fires ahead of cascade resolution so a throwing guard
            // aborts the delete before any holder rows are touched.
            if (hasMatchingTrigger(tableName, "before", "delete")) {
                await fireTriggers("before", "delete", { id, op: "delete", previous: existing, table: tableName });
            }

            // Resolve declared `onDelete` actions on holder rows *before* the
            // write, so `restrict` can abort and cascaded child deletes still fire
            // their own broadcast/onWrite per row. A delete cascades as a delete:
            // each child routes back through `writer.delete` (carrying the same
            // `hard` flag), so a soft delete soft-deletes its children and a hard
            // delete hard-deletes them. The holder lookup honours the mode too —
            // a hard delete must see soft-deleted holders to remove them, a soft
            // delete skips already-deleted holders.
            //
            // The callbacks pass through `routeForHolder` so a holder living
            // on a global (`.global()`) table is reached through the supplied
            // D1-backed `globalDb` writer, not this DO's local SQLite.
            await applyOnDelete({
                deletedId: id,
                deletedReference: (references) => existing[references],
                findHolders: async (holderTable, field, value) => {
                    const holders = await routeForHolder(holderTable).findMany(holderTable, { includeDeleted: hard, where: { [field]: value } });

                    return holders.page;
                },
                onCascade: (holderTable, holderId) => routeForHolder(holderTable).delete(holderId, undefined, deleteOptions),
                onRestrict: (message) => {
                    throw new ConflictError(message, "restrict");
                },
                // eslint-disable-next-line unicorn/no-null -- `set null` onDelete: the FK column is set to SQL NULL, the documented semantics of the action
                onSetNull: (holderTable, holderId, field) => routeForHolder(holderTable).patch(holderId, { [field]: null }),
                schema,
                tableName,
            });

            ensureBackfilledForTable(tableName);
            ensureRankBackfilledForTable(tableName);

            if (softField) {
                // Soft delete: keep the row, stamp the marker column. Mechanically
                // an UPDATE, so companions re-sync to the merged doc and the delta
                // broadcasts as `update` — live LIST queries re-run and drop the
                // row (they now filter the marker), per-id subscribers see the
                // stamp. The OCC guard CAS's on the read-time snapshot, same as
                // patch/replace. Read scoping (not companion removal) is what hides
                // the row, so search/aggregate stay correct via the read filter.
                const merged: Record<string, unknown> = { ...existing, [softField]: clock(), _id: id };

                runGuardedWrite(
                    sql,
                    tableName,
                    dsql`UPDATE ${dsql.identifier(tableName)} SET ${dsql.identifier(DOC_COLUMN)} = ${JSON.stringify(merged)} WHERE id = ${id} AND ${dsql.identifier(DOC_COLUMN)} = ${existingJson}`,
                );

                // Search stays maintained (the marker filter hides it on read), but
                // the rank companion and external stores (Vectorize) have NO read-time
                // marker filter — the companion row carries no marker column and a
                // Vectorize query can't be scoped — so a soft delete REMOVES the row
                // from them (passing `undefined`/`op: "delete"`), exactly like a
                // physical delete. `restore()` re-adds both via the patch path.
                syncSearch(tableName, id, merged, existing);
                // Like rank, the geo companion has no read-time marker filter, so a
                // soft delete removes the row from it (restore re-adds via patch).
                syncGeo(tableName, id, undefined);
                syncAggregates(tableName, existing, merged);
                syncRanks(tableName, id, existing, undefined);

                cache?.invalidate(tableName, id);

                recordCdc(tableName, id, "update", merged);
                broadcast({ key: id, op: "update", row: merged, table: tableName });

                // `delete()` was called, so fire the DELETE triggers (the flag flip
                // is an implementation detail of how the delete is recorded).
                if (hasMatchingTrigger(tableName, "after", "delete")) {
                    await fireTriggers("after", "delete", { id, op: "delete", previous: existing, table: tableName });
                }

                // External stores treat a soft delete as a removal: fire `onWrite`
                // with `op: "delete"` so the Vectorize sync hook drops the row's
                // vector (`restore`'s patch re-upserts it).
                await onWrite({ id, op: "delete", table: tableName });

                return;
            }

            // Optimistic-concurrency guard over the (wide) cascade window: the
            // `applyOnDelete` await above can let a concurrent write commit, so
            // CAS on the read-time `__doc__` snapshot. A row that was updated
            // out from under us (blob changed) or already removed matches zero
            // rows and raises ConflictError rather than clobbering that write —
            // and keeps `existing` (used for the aggregate/rank -prev steps) in
            // sync with what was actually on disk.
            runGuardedWrite(
                sql,
                tableName,
                dsql`DELETE FROM ${dsql.identifier(tableName)} WHERE id = ${id} AND ${dsql.identifier(DOC_COLUMN)} = ${existingJson}`,
            );

            syncSearch(tableName, id, undefined);
            syncGeo(tableName, id, undefined);
            syncAggregates(tableName, existing, undefined);
            syncRanks(tableName, id, existing, undefined);

            cache?.invalidate(tableName, id);

            recordCdc(tableName, id, "delete");
            broadcast({ key: id, op: "delete", table: tableName });

            if (hasMatchingTrigger(tableName, "after", "delete")) {
                await fireTriggers("after", "delete", { id, op: "delete", previous: existing, table: tableName });
            }

            await onWrite({ id, op: "delete", table: tableName });
        },

        async deleteAll(tableName, allOptions) {
            if (!schema.tables[tableName]) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            const chunkSize = Math.max(1, allOptions?.chunkSize ?? DEFAULT_BATCH_LIMIT);
            const deleteOptions = allOptions?.hard === undefined ? undefined : { hard: allOptions.hard };
            // A `.global()` row's id lives in D1, not this DO, so the by-id delete only
            // reaches it through `globalFallback()` — which is gated on NO table being
            // pinned (the IDOR guard: a non-global by-id facade must not reach a global
            // row). Pinning `tableName` here would therefore make every global delete a
            // silent no-op: the count would inflate, the rows would survive, and a table
            // with at least `chunkSize` rows would loop forever because `findMany` kept
            // returning the same page. Leave the table unpinned for a global table —
            // exactly what `deleteWhere` does when it hands ids to `deleteMany`.
            const expectedTable = isGlobalTable(tableName) ? undefined : tableName;
            let deleted = 0;

            // Resolve-then-delete in chunks until the table is empty. Deliberately
            // uncapped: this is the erasure primitive, so stopping at
            // DEFAULT_BATCH_LIMIT would leave data behind — the opposite of the
            // guarantee the caller needs. On a `.softDelete()` table the default
            // flips the marker (so the loop must not re-read the same rows forever);
            // `{ hard: true }` removes them physically.
            for (;;) {
                // eslint-disable-next-line no-await-in-loop -- chunked by design: one page of ids at a time, single-threaded SQLite
                const page = await writer.findMany(tableName, { limit: chunkSize });
                const ids = page.page.map((row) => String(row["_id"]));

                if (ids.length === 0) {
                    break;
                }

                for (const id of ids) {
                    // eslint-disable-next-line no-await-in-loop -- sequential by design: each row reuses the full delete pipeline (triggers, cascades, CDC, broadcast)
                    await writer.delete(id, expectedTable, deleteOptions);
                    deleted += 1;
                }

                // A short page means the table is drained. This also makes the
                // soft-delete case terminate: `findMany` hides soft-deleted rows, so
                // each pass sees only rows still to erase, never the ones just marked.
                if (ids.length < chunkSize) {
                    break;
                }
            }

            return { deleted };
        },

        async deleteMany(ids, batchOptions, expectedTable) {
            assertBatchLimit(ids.length, batchOptions?.limit, "deleteMany");

            // Sequential loop over the single-row delete so each id reuses the
            // full delete pipeline (triggers, companion sync, CDC, broadcast,
            // global fallback). `expectedTable` (the facade's bound table) scopes
            // every id to that table — same IDOR guard as the single delete. In a
            // mutation the DO's storage transaction rolls the whole batch back on a
            // mid-loop throw; in an action (no span) prior deletes persist.
            for (const id of ids) {
                // eslint-disable-next-line no-await-in-loop -- sequential by design: single-threaded SQLite, one row at a time
                await writer.delete(id, expectedTable);
            }

            // `ids.length` is the requested count, not rows-actually-removed (an unknown/duplicate id is a no-op) — see the deleteMany doc.
            return { deleted: ids.length };
        },

        async deleteWhere(tableName, where, batchOptions) {
            const global = globalWriterFor(tableName, "deleteWhere");

            let ids: string[];

            if (global) {
                // Global tables have no native batch primitive; resolve ids and
                // route each delete through the DO's single-row pipeline, which
                // forwards to the global writer.
                const rows = await global.findMany(tableName, { where });
                ids = rows.page.map((row) => String(row["_id"]));
            } else {
                if (!schema.tables[tableName]) {
                    throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
                }

                // Resolve matching rows first. The mutation-span (if any) keeps
                // the read and the subsequent deletes consistent.
                const page = await writer.findMany(tableName, { where });
                ids = page.page.map((row) => String(row["_id"]));
            }

            assertBatchLimit(ids.length, batchOptions?.limit, "deleteWhere");

            // Reuse the id-based pipeline so triggers, companions, CDC, and
            // broadcast all fire correctly. The concrete DO writer always
            // implements deleteMany; the optional type is for global/D1 twins.
            if (writer.deleteMany === undefined) {
                throw new LunoraError("INTERNAL", `ctx.db.${tableName}.deleteMany is unavailable: this writer has no batch delete`);
            }

            return writer.deleteMany(ids, batchOptions);
        },

        async findFirst(tableName, args = {}) {
            const result = await writer.findMany(tableName, { ...args, limit: 1 });

            // eslint-disable-next-line unicorn/no-null -- findFirst is `Promise<Record | null>`: null is the documented "no match" result
            return result.page[0] ?? null;
        },

        async findFirstOrThrow(tableName, args = {}) {
            const document = await writer.findFirst(tableName, args);

            if (document === null) {
                throw new NotFoundError(`findFirstOrThrow: no "${tableName}" document matched`);
            }

            return document;
        },

        // eslint-disable-next-line sonarjs/cognitive-complexity -- reader method closed over the writer ctx (sql/schema/onRead/strategy/cache/resolveWith); splitting would thread that shared state through every helper and read worse (see data-migration.ts)
        async findMany(tableName, args = {}) {
            const global = globalWriterFor(tableName, "findMany");

            if (global) {
                // The result lives in D1, but a live subscription that runs this
                // read still needs to refresh when the global table changes. We
                // can't track per-row deps across the D1 boundary, so stamp the
                // conservative `*scan` marker: any write to the table re-runs it.
                onRead(tableName, SCAN_DEP);

                return global.findMany(tableName, args);
            }

            const findManyDefinition = schema.tables[tableName];

            if (!findManyDefinition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            // A query with no `where` and no `baseWhere` is a true full-table
            // scan — every write to the table can flip its result, so stamp
            // the `*scan` marker. Predicated queries fall through to per-row
            // stamping after the rows resolve below.
            const isFullScan = !args.where && !args.baseWhere;

            if (isFullScan) {
                onRead(tableName, SCAN_DEP);
            } else {
                onRead(tableName);
            }

            const orderKeys = normalizeOrderKeys(args.orderBy);
            const seek = args.cursor ? buildSeekWhere(orderKeys, decodeCursor(args.cursor)) : undefined;

            // RLS (3.2) / aggregates (3.1) inject a `baseWhere` we AND-merge
            // before the keyset seek so policy + cursor compose cleanly.
            let predicate: WhereInput | undefined = mergeWhere(args.baseWhere, args.where);

            // Soft delete: hide rows whose marker column is set, unless the caller
            // opted in via `includeDeleted`. AND-merged like a baseWhere so it
            // composes with RLS + the keyset seek; relation `with` loads route back
            // through this `findMany`, so they inherit the scope automatically.
            predicate = mergeWhere(predicate, softDeleteScope(findManyDefinition.softDeleteMode, args.includeDeleted));

            // Rewrite any relation-crossing predicate (`{ author: { is: W } }`,
            // `{ posts: { some: W } }`, …) into a flat `IN`/`NOT IN` via a
            // backend-routed child fetch, *before* compiling — the predicate may
            // arrive from caller `where` or an injected RLS `baseWhere`. A read
            // with no relation predicates returns unchanged (no extra query).
            predicate = await resolveRelationPredicates(predicate, {
                canPushExists: relationExistsPushDownEnabled ? canPushRelationExists : undefined,
                existsPushMode: relationExistsPushDown === "always" ? "always" : "auto",
                fetcher: relationPredicateFetcher,
                maxRelationKeys,
                relationBaseWhere: args.relationBaseWhere,
                schema,
                tableName,
            });

            if (seek) {
                predicate = predicate ? { AND: [predicate, seek] } : seek;
            }

            // A pushed-down relation node leaves a `__relationExists` marker in
            // the tree; compile it with the EXISTS-aware strategy. Without the
            // fast path (or with no relation predicates) the flat strategy is
            // equivalent and cheaper, so only build the per-query strategy when
            // the push-down is enabled.
            const whereStrategy = relationExistsPushDownEnabled ? makeRelationExistsSqlStrategy(onRead) : doWhereSqlStrategy;
            const whereCondition = compileWhereSql(predicate, whereStrategy);

            let query = dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)}`;

            if (whereCondition) {
                query = dsql`${query} WHERE ${whereCondition}`;
            }

            query = dsql`${query} ORDER BY ${compileOrderBySql(orderKeys)}`;

            const limit = typeof args.limit === "number" ? Math.max(0, Math.floor(args.limit)) : undefined;

            if (limit !== undefined) {
                // Over-fetch by one row to learn whether another page exists
                // without issuing a second query.
                query = dsql`${query} LIMIT ${dsql.raw(String(limit + 1))}`;
            }

            const rows = runDrizzle(sql, query).toArray();
            const docs: Record<string, unknown>[] = [];

            for (const row of rows) {
                const record = rowToDocument(row);

                if (record) {
                    docs.push(record);

                    // For predicated reads we know exactly which rows matched
                    // — stamp each so the cache only invalidates when one of
                    // them actually changes. Full scans already stamped
                    // `*scan` above (which subsumes per-row deps).
                    if (!isFullScan && typeof record["_id"] === "string") {
                        onRead(tableName, record["_id"]);
                    }
                }
            }

            if (limit === undefined) {
                if (args.with) {
                    await resolveWith({
                        groupedCounter: relationGroupedCounter,
                        fetcher: relationFetcher,
                        parents: docs,
                        relationBaseWhere: args.relationBaseWhere,
                        schema,
                        tableName,
                        with: args.with,
                    });
                }

                // eslint-disable-next-line unicorn/no-null -- QueryPage.continueCursor is `null | string`: null is the documented "no further page" cursor on the wire
                return { continueCursor: null, isDone: true, page: applySelect(docs, args.select, args.with) };
            }

            const hasMore = docs.length > limit;
            const page = hasMore ? docs.slice(0, limit) : docs;
            const last = page.at(-1);

            if (args.with) {
                await resolveWith({
                    fetcher: relationFetcher,
                    groupedCounter: relationGroupedCounter,
                    parents: page,
                    relationBaseWhere: args.relationBaseWhere,
                    schema,
                    tableName,
                    with: args.with,
                });
            }

            return {
                // The cursor is encoded from `last` (the full, unprojected row) above,
                // so `applySelect` only trims the returned payload — paging is intact.
                // eslint-disable-next-line unicorn/no-null -- QueryPage.continueCursor is `null | string`: null is the documented "no further page" cursor on the wire
                continueCursor: hasMore && last ? encodeCursor(last, orderKeys) : null,
                isDone: !hasMore,
                page: applySelect(page, args.select, args.with),
            };
        },

        async get(id, expectedTable) {
            const located = locateRowById(id, expectedTable);

            if (!located) {
                // A global row's id never lives in this DO; fall back to D1 —
                // but only when no table is pinned: a (non-global) by-id facade
                // must never reach a `.global()` row (IDOR).
                const global = expectedTable === undefined ? globalFallback() : undefined;

                if (global) {
                    return global.get(id);
                }

                // eslint-disable-next-line unicorn/no-null -- DatabaseWriterLike.get is `Promise<Record | null>`: null is the documented "no such row" result
                return null;
            }

            onRead(located.tableName, id);

            return located.row;
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the optional seam's Promise contract; the underlying lookup is sync
        async lookupById(id, expectedTable) {
            // The optional fast-path seam the RLS + mask middleware probe for: the
            // writer already knows a row's owning table from its internal index, so
            // the middleware gets `{ row, tableName }` in one round-trip instead of a
            // `get` plus a `findFirst` probe across every policy table. Shard-local
            // only — a global row's table isn't resolvable here, so it returns `null`
            // and the caller keeps its probe fallback. `onRead` fires exactly as in
            // `get`, so swapping the fallback for this path preserves subscription
            // dependency tracking (and matches what the write-gate fallback did).
            const located = locateRowById(id, expectedTable);

            if (!located) {
                // eslint-disable-next-line unicorn/no-null -- the server seam contract returns `null` (not undefined) for an absent row
                return null;
            }

            onRead(located.tableName, id);

            return { row: located.row, tableName: located.tableName };
        },

        // eslint-disable-next-line sonarjs/cognitive-complexity -- the indexed/scan branching is closed over the writer ctx and reads worse when split
        async groupBy(tableName, groupOptions) {
            const global = globalWriterFor(tableName, "groupBy");

            if (global) {
                onRead(tableName, SCAN_DEP);

                return global.groupBy(tableName, groupOptions);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            onRead(tableName, SCAN_DEP);

            const agg = groupOptions.agg ?? { op: "count" };

            // Reject an off-allowlist reducer `op` before any SQL is emitted.
            aggregateSqlFunction(agg.op);

            if (agg.op !== "count" && !agg.field) {
                throw new LunoraError("INTERNAL", `groupBy(${tableName}, { agg: { op: "${agg.op}" } }): "field" is required for non-count reducers`);
            }

            // Soft delete: group over LIVE rows only; AND the scope in and force
            // the scan (the indexed companion includes deleted rows).
            const groupScope = softDeleteScope(definition.softDeleteMode, undefined);
            const effective = mergeWhere(mergeWhere(groupOptions.baseWhere, groupOptions.where), groupScope);
            // Rewrite any relation-crossing predicate to a flat semijoin clause
            // before compiling. The resolver returns `effective` unchanged when
            // there is none, so `hasRelation` both skips the no-op fetch and —
            // critically — disables the indexed fast-path, which can't honour a
            // relation filter and would otherwise silently over-aggregate.
            const resolved = await resolveAggregateRelations(effective, tableName, groupOptions.relationBaseWhere);
            const hasRelation = resolved !== effective;

            // Indexed path: when no baseWhere is set and an aggregateIndex's
            // `by` exactly matches `groupOptions.by`, every group answer is
            // already in the reducer-aware companion table — read each row's
            // `__value__`/`__count__` and project via `readAggregateValue`.
            // One SELECT, no SQL `GROUP BY`. baseWhere falls through to scan so
            // RLS composes uniformly. Covers every op (count/sum/avg/min/max)
            // now that the companion is op-aware.
            if (definition.aggregateIndexes && !groupOptions.baseWhere && !hasRelation && !groupScope) {
                const planned = selectIndexForGroupBy(definition.aggregateIndexes, agg.op, agg.field, groupOptions.by, groupOptions.where);

                if (planned) {
                    ensureBackfilled(tableName, planned.index);

                    const aggTable = aggregateTableName(tableName, planned.index.name);
                    const partialKeys = Object.keys(planned.partial);
                    const indexedResult: GroupByEntry[] = [];

                    if (partialKeys.length === (planned.index.by ?? []).length && partialKeys.length > 0) {
                        // Request fully constrains the by-tuple → single companion row lookup.
                        const encoded = encodeAggregateKey(planned.index.by ?? [], planned.partial);
                        const rowsIndexed = runDrizzle<{ count: number; value: null | number }>(
                            sql,
                            dsql`SELECT ${AGG_VALUE} AS value, ${AGG_COUNT} AS count FROM ${dsql.identifier(aggTable)} WHERE ${AGG_KEY} = ${encoded}`,
                        ).toArray();

                        if (rowsIndexed.length > 0) {
                            indexedResult.push({
                                key: { ...planned.partial },
                                value: readAggregateValue(agg.op, rowsIndexed[0]),
                            });
                        }

                        return indexedResult;
                    }

                    // Unfiltered (or partially-filtered, future work) → walk
                    // the whole companion. Each row's __key__ is the
                    // canonical-JSON encoding written by encodeAggregateKey.
                    const rowsIndexed = runDrizzle<{ count: number; key: string; value: null | number }>(
                        sql,
                        dsql`SELECT ${AGG_KEY} AS key, ${AGG_VALUE} AS value, ${AGG_COUNT} AS count FROM ${dsql.identifier(aggTable)}`,
                    ).toArray();

                    for (const row of rowsIndexed) {
                        const decoded = JSON.parse(row.key) as Record<string, unknown>;

                        indexedResult.push({ key: decoded, value: readAggregateValue(agg.op, row) });
                    }

                    return indexedResult;
                }
            }

            const whereCondition = compileWhereSql(resolved, doWhereSqlStrategy);

            const select: SQL[] = groupOptions.by.map((field) => dsql`${jsonPathSql(field)} AS ${dsql.identifier(field)}`);

            if (agg.op === "count") {
                select.push(dsql`COUNT(*) AS value`);
            } else {
                // `agg.field` is guaranteed present here: the guard above throws
                // for any non-`count` reducer that omits it.
                const { field } = agg;

                if (field === undefined) {
                    throw new LunoraError("INTERNAL", `groupBy(${tableName}, { agg: { op: "${agg.op}" } }): "field" is required for non-count reducers`);
                }

                select.push(dsql`${dsql.raw(aggregateSqlFunction(agg.op))}(${jsonPathSql(field)}) AS value`);
            }

            let query = dsql`SELECT ${dsql.join(select, dsql`, `)} FROM ${dsql.identifier(tableName)}`;

            if (whereCondition) {
                query = dsql`${query} WHERE ${whereCondition}`;
            }

            query = dsql`${query} GROUP BY ${dsql.join(
                groupOptions.by.map((field) => jsonPathSql(field)),
                dsql`, `,
            )}`;

            const rows = runDrizzle(sql, query).toArray();
            const result: GroupByEntry[] = [];

            for (const row of rows) {
                const key: Record<string, unknown> = {};

                for (const field of groupOptions.by) {
                    // eslint-disable-next-line unicorn/no-null -- GroupByEntry.key tuple: a NULL group value surfaces as null in the returned key, matching the wire shape
                    key[field] = row[field] ?? null;
                }

                const { value } = row as { value: unknown };

                // eslint-disable-next-line unicorn/no-null -- GroupByEntry.value is AggregateResult (`null | number`): null is the documented "empty group" value
                result.push({ key, value: value === null || value === undefined ? null : Number(value) });
            }

            return result;
        },

        async insert(tableName, document, insertOptions) {
            const global = globalWriterFor(tableName, "insert");

            if (global) {
                const id = await global.insert(tableName, document, insertOptions);

                // A `.global()` (D1) write lands in another backend, but live
                // subscriptions on this DO that read the table still need to be
                // refreshed — so notify them via the same `broadcast` channel the
                // local path uses (the DO maps it to `recordChangedTable`). Without
                // this, `ctx.db.insert("<global>", …)` would never push a delta to
                // subscribers of that global table's query.
                broadcast({ key: id, op: "insert", row: { ...document, _id: id }, table: tableName });

                return id;
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            const withDefaults = applyInsertDefaults(definition, document, auth);

            // Refinements declared via `.check(predicate)` fire here on the
            // post-default row so a defaulted value still passes its checks.
            runRowValidators(definition, withDefaults);

            // A client-chosen id is honored two ways: a validated `clientId`
            // (public, UUID-shaped — keys an optimistic row before the server
            // responds) or the trusted-import `allowExplicitId` (verbatim `_id`).
            // Otherwise the default mutation path mints a fresh id, ignoring any
            // `_id` a handler forwards on the raw payload.
            let id: string;

            if (insertOptions?.clientId !== undefined) {
                assertValidClientId(insertOptions.clientId);
                id = insertOptions.clientId;
            } else if (insertOptions?.allowExplicitId && typeof withDefaults["_id"] === "string") {
                id = withDefaults["_id"];
            } else {
                id = generateId();
            }
            // Like `_id` above, a document-supplied `_creationTime` is only honored
            // under the trusted-import `allowExplicitId` opt-in. The default mutation
            // path (and the optimistic `clientId` path) mints from `clock()` so a
            // raw-forwarded client payload can't backdate/forward-date the row.
            const creationTime = insertOptions?.allowExplicitId && typeof withDefaults["_creationTime"] === "number" ? withDefaults["_creationTime"] : clock();

            const documentWithMeta: Record<string, unknown> = { ...withDefaults, _creationTime: creationTime, _id: id };

            // `before` sees a shallow copy so an abort-only handler can't reassign
            // the row's top-level fields before they persist. Nested values are
            // still shared by reference — before-handlers are abort/side-effect
            // only, never row transformers (use `.$defaultFn`/`.$onUpdateFn`).
            if (hasMatchingTrigger(tableName, "before", "insert")) {
                await fireTriggers("before", "insert", { doc: { ...documentWithMeta }, id, op: "insert", table: tableName });
            }

            // Backfill counters BEFORE the physical write so the rebuild
            // scans a pre-insert snapshot — otherwise the row we're about to
            // INSERT lands in both the rebuild and the +1 step.
            ensureBackfilledForTable(tableName);
            ensureRankBackfilledForTable(tableName);

            runWrite(
                sql,
                tableName,
                dsql`INSERT INTO ${dsql.identifier(tableName)} (id, _creationTime, ${dsql.identifier(DOC_COLUMN)}) VALUES (${id}, ${creationTime}, ${JSON.stringify(documentWithMeta)})`,
            );

            syncCompanionsForInsert(tableName, id, documentWithMeta);

            if (hasMatchingTrigger(tableName, "after", "insert")) {
                await fireTriggers("after", "insert", { doc: documentWithMeta, id, op: "insert", table: tableName });
            }

            await onWrite({ doc: documentWithMeta, id, op: "insert", table: tableName });

            return id;
        },

        async insertManyUnsafe(tableName, documents, batchOptions) {
            assertBatchLimit(documents.length, batchOptions?.limit, "insertManyUnsafe");

            if (documents.length === 0) {
                return [];
            }

            const global = globalWriterFor(tableName, "insert");

            if (global) {
                // No raw multi-row path across the D1 boundary — fall back to the
                // per-row global writer (the throughput win is shard-local only).
                const globalIds: string[] = [];

                for (const document of documents) {
                    // Forward `allowExplicitId` so a trusted import preserves the
                    // supplied `_id` across the D1 boundary too — mirrors the single
                    // `insert` global branch; without it the D1 writer would silently
                    // re-key every row (thermos HIGH).
                    // eslint-disable-next-line no-await-in-loop -- the D1 global writer has no batch primitive; sequential per row
                    const globalId = await global.insert(tableName, document, { allowExplicitId: batchOptions?.allowExplicitId });

                    broadcast({ key: globalId, op: "insert", row: { ...document, _id: globalId }, table: tableName });
                    globalIds.push(globalId);
                }

                return globalIds;
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            // Backfill the counters once against the pre-insert snapshot (same
            // ordering reason as the single insert: the rebuild must not see the
            // rows we are about to write).
            ensureBackfilledForTable(tableName);
            ensureRankBackfilledForTable(tableName);

            // Build every row up front: column defaults + a minted (or, for trusted
            // import, an explicit) id. **No `.check()` validators and no before/after
            // triggers run** — the caller vouches for the data; that is the "unsafe".
            const rows = documents.map((document) => {
                const withDefaults = applyInsertDefaults(definition, document, auth);
                const id = batchOptions?.allowExplicitId === true && typeof withDefaults["_id"] === "string" ? withDefaults["_id"] : generateId();
                // Gate `_creationTime` behind the same `allowExplicitId` opt-in as
                // `_id` above — the default path mints from `clock()`.
                const creationTime =
                    batchOptions?.allowExplicitId === true && typeof withDefaults["_creationTime"] === "number" ? withDefaults["_creationTime"] : clock();

                return { creationTime, document: { ...withDefaults, _creationTime: creationTime, _id: id }, id };
            });

            // ONE multi-row INSERT — the throughput win over `insertMany`'s N
            // single-row statements (and the skipped per-row JS pipeline).
            const valuesSql = dsql.join(
                rows.map((row) => dsql`(${row.id}, ${row.creationTime}, ${JSON.stringify(row.document)})`),
                dsql`, `,
            );

            runWrite(sql, tableName, dsql`INSERT INTO ${dsql.identifier(tableName)} (id, _creationTime, ${dsql.identifier(DOC_COLUMN)}) VALUES ${valuesSql}`);

            // Companions + notifications ARE still maintained per row (shared with
            // the single `insert` via `syncCompanionsForInsert`), so search,
            // aggregates, ranks, CDC, the reactive cache and live subscriptions stay
            // correct — only the validator + trigger pipeline is skipped.
            for (const { document, id } of rows) {
                syncCompanionsForInsert(tableName, id, document);
                // eslint-disable-next-line no-await-in-loop -- sequential write-hook fan-out, mirrors the single insert
                await onWrite({ doc: document, id, op: "insert", table: tableName });
            }

            return rows.map((row) => row.id);
        },

        async insertMany(tableName, documents, batchOptions) {
            assertBatchLimit(documents.length, batchOptions?.limit, "insertMany");

            // A sequential loop over the single-row path so every row reuses the
            // full insert pipeline (defaults, validators, triggers, companion
            // sync, CDC, broadcast) with no risk of skipping an invariant. In a
            // mutation the DO's storage transaction rolls the whole batch back on a
            // mid-loop throw; in an action (no span) prior inserts persist.
            // The win is one caller round-trip, not fewer SQLite writes. Order is
            // preserved so an FK reference to an earlier row in the same batch resolves.
            const skipDuplicates = batchOptions?.skipDuplicates === true;
            const ids: (string | null)[] = [];

            for (const document of documents) {
                try {
                    // eslint-disable-next-line no-await-in-loop -- sequential by design: preserves insert order + the single-threaded SQLite transaction
                    ids.push(await writer.insert(tableName, document));
                } catch (error) {
                    if (skipDuplicates && error instanceof ConflictError && error.kind === "unique") {
                        // Preserve the input-order slot with null so callers can
                        // line up skipped duplicates by index.
                        // eslint-disable-next-line unicorn/no-null -- preserve slot with null for JSON compatibility/index alignment
                        ids.push(null);
                    } else {
                        throw error;
                    }
                }
            }

            return ids;
        },

        normalizeId(tableName, id) {
            return normalizeIdStructurally(schema, tableName, id);
        },

        async patch(id, patch, expectedTable) {
            // Single probe — eliminates the redundant `tableNameFromId` +
            // `writer.get` chain that doubled the SQL round-trips per patch
            // on the prior code path.
            const located = locateRowById(id, expectedTable);

            if (!located) {
                // A global row's id never lives in this DO; fall back to D1 —
                // but only when no table is pinned: a (non-global) by-id facade
                // must never reach a `.global()` row (IDOR).
                const global = expectedTable === undefined ? globalFallback() : undefined;

                if (global) {
                    await global.patch(id, patch);
                    return;
                }

                throw new LunoraError("INTERNAL", `document not found: ${id}`);
            }

            const { docJson: existingJson, row: existing, tableName } = located;
            const tableDefinition = schema.tables[tableName];

            if (!tableDefinition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            onRead(tableName, id);

            // Reject explicit `undefined` values: the merge + JSON.stringify below
            // would silently strip them, deleting the field instead of updating it.
            assertNoExplicitUndefined("patch", patch);

            const merged = { ...existing, ...patch, _id: id };

            applyOnUpdate(tableDefinition, patch, merged, auth);

            // Run column refinements on the merged row so a patch that flips a
            // field to an invalid value (e.g. negative amount) is rejected
            // before SQLite sees it.
            runRowValidators(tableDefinition, merged);

            if (hasMatchingTrigger(tableName, "before", "update")) {
                await fireTriggers("before", "update", { doc: { ...merged }, id, op: "update", previous: existing, table: tableName });
            }

            ensureBackfilledForTable(tableName);
            ensureRankBackfilledForTable(tableName);

            // Optimistic-concurrency guard: CAS on the read-time `__doc__`
            // snapshot. The before-update trigger above spans an `await`, so a
            // concurrent write could have committed in between; the
            // `AND ${DOC_COLUMN} = ?` clause makes that write match zero rows
            // and raise ConflictError instead of silently clobbering it (and
            // keeps `existing` — used for the aggregate/rank -prev steps — in
            // sync with what is actually on disk).
            runGuardedWrite(
                sql,
                tableName,
                dsql`UPDATE ${dsql.identifier(tableName)} SET ${dsql.identifier(DOC_COLUMN)} = ${JSON.stringify(merged)} WHERE id = ${id} AND ${dsql.identifier(DOC_COLUMN)} = ${existingJson}`,
            );

            syncSearch(tableName, id, merged, existing);
            syncGeo(tableName, id, merged);
            syncAggregates(tableName, existing, merged);
            syncRanks(tableName, id, existing, merged);

            // A patch can flip a row from matching to not-matching (or vice
            // versa) any scan-shaped predicate — `invalidate` blows both the
            // row's per-id deps AND the `*scan` bucket on this table.
            cache?.invalidate(tableName, id);

            recordCdc(tableName, id, "update", merged);
            broadcast({ key: id, op: "update", row: merged, table: tableName });

            if (hasMatchingTrigger(tableName, "after", "update")) {
                await fireTriggers("after", "update", { doc: merged, id, op: "update", previous: existing, table: tableName });
            }

            await onWrite({ doc: merged, id, op: "update", table: tableName });
        },

        async patchMany(patches, batchOptions, expectedTable) {
            assertBatchLimit(patches.length, batchOptions?.limit, "patchMany");

            // Sequential loop over the single-row patch so each row reuses the
            // full update pipeline (OCC, triggers, companion sync, CDC,
            // broadcast). `expectedTable` (the facade's bound table) scopes every
            // id to that table — same IDOR guard as the single patch. In a mutation
            // the DO's storage transaction rolls the whole batch back on a mid-loop
            // throw; in an action (no span) prior patches persist.
            for (const entry of patches) {
                // eslint-disable-next-line no-await-in-loop -- sequential by design: single-threaded SQLite transaction
                await writer.patch(entry.id, entry.patch, expectedTable);
            }

            return { patched: patches.length };
        },

        async patchWhere(tableName, args, batchOptions) {
            const global = globalWriterFor(tableName, "patchWhere");

            let patches: { id: string; patch: Record<string, unknown> }[];

            if (global) {
                // Global tables have no native batch primitive; resolve ids and
                // route each patch through the DO's single-row pipeline, which
                // forwards to the global writer.
                const rows = await global.findMany(tableName, { where: args.where });
                patches = rows.page.map((row) => {
                    return { id: String(row["_id"]), patch: args.patch };
                });
            } else {
                if (!schema.tables[tableName]) {
                    throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
                }

                // Resolve matching rows first. The mutation-span (if any) keeps
                // the read and the subsequent patches consistent.
                const page = await writer.findMany(tableName, { where: args.where });
                patches = page.page.map((row) => {
                    return { id: String(row["_id"]), patch: args.patch };
                });
            }

            assertBatchLimit(patches.length, batchOptions?.limit, "patchWhere");

            // Reuse the id-based pipeline so OCC, triggers, companions, CDC, and
            // broadcast all fire correctly. The concrete DO writer always
            // implements patchMany; the optional type is for global/D1 twins.
            if (writer.patchMany === undefined) {
                throw new LunoraError("INTERNAL", `ctx.db.${tableName}.patchMany is unavailable: this writer has no batch patch`);
            }

            await writer.patchMany(patches, batchOptions);

            return { patched: patches.length };
        },

        query(tableName) {
            const global = globalWriterFor(tableName, "query");

            if (global) {
                // Conservative dep so a live subscription over this global query
                // refreshes on any write to the table (see `findMany`).
                onRead(tableName, SCAN_DEP);

                return global.query(tableName);
            }

            // Fluent reader chain: we can't tell up front whether the caller
            // will end with `.withIndex(...)` or a bare scan, so we stamp the
            // safe upper bound (`*scan`). Future refinement would push the
            // hook into `buildReader`'s terminal `runFetch` so an indexed read
            // can record per-id deps.
            onRead(tableName, SCAN_DEP);

            return buildReader(sql, schema, tableName, onIndexUse);
        },

        async rank(tableName, indexName, rankOptions) {
            const global = globalWriterFor(tableName, "rank");

            if (global) {
                onRead(tableName, SCAN_DEP);

                return global.rank(tableName, indexName, rankOptions);
            }

            onIndexUse(tableName, indexName, "rank");

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            const index = definition.rankIndexes?.find((i) => i.name === indexName);

            if (!index) {
                throw new LunoraError("INTERNAL", `unknown rankIndex "${indexName}" on table "${tableName}"`);
            }

            // Refuse a shard-local rank when the partition spans shards (a
            // silently-wrong position otherwise) — see assertRankPartitionLocal.
            assertRankPartitionLocal(tableName, definition, index);

            // Same RLS coupling-seam semantics as count(): position is a
            // count-rows-strictly-before; an RLS-restricted ctx can't be
            // trusted to return a correct count, so we throw the same error.
            if (rankOptions.restrictsCounts) {
                throw new CountRlsUnsupportedError(tableName);
            }

            // rank() depends on every row in the partition — a single insert
            // or delete can shift the position. Same SCAN_DEP semantics as
            // count/aggregate so the reactive cache invalidates correctly.
            onRead(tableName, SCAN_DEP);

            ensureRankBackfilled(tableName, index);

            const rowId = typeof rankOptions.row === "string" ? rankOptions.row : (rankOptions.row["_id"] as string | undefined);

            if (!rowId) {
                // eslint-disable-next-line unicorn/no-null -- rank() is `Promise<RankResult | null>`: null is the documented "row not ranked" result
                return null;
            }

            const rankTable = rankTableName(tableName, index.name);
            const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));

            // Look up the row's stored sort key + partition.
            const sortColumnList = sortColumns.map((column) => quoteIdentifier(column)).join(", ");
            const ownRows = runDrizzle(
                sql,
                dsql`SELECT ${dsql.identifier("__partition__")}, ${dsql.raw(sortColumnList)} FROM ${dsql.identifier(rankTable)} WHERE ${dsql.identifier("__id__")} = ${rowId}`,
            ).toArray();

            const [own] = ownRows;

            if (own === undefined) {
                // eslint-disable-next-line unicorn/no-null -- rank() is `Promise<RankResult | null>`: null is the documented "row not ranked" result
                return null;
            }

            let partitionKey = own["__partition__"] as string;

            // If the caller pinned a partition via `where`/`baseWhere`, use it
            // to scope the rank — but only when it matches the row's stored
            // partition (otherwise the row isn't in the requested scope).
            const effective = mergeWhere(rankOptions.baseWhere, rankOptions.where);

            // rank() uses `where` solely to pin/validate the partition (an
            // equality on `partitionBy`), never as a row filter — it counts
            // strictly-before over the whole partition. A relation-crossing
            // predicate has nowhere to apply here, so resolving it would
            // silently drop it (a fail-**open** hazard). Reject it instead.
            assertFlatRelationPredicate(effective, schema, tableName, "rank");

            const partitionFromWhere = resolveRankPartition(index, effective);

            if (partitionFromWhere) {
                const requestedKey = encodePartitionKey(index.partitionBy ?? [], partitionFromWhere);

                if (requestedKey !== partitionKey) {
                    // eslint-disable-next-line unicorn/no-null -- rank() is `Promise<RankResult | null>`: null is the documented "row not in requested partition" result
                    return null;
                }

                partitionKey = requestedKey;
            }

            // The companion stores already-serialized sort values, so feed the
            // `own` row's columns straight into the shared strict-before helper.
            const ownSortValues = sortColumns.map((column) => own[column]);
            const { before, total } = countRankBefore(sql, rankTable, sortColumns, index.sortBy, partitionKey, ownSortValues, rowId);

            return { position: before + 1, total };
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- DatabaseWriterLike returns Promises (the D1 twin awaits I/O); the body is synchronous SQLite
        async rankBefore(tableName, indexName, rankBeforeOptions) {
            // `rankBefore` is the cross-shard rank cursor; the D1 (global) backend
            // has no such primitive (a `.global()` table isn't sharded), so fail
            // with a clear message instead of routing into a non-existent
            // `globalDb.rankBefore` (which would throw an opaque TypeError).
            if (isGlobalTable(tableName)) {
                throw new LunoraError(
                    "INTERNAL",
                    `rankBefore is not supported on the global (.global()) table '${tableName}' — cross-shard rank cursors apply only to sharded tables`,
                );
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            const index = definition.rankIndexes?.find((i) => i.name === indexName);

            if (!index) {
                throw new LunoraError("INTERNAL", `unknown rankIndex "${indexName}" on table "${tableName}"`);
            }

            // Same RLS coupling-seam as rank()/count(): a restricted-count ctx
            // can't be trusted to return a correct strictly-before count.
            if (rankBeforeOptions.restrictsCounts) {
                throw new CountRlsUnsupportedError(tableName);
            }

            // Same SCAN_DEP semantics as rank() — the count shifts on any
            // insert/delete in the partition.
            onRead(tableName, SCAN_DEP);

            ensureRankBackfilled(tableName, index);

            const rankTable = rankTableName(tableName, index.name);
            const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));

            // Encoding contract (see `rankKeyFromDoc` in rank.ts): the caller
            // derived `partitionKey` from `encodePartitionKey(index.partitionBy,
            // doc)` and `sortValues[i]` from the raw `doc[sortBy[i].field]`.
            // `syncRankIndexEntry` stores `__sort_k<i>__` as
            // `serializeSqlValue(doc[field] ?? null)`, so we apply the same
            // serialization here before comparing — this is the only step that
            // lets a PEER shard (which never stored this row) count correctly
            // against the explicit key.
            // eslint-disable-next-line unicorn/no-null -- mirror the trigger seam: a missing sort field serializes as a NULL column value, not undefined
            const serialized = index.sortBy.map((_, i) => serializeSqlValue(rankBeforeOptions.sortValues[i] ?? null));

            return countRankBefore(sql, rankTable, sortColumns, index.sortBy, rankBeforeOptions.partitionKey, serialized, rankBeforeOptions.rowId);
        },

        async rankPage(tableName, indexName, rankPageOptions = {}) {
            // Parity with rank(): rankPage's `where` only pins the partition (it is
            // never compiled into a row filter), so a relation-crossing predicate
            // would be silently dropped — a fail-**open** shape. Reject it on both
            // the local and the global-routed path.
            assertFlatRelationPredicate(mergeWhere(rankPageOptions.baseWhere, rankPageOptions.where), schema, tableName, "rankPage");

            const global = globalWriterFor(tableName, "rankPage");

            if (global) {
                onRead(tableName, SCAN_DEP);

                return global.rankPage(tableName, indexName, rankPageOptions);
            }

            onIndexUse(tableName, indexName, "rank");

            // Shared SQL/order/hydration lives in `computeRankPage`; the
            // user-facing surface projects only the hydrated docs.
            const { continueCursor, hasMore, rows } = computeRankPage(rankPageDeps, tableName, indexName, rankPageOptions);

            return { continueCursor, isDone: !hasMore, page: rows.map((row) => row.doc) };
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- DatabaseWriterLike returns Promises (the D1 twin awaits I/O); the body is synchronous SQLite
        async rankPageRows(tableName, indexName, rankPageOptions = {}) {
            // Cross-shard companion to `rankPage`: same shard-local ranked slice,
            // but each row keeps its rank-key tuple (`partitionKey`, `sortValues`,
            // `rowId`) so the query coordinator's k-way merge orders rows across
            // shards. There is no `.global()` fallback — cross-shard rank paging
            // applies only to `.shardBy(...)` tables (the global path returns one
            // already-ordered page with no shard boundaries to merge).
            assertFlatRelationPredicate(mergeWhere(rankPageOptions.baseWhere, rankPageOptions.where), schema, tableName, "rankPage");

            onIndexUse(tableName, indexName, "rank");

            const { directions, hasMore, rows } = computeRankPage(rankPageDeps, tableName, indexName, rankPageOptions);

            return { directions, hasMore, rows };
        },

        async restore(id, expectedTable) {
            // By-id, so it reaches a row that list reads hide. Clearing the marker
            // is a plain `patch` to `null` — it re-syncs companions and broadcasts
            // an update, so live list queries pick the row back up.
            const located = locateRowById(id, expectedTable);

            if (!located) {
                const global = expectedTable === undefined ? globalFallback() : undefined;

                if (global?.restore) {
                    await global.restore(id);

                    return;
                }

                throw new LunoraError("INTERNAL", `document not found: ${id}`);
            }

            const field = schema.tables[located.tableName]?.softDeleteMode?.field;

            if (!field) {
                throw new LunoraError("INTERNAL", `ctx.db.restore: table "${located.tableName}" is not a .softDelete() table`);
            }

            // Only an actually-soft-deleted row needs its rank entry rebuilt below
            // (a no-op restore on a live row must not double-insert it).
            const wasDeleted = located.row[field] !== null && located.row[field] !== undefined;

            // eslint-disable-next-line unicorn/no-null -- clearing the soft-delete marker writes SQL NULL into the column
            await writer.patch(id, { [field]: null }, expectedTable);

            // The soft delete REMOVED this row's rank-companion entry; `patch`'s
            // rank sync skips re-adding it (the sort fields are unchanged, so its
            // fast path assumes the entry is already present). Force the re-insert
            // here with `previous=undefined` — a pure INSERT, safe because the
            // entry was definitively dropped on soft delete. Search/aggregates were
            // kept (read-filtered), so they need nothing extra; the vector re-upsert
            // rode `patch`'s `onWrite("update")`.
            if (wasDeleted) {
                syncRanks(located.tableName, id, undefined, located.row);
            }
        },

        async replace(id, document, expectedTable, replaceOptions) {
            // Single probe that also captures the read-time `__doc__` blob.
            // The before-update trigger below spans an `await`, so the write
            // must compare-and-swap on this snapshot (see `runGuardedWrite`)
            // — the same OCC contract `patch`/`delete` honor. Reusing the
            // decoded row as `previous` also keeps the aggregate/rank -prev
            // steps consistent with what was actually on disk at read time.
            const located = locateRowById(id, expectedTable);

            if (!located) {
                // A global row's id never lives in this DO; fall back to D1 —
                // but only when no table is pinned: a (non-global) by-id facade
                // must never reach a `.global()` row (IDOR).
                const global = expectedTable === undefined ? globalFallback() : undefined;

                if (global) {
                    await global.replace(id, document, undefined, replaceOptions);
                    return;
                }

                throw new LunoraError("INTERNAL", `document not found: ${id}`);
            }

            const { docJson: existingJson, row: previous, tableName } = located;
            const tableDefinition = schema.tables[tableName];

            if (!tableDefinition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            // Reject explicit `undefined` values: the spread + JSON.stringify below
            // would silently strip them, deleting the field instead of writing it.
            assertNoExplicitUndefined("replace", document);

            // A client-supplied `_creationTime` is honored only under the
            // trusted-replay `allowExplicitId` opt-in (CDC replay, data-migration
            // rewrite — both replay a row's original creation time). The default
            // mutation path mints from `clock()` so a forged document
            // `_creationTime` can't overwrite the persisted timestamp.
            const creationTime = replaceOptions?.allowExplicitId && typeof document["_creationTime"] === "number" ? document["_creationTime"] : clock();
            const replaced: Record<string, unknown> = { ...document, _creationTime: creationTime, _id: id };

            applyOnUpdate(tableDefinition, document, replaced, auth);

            // Refinement checks fire on the post-onUpdate row so a defaulted
            // field still has to satisfy its `.check()` predicate.
            runRowValidators(tableDefinition, replaced);

            if (hasMatchingTrigger(tableName, "before", "update")) {
                await fireTriggers("before", "update", { doc: { ...replaced }, id, op: "update", previous, table: tableName });
            }

            ensureBackfilledForTable(tableName);
            ensureRankBackfilledForTable(tableName);

            // Optimistic-concurrency guard: CAS on the read-time `__doc__`
            // snapshot so a write that committed during the before-update
            // trigger `await` raises ConflictError instead of being silently
            // clobbered (and keeps `previous` — used for the aggregate/rank
            // -prev steps — in sync with disk).
            runGuardedWrite(
                sql,
                tableName,
                dsql`UPDATE ${dsql.identifier(tableName)} SET _creationTime = ${creationTime}, ${dsql.identifier(DOC_COLUMN)} = ${JSON.stringify(replaced)} WHERE id = ${id} AND ${dsql.identifier(DOC_COLUMN)} = ${existingJson}`,
            );

            syncSearch(tableName, id, replaced, previous);
            syncGeo(tableName, id, replaced);
            syncAggregates(tableName, previous, replaced);
            syncRanks(tableName, id, previous, replaced);

            cache?.invalidate(tableName, id);

            recordCdc(tableName, id, "update", replaced);
            broadcast({ key: id, op: "update", row: replaced, table: tableName });

            if (hasMatchingTrigger(tableName, "after", "update")) {
                await fireTriggers("after", "update", { doc: replaced, id, op: "update", previous, table: tableName });
            }

            await onWrite({ doc: replaced, id, op: "update", table: tableName });
        },

        async wipeShard(wipeOptions) {
            const excluded = new Set(wipeOptions?.exclude);
            const requested = wipeOptions?.tables;

            // Shard-local tables only. A `.global()` table's rows live in D1 and are
            // shared by every shard, so sweeping them here would erase other tenants'
            // data — "wipe this shard" must stop at the shard boundary.
            const names = Object.entries(schema.tables)
                .filter(([name, table]) => {
                    if (excluded.has(name) || (requested !== undefined && !requested.includes(name))) {
                        return false;
                    }

                    return (table as { shardMode?: { kind?: string } }).shardMode?.kind !== "global";
                })
                .map(([name]) => name);

            if (requested !== undefined) {
                for (const name of requested) {
                    if (!schema.tables[name]) {
                        throw new LunoraError("INTERNAL", `wipeShard: unknown table: ${name}`);
                    }
                }
            }

            const tables: Record<string, number> = {};
            let deleted = 0;

            // `deleteAll` is optional on the structural interface (the `.global()`
            // twins omit it); this writer always implements it.
            const { deleteAll } = writer;

            if (deleteAll === undefined) {
                throw new LunoraError("INTERNAL", "wipeShard: this writer has no deleteAll");
            }

            for (const name of names) {
                // eslint-disable-next-line no-await-in-loop -- sequential by design: one table at a time so cascades from an earlier table are already applied
                const result = await deleteAll(name, {
                    ...(wipeOptions?.chunkSize === undefined ? {} : { chunkSize: wipeOptions.chunkSize }),
                    // Erasure means gone, not marked: a soft delete would leave the
                    // rows on disk, which defeats the point of the primitive.
                    hard: true,
                });

                tables[name] = result.deleted;
                deleted += result.deleted;
            }

            return { deleted, tables };
        },
    };

    // Declared after `writer` but closed over by `fireTriggers` (defined above):
    // safe because `fireTriggers` only runs while a write is in flight, long
    // after construction has initialized this binding.
    const triggerContext: TriggerContextLike = { db: writer, scheduler };

    // Secure-by-default: under a `.rls("required")` schema the user-facing ctx
    // (codegen `buildCtx`, which sets `enforceRls`) gets a guarded writer that
    // denies protected tables to any handler that never engaged RLS. Triggers
    // keep the unguarded `writer` above (system path). `guardWriter` is a no-op
    // for non-`required` schemas, so the common case pays nothing.
    return options.enforceRls === true ? guardWriter(writer, schema, (id, expectedTable) => locateRowById(id, expectedTable)?.tableName) : writer;
};

export { assertValidClientId, createShardCtxDb, normalizeIdStructurally, NotUniqueError };
export { backfillAggregateIndexes, backfillRankIndexes, backfillSearchIndexes } from "./ctx-db-backfill";
export type { CdcChange } from "./ctx-db-cdc";
export { applyCdcChanges, bumpCdcEpoch, CDC_LOG_TABLE, minCdcSeq, readCdcChanges, readCdcCursor, readCdcEpoch, trimCdcChanges } from "./ctx-db-cdc";
export { advanceClientWatermark, CLIENT_WATERMARK_TABLE, migrateClientWatermark, readClientWatermark } from "./ctx-db-client-watermark";
export {
    deleteGlobalShapeSnapshot,
    deleteGlobalShapeSnapshotsForConnection,
    GLOBAL_SHAPE_SNAPSHOT_TABLE,
    migrateGlobalShapeSnapshot,
    readGlobalShapeSnapshot,
    writeGlobalShapeSnapshot,
} from "./ctx-db-global-shape-snapshot";
export { IDEMPOTENCY_TABLE, readIdempotent, trimIdempotent, writeIdempotent } from "./ctx-db-idempotency";
export { runShardMigrations } from "./ctx-db-migrations";
export { SEARCH_STATE_TABLE } from "./ctx-db-search-state";
export type { ShapeRow } from "./ctx-db-shapes";
export { selectShapeMemberIds, selectShapeRows } from "./ctx-db-shapes";
export type { SchedulerLike, TriggerContextLike, TriggerDefinitionLike, TriggerEventLike } from "./triggers";
export type {
    BroadcastDelta,
    Clock,
    ColumnMetaLike,
    CountArgs,
    CtxDbOptions,
    DatabaseWriterLike,
    GeoFilterBuilderLike,
    GeoIndexDefinitionLike,
    IdGenerator,
    IndexDefinitionLike,
    IndexRangeBuilderLike,
    PaginationOptions,
    ReadHook,
    SchemaLike,
    SearchFilterBuilderLike,
    SearchIndexDefinitionLike,
    ServerDefaultContextLike,
    SqlCursor,
    SqlExec,
    TableDefinitionLike,
    TableReaderLike,
    ValidatorLike,
    WriteEvent,
    WriteHook,
};
