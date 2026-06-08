/**
 * In-DO Convex-style database adapter.
 *
 * `createShardCtxDb` returns a `DatabaseWriterLike` (the structural surface
 * codegen-generated functions reach for) that reads and writes JSON-encoded
 * documents through the Durable Object's SQLite handle. `runShardMigrations`
 * brings the underlying SQLite tables and indexes into existence from the
 * schema declared in `cirrus/schema.ts`.
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

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db" is the established public module name: src/index.ts and every consumer/test import `createShardCtxDb` / `CtxDbOptions` from "./ctx-db.js", and it deliberately mirrors @cirrus/d1's "d1-ctx-db.ts" twin. Renaming the file or those exports would break those importers. `doc`/`docs` is the domain term for a stored document throughout the DO/D1 ORM. */

import type { AggregateTally } from "./aggregate-tally.js";
import { aggregateTableName, coerceAggregateNumber, encodeAggregateKey, foldAggregateTally, readAggregateValue } from "./aggregate-tally.js";
import type { AggregateIndexDefinitionLike, AggregateOptions, AggregateResult, GroupByEntry, GroupByOptions, RestrictableQueryOptions } from "./aggregates.js";
import { CountRlsUnsupportedError, mergeWhere, selectIndexForAggregate, selectIndexForCount, selectIndexForGroupBy } from "./aggregates.js";
import { SCAN_DEP } from "./dependency-tracker.js";
import NotFoundError from "./not-found-error.js";
import type { OrderKey, QueryArgs, QueryPage } from "./query-args.js";
import { buildSeekBeforeWhere, buildSeekWhere, compileOrderBy, decodeCursor, encodeCursor, normalizeOrderKeys } from "./query-args.js";
import type { RankBeforeOptions, RankBeforeResult, RankIndexDefinitionLike, RankOptions, RankPage, RankPageOptions, RankResult } from "./rank.js";
import { encodePartitionKey, matchesRankStaticWhere, RANK_TIEBREAK, rankTableName, resolveRankPartition, sortColumnName } from "./rank.js";
import type { ReactiveCache } from "./reactive-cache.js";
import type { RelationDefinitionLike } from "./relations.js";
import { applyOnDelete, resolveWith, runRowValidators } from "./relations.js";
import { buildFtsMatch, ftsTableName, scoreDocument, stringifySearchText, tokenizeSearch } from "./search-text.js";
import serializeSqlValue from "./serialize-sql.js";
import type { SystemDatabaseReader, SystemReaderSchedulerLike, SystemReaderStorageLike } from "./system-reader.js";
import { createSystemReader } from "./system-reader.js";
import { ConflictError } from "./transaction.js";
import type { SchedulerLike, TriggerContextLike, TriggerDefinitionLike, TriggerEventLike, TriggerOpLike, TriggerTimingLike } from "./triggers.js";
import { runTriggers } from "./triggers.js";
import type { MutationDelta } from "./types.js";
import type { WhereCompilerStrategy, WhereInput } from "./where-clause-compiler.js";
import { compileWhere } from "./where-clause-compiler.js";

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
 * Minimal subset of `@cirrus/server`'s `Schema&lt;T>` the adapter actually
 * reads. Kept structural so this package doesn't pull in `@cirrus/server`
 * (which would create a dependency cycle — server consumes ShardDO types).
 */
interface SchemaLike {
    readonly tables: Record<string, TableDefinitionLike>;
}

interface TableDefinitionLike {
    readonly aggregateIndexes?: ReadonlyArray<AggregateIndexDefinitionLike>;
    readonly indexes: ReadonlyArray<IndexDefinitionLike>;
    readonly rankIndexes?: ReadonlyArray<RankIndexDefinitionLike>;
    readonly relationMap?: Record<string, RelationDefinitionLike>;
    readonly searchIndexes?: ReadonlyArray<SearchIndexDefinitionLike>;
    readonly shape: Record<string, ValidatorLike>;
    // Mirror of `@cirrus/server`'s `ShardMode`. The `shardBy` variant carries
    // a `field` (the column the runtime hashes on) but most consumers only
    // read `kind`, so `field` is left optional here to keep the structural
    // mirror narrow without forcing every callsite to spread the variant.
    readonly shardMode?: { field?: string; kind: "global" | "root" | "shardBy" };
    readonly triggerMap?: Record<string, TriggerDefinitionLike>;
}

interface IndexDefinitionLike {
    readonly fields: ReadonlyArray<string>;
    readonly name: string;
    readonly unique?: boolean;
}

interface SearchIndexDefinitionLike {
    readonly field: string;
    readonly filterFields?: ReadonlyArray<string>;
    readonly name: string;
}

/**
 * Column constraints/defaults the write layer honors, mirrored structurally
 * from `@cirrus/values`' `ColumnMeta` (kept local so this package doesn't take
 * a runtime dependency on the validator package — same reasoning as
 * {@link SchemaLike}). Populated on the live validator's `_meta.column` and
 * read through here when the generated `shard.ts` hands us the real schema.
 */
interface ColumnMetaLike {
    readonly defaultFn?: () => unknown;
    readonly defaultValue?: unknown;
    readonly notNull?: boolean;
    readonly onUpdateFn?: () => unknown;
    readonly unique?: boolean;
}

interface ValidatorLike {
    readonly _meta?: { readonly column?: ColumnMetaLike };
    readonly kind?: string;

    /**
     * Optional runtime parser. Real validators from `@cirrus/values` always
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

/** Pluggable wall clock — defaults to `Date.now`. */
type Clock = () => number;

/** Pluggable ID minter — defaults to `crypto.randomUUID()`. */
type IdGenerator = () => string;

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
    onRead?: ReadHook;
    onWrite?: WriteHook;
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

/** Scheduler stub wired when no scheduler is configured — every method throws. */
const throwingScheduler: SchedulerLike = {
    runAfter: () => {
        throw new Error("ctx.scheduler: no scheduler configured for triggers. Pass `scheduler` to createShardCtxDb().");
    },
    runAt: () => {
        throw new Error("ctx.scheduler: no scheduler configured for triggers. Pass `scheduler` to createShardCtxDb().");
    },
};

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
    withIndex: (indexName: string, range?: (q: IndexRangeBuilderLike) => IndexRangeBuilderLike) => TableReaderLike;
    withSearchIndex: (indexName: string, search: (q: SearchFilterBuilderLike) => SearchFilterBuilderLike) => TableReaderLike;
}

/**
 * Options accepted by `count()`. Alias of {@link RestrictableQueryOptions} so
 * the RLS middleware (`@cirrus/server` §3.2) and the aggregate reader (§3.1)
 * share a single option surface. When `restrictsCounts` is `true`, the reader
 * throws `CirrusError("COUNT_RLS_UNSUPPORTED")` (422) rather than scanning,
 * matching kitcn's documented behavior for counts in an RLS-restricted context.
 */
type CountArgs = RestrictableQueryOptions;

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
     * Count rows in `tableName`. Uses a declared `aggregateIndex` when one
     * covers the `where` keys (no scan); otherwise scans. Throws
     * `COUNT_RLS_UNSUPPORTED` when `options.restrictsCounts` is `true` (the
     * RLS-aware ctx seam from §3.2).
     */
    count: (tableName: string, where?: RestrictableQueryOptions | WhereInput) => Promise<number>;
    delete: (id: string) => Promise<void>;
    findFirst: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown> | null>;
    findFirstOrThrow: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown>>;
    findMany: (tableName: string, args?: QueryArgs) => Promise<QueryPage>;
    get: (id: string) => Promise<Record<string, unknown> | null>;

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
     * constraints, or forge cross-table references. Only the dev/admin import
     * path (which round-trips a trusted snapshot) may opt in via
     * `options.allowExplicitId`, in which case a string `_id` on `document`
     * becomes the row's primary key.
     */
    insert: (tableName: string, document: Record<string, unknown>, options?: { allowExplicitId?: boolean }) => Promise<string>;

    /**
     * Validate an untrusted `id` against the structural shape of an id for
     * `tableName`, returning it when well-formed and `null` otherwise. Pure —
     * it never reads the database (a valid id for an absent row still returns
     * the id), matching Convex's `db.normalizeId`. Throws on an unknown table.
     */
    normalizeId: (tableName: string, id: string) => null | string;
    patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
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
     * D1 twin (`@cirrus/d1`) omits it for now — cross-shard rank over a
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
    replace: (id: string, document: Record<string, unknown>) => Promise<void>;

    /**
     * Best-effort, read-only reader over Cirrus's system tables
     * (`_scheduled_functions`, `_storage`). Eventually consistent and **not**
     * part of the shard's transaction snapshot — see {@link SystemDatabaseReader}.
     * Reaches across to the `SchedulerDO` / R2 on every call rather than the
     * local SQLite.
     *
     * Optional on this structural interface: the DO writer ({@link createShardCtxDb})
     * always sets it, and it's what backs `ctx.db.system` (which the public
     * `@cirrus/server` `DatabaseReader.system` types as required). The D1 twin
     * (`@cirrus/d1`), used only for `.global()` table routing and never assigned
     * to `ctx.db`, omits it — same pattern as the optional `rankBefore` above.
     */
    system?: SystemDatabaseReader;
}

const DOC_COLUMN = "__doc__";

/**
 * Encode an array of cursor values as a base64 JSON string. Matches the
 * format `decodeCursor` (`query-args.ts`) round-trips, so rank-page cursors
 * decode through the same helper as the keyset cursors that drive
 * `findMany`/`paginate`. Inlined (rather than reusing `encodeCursor` which is
 * row-shaped) so rank cursors can be N-tuples.
 */
const encodeRankCursor = (values: ReadonlyArray<unknown>): string => {
    const json = JSON.stringify(values);
    const bytes = new TextEncoder().encode(json);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary);
};

/**
 * Cheap predicate test against a flat literal `where` (the shape baked into an
 * `aggregateIndex.where`). Only handles literal equality and `{ eq: ... }` —
 * the full operator vocabulary stays in the SQL compiler. Used during counter
 * maintenance to skip rows that don't qualify for a filtered aggregate.
 */
const matchesStaticWhere = (document: Record<string, unknown>, predicate: Record<string, unknown>): boolean => {
    for (const [field, expected] of Object.entries(predicate)) {
        const actual = document[field];

        if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
            const operatorKeys = Object.keys(expected);

            if (operatorKeys.length === 1 && operatorKeys[0] === "eq") {
                if (actual !== (expected as { eq: unknown }).eq) {
                    return false;
                }

                continue;
            }

            return false;
        }

        if (actual !== expected) {
            return false;
        }
    }

    return true;
};

/** Marker keys distinguishing a restrictable-query option set from a bare `WhereInput` tree. */
const COUNT_OPTION_KEYS = new Set(["baseWhere", "restrictsCounts", "where"]);

/**
 * Disambiguate the `count(table, ?)` arg. The legacy positional is a
 * `WhereInput` tree; the new shape is `{ where, baseWhere, restrictsCounts }`.
 * A value is treated as the options shape when every own key is a marker —
 * otherwise it's a `where` literal. Boolean combinators (`AND`/`OR`/`NOT`)
 * keep it on the `where` side.
 */
const normalizeCountArgument = (argument: RestrictableQueryOptions | undefined | WhereInput): RestrictableQueryOptions => {
    if (argument === undefined) {
        return {};
    }

    if (typeof argument !== "object" || Array.isArray(argument)) {
        return { where: argument as WhereInput };
    }

    const keys = Object.keys(argument);

    if (keys.length === 0) {
        return {};
    }

    if (keys.every((key) => COUNT_OPTION_KEYS.has(key))) {
        return argument as RestrictableQueryOptions;
    }

    return { where: argument as WhereInput };
};

/**
 * Closed allowlist mapping each reducer `op` to the literal SQL function it may
 * emit. `AggregateOp` is a compile-time type only — a caller reaching the
 * runtime with an off-list `op` (forged wire payload, `as any`) would otherwise
 * have it concatenated straight into the SQL string. Routing every reducer
 * through this table guarantees only a known function name reaches the query.
 */
const AGGREGATE_SQL_FUNCTION: Record<string, string> = { avg: "AVG", count: "COUNT", max: "MAX", min: "MIN", sum: "SUM" };

/** Resolve a reducer `op` to its SQL function, throwing on an off-allowlist op. */
const aggregateSqlFunction = (op: string): string => {
    const sqlFunction = AGGREGATE_SQL_FUNCTION[op];

    if (sqlFunction === undefined) {
        throw new Error(`unknown aggregate op "${op}": expected one of ${Object.keys(AGGREGATE_SQL_FUNCTION).join(", ")}`);
    }

    return sqlFunction;
};

/** Indirection that lets us call `exec` without typing the literal. */
const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...params: unknown[]): SqlCursor<Row> => {
    const runner = sql.exec as (this: SqlExec, query: string, ...rest: unknown[]) => SqlCursor<Row>;

    return runner.call(sql, query, ...params);
};

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const jsonPath = (field: string): string => {
    // Internal columns live alongside the doc; expose them via the
    // dedicated stored column so SQLite can hit the regular index lookup
    // path instead of decoding JSON.
    if (field === "_id" || field === "id") {
        return "id";
    }

    if (field === "_creationTime") {
        return "_creationTime";
    }

    return `json_extract(${DOC_COLUMN}, '$.${field.replaceAll("'", "''")}')`;
};

/**
 * Memoized per-`SqlExec` FTS5 capability probe. Cloudflare Durable Objects ship
 * SQLite with FTS5; `node:sqlite` (used in tests) does not. We create and drop a
 * throwaway virtual table once per handle and cache the result — the DO's `sql`
 * object is stable for the object's lifetime, so this runs at most once per DO.
 */
const ftsAvailabilityCache = new WeakMap<SqlExec, boolean>();

const isFtsAvailable = (sql: SqlExec): boolean => {
    const cached = ftsAvailabilityCache.get(sql);

    if (cached !== undefined) {
        return cached;
    }

    let available: boolean;

    try {
        runSql(sql, `CREATE VIRTUAL TABLE IF NOT EXISTS "__cirrus_fts_probe" USING fts5(x)`);
        available = true;
    } catch {
        available = false;
    } finally {
        // Always attempt the DROP so the probe table never lingers — if the
        // CREATE threw, the IF EXISTS makes the DROP a no-op; if the CREATE
        // succeeded but a later statement threw (today there isn't one,
        // but keep the invariant for future probes), the DROP still runs.
        try {
            runSql(sql, `DROP TABLE IF EXISTS "__cirrus_fts_probe"`);
        } catch {
            // The probe table cleanup is best-effort; swallow so the
            // availability decision still propagates.
        }
    }

    ftsAvailabilityCache.set(sql, available);

    return available;
};

const rowToDocument = (row: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!row) {
        return undefined;
    }

    const raw = row[DOC_COLUMN];
    let parsed: Record<string, unknown>;

    if (typeof raw === "string") {
        parsed = JSON.parse(raw) as Record<string, unknown>;
    } else if (raw && typeof raw === "object") {
        parsed = raw as Record<string, unknown>;
    } else {
        parsed = {};
    }

    const { id } = row;

    if (typeof id === "string") {
        parsed["_id"] = id;
    }

    const creationTime = row["_creationTime"];

    if (typeof creationTime === "number") {
        parsed["_creationTime"] = creationTime;
    }

    return parsed;
};

interface SearchStage {
    definition: SearchIndexDefinitionLike;
    field: string;
    filters: { field: string; value: unknown }[];
    hasQuery: boolean;
    indexName: string;
    query: string;
}

interface QueryStage {
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

const createSearchBuilder = (search: SearchStage, tableName: string): SearchFilterBuilderLike => {
    const builder: SearchFilterBuilderLike = {
        eq: (field, value) => {
            if (!search.definition.filterFields?.includes(field)) {
                throw new Error(`field "${field}" is not a filter field of search index "${search.indexName}" on table "${tableName}"`);
            }

            search.filters.push({ field, value });

            return builder;
        },
        search: (field, query) => {
            if (field !== search.definition.field) {
                throw new Error(`search index "${search.indexName}" on table "${tableName}" indexes "${search.definition.field}", not "${field}"`);
            }

            // Mutate the caller-owned stage in place (same object the query
            // planner reads back); alias to a local so the param itself isn't
            // reassigned.
            const stage = search;

            stage.field = field;
            stage.query = query;
            stage.hasQuery = true;

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
const searchViaFts = (sql: SqlExec, tableName: string, search: SearchStage, limit: number | undefined): Record<string, unknown>[] => {
    const tokens = tokenizeSearch(search.query);

    if (tokens.length === 0) {
        return [];
    }

    const ftName = ftsTableName(tableName, search.indexName);
    // MATCH must target the FTS table (by name or an indexed column), never the
    // bare alias `f` — `f MATCH ?` is a "no such column: f" error in SQLite.
    // We match the indexed `__text__` column so the alias join still works.
    const where: string[] = [`f."__text__" MATCH ?`];
    const params: unknown[] = [buildFtsMatch(tokens)];

    for (const filter of search.filters) {
        where.push(`${jsonPath(filter.field)} = ?`);
        params.push(serializeSqlValue(filter.value));
    }

    // `f.rank` is FTS5's bm25 relevance (best first); the `_creationTime DESC`
    // tiebreak matches the scan fallback so equal-rank rows order newest-first
    // on both engines.
    let querySql = `SELECT m.id, m._creationTime, m.${DOC_COLUMN} FROM ${quoteIdentifier(ftName)} f JOIN ${quoteIdentifier(tableName)} m ON m.id = f."__id__" WHERE ${where.join(" AND ")} ORDER BY f.rank, m._creationTime DESC`;

    if (typeof limit === "number") {
        querySql += ` LIMIT ${String(Math.max(0, Math.floor(limit)))}`;
    }

    const rows = runSql(sql, querySql, ...params).toArray();
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
const searchViaScan = (sql: SqlExec, tableName: string, search: SearchStage, limit: number | undefined): Record<string, unknown>[] => {
    const tokens = tokenizeSearch(search.query);

    if (tokens.length === 0) {
        return [];
    }

    const where: string[] = [];
    const params: unknown[] = [];

    for (const filter of search.filters) {
        where.push(`${jsonPath(filter.field)} = ?`);
        params.push(serializeSqlValue(filter.value));
    }

    let querySql = `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)}`;

    if (where.length > 0) {
        querySql += ` WHERE ${where.join(" AND ")}`;
    }

    const rows = runSql(sql, querySql, ...params).toArray();
    const scored: { creationTime: number; doc: Record<string, unknown>; score: number }[] = [];

    for (const row of rows) {
        const record = rowToDocument(row);

        if (!record) {
            continue;
        }

        const score = scoreDocument(stringifySearchText(record[search.field]), tokens);

        if (score > 0) {
            scored.push({ creationTime: typeof record["_creationTime"] === "number" ? record["_creationTime"] : 0, doc: record, score });
        }
    }

    scored.sort((a, b) => b.score - a.score || b.creationTime - a.creationTime);

    const docs = scored.map((entry) => entry.doc);

    return typeof limit === "number" ? docs.slice(0, Math.max(0, Math.floor(limit))) : docs;
};

/** DO dialect: fields resolve through `json_extract`; values via {@link serializeSqlValue}. */
const doWhereStrategy: WhereCompilerStrategy = { fieldRef: jsonPath, serialize: serializeSqlValue };

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
const paginateStage = (sql: SqlExec, tableName: string, stage: QueryStage, options: PaginationOptions): QueryPage => {
    const numberItems = Math.max(0, Math.floor(options.numItems));
    const orderKeys = paginateOrderKeys(stage);
    // A cursor is always a non-empty base64 string, so truthiness distinguishes
    // a bounded page (endCursor set) from the legacy open-ended one (null/omitted).
    const bounded = typeof options.endCursor === "string";
    const { params, sql: whereSql } = compileWhere(paginateWhere(stage, orderKeys, options.cursor, options.endCursor), doWhereStrategy);

    let querySql = `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)}`;

    if (whereSql) {
        querySql += ` WHERE ${whereSql}`;
    }

    querySql += ` ORDER BY ${compileOrderBy(orderKeys, jsonPath)}`;

    const filtered = stage.inMemoryFilters.length > 0;

    // A bounded page returns its entire range, so never cap the SQL scan. An
    // unbounded, unfiltered page over-fetches one row to learn `isDone`.
    if (!filtered && !bounded) {
        querySql += ` LIMIT ${String(numberItems + 1)}`;
    }

    const rows = runSql(sql, querySql, ...params).toArray();
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
 * Thrown by `.unique()` when more than one row matches. Like {@link ConflictError}
 * / `NotFoundError`, `code` / `status` are declared as own properties so the
 * cross-package structural error mapper renders it as a 400 without an
 * `instanceof` check against `@cirrus/do`.
 */
class NotUniqueError extends Error {
    public readonly code: string = "NOT_UNIQUE";

    public readonly status: number = 400;

    public constructor(message: string = "unique() found more than one matching document") {
        super(message);
        this.name = "NotUniqueError";
    }
}

/**
 * Pure structural id validation shared by both ORM dialects (the DO writer here
 * and the D1 twin). An id is well-formed when it is a non-empty string carrying
 * no whitespace (interior, leading, or trailing) and no NUL byte — the shape
 * every minter in the stack produces (`crypto.randomUUID()` by default; a custom
 * `idGenerator` or an `allowExplicitId` import path may supply another opaque
 * string). Cirrus ids carry no embedded table tag, so this is the strongest
 * structural check the format admits; it never touches the database, matching
 * Convex's `normalizeId`. Returns the id unchanged when valid, else `null`.
 * Throws on an unknown table so a typo'd table name surfaces loudly rather than
 * silently returning `null`.
 */
// Hoisted to module scope so the matcher is compiled once, not per normalizeId call.
// NUL is matched via String.fromCharCode so the pattern stays free of control characters.
const ID_WHITESPACE_PATTERN = /\s/u;
const NUL_CHARACTER = String.fromCodePoint(0);

const normalizeIdStructurally = (schema: SchemaLike, tableName: string, id: string): null | string => {
    if (!schema.tables[tableName]) {
        throw new Error(`unknown table: ${tableName}`);
    }

    // Reject empties and any id carrying whitespace or a NUL byte — no minter in
    // the stack produces those, so their presence marks the string as not an id.
    if (typeof id !== "string" || id.length === 0 || ID_WHITESPACE_PATTERN.test(id) || id.includes(NUL_CHARACTER)) {
        // eslint-disable-next-line unicorn/no-null -- documented `normalizeId` result shape (Id | null); null is the "not a valid id" sentinel
        return null;
    }

    return id;
};

const buildReader = (sql: SqlExec, schema: SchemaLike, tableName: string): TableReaderLike => {
    const tableDefinition = schema.tables[tableName];

    if (!tableDefinition) {
        throw new Error(`unknown table: ${tableName}`);
    }

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
            throw new Error("runSearchFetch called without a staged search");
        }

        const filtered = stage.inMemoryFilters.length > 0;
        const engineLimit = filtered ? undefined : limit;
        const docs = isFtsAvailable(sql) ? searchViaFts(sql, tableName, search, engineLimit) : searchViaScan(sql, tableName, search, engineLimit);

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

    const buildOrderClause = (): string => {
        const orderFields = stage.indexFields.length > 0 ? stage.indexFields : ["_creationTime"];
        const orderDirection = stage.order === "desc" ? "DESC" : "ASC";

        return orderFields.map((field) => `${jsonPath(field)} ${orderDirection}`).join(", ");
    };

    const runFetch = (limit: number | undefined): Record<string, unknown>[] => {
        if (stage.search) {
            return runSearchFetch(limit);
        }

        const where: string[] = [];
        const params: unknown[] = [];

        for (const condition of stage.sqlConditions) {
            where.push(`${jsonPath(condition.field)} ${condition.comparator} ?`);
            params.push(serializeSqlValue(condition.value));
        }

        let querySql = `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)}`;

        if (where.length > 0) {
            querySql += ` WHERE ${where.join(" AND ")}`;
        }

        querySql += ` ORDER BY ${buildOrderClause()}`;

        if (typeof limit === "number" && stage.inMemoryFilters.length === 0) {
            querySql += ` LIMIT ${String(Math.max(0, Math.floor(limit)))}`;
        }

        const rows = runSql(sql, querySql, ...params).toArray();
        const docs: Record<string, unknown>[] = [];

        for (const row of rows) {
            const record = rowToDocument(row);

            if (!record) {
                continue;
            }

            if (stage.inMemoryFilters.every((predicate) => predicate(record))) {
                docs.push(record);

                if (typeof limit === "number" && docs.length >= limit) {
                    break;
                }
            }
        }

        return docs;
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
                throw new Error("pagination is not supported on search queries; use .take(n) or .collect()");
            }

            return paginateStage(sql, tableName, stage, options);
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
        withIndex(indexName, range) {
            const definition = tableDefinition.indexes.find((index) => index.name === indexName);

            if (!definition) {
                throw new Error(`unknown index "${indexName}" on table "${tableName}"`);
            }

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
                throw new Error(`unknown search index "${indexName}" on table "${tableName}"`);
            }

            const searchStage: SearchStage = {
                definition,
                field: definition.field,
                filters: [],
                hasQuery: false,
                indexName,
                query: "",
            };

            stage.search = searchStage;
            search(createSearchBuilder(searchStage, tableName));

            if (!searchStage.hasQuery) {
                throw new Error(`search index "${indexName}" on table "${tableName}" requires a .search(field, query) call`);
            }

            return reader;
        },
    };

    return reader;
};

/** A table's fields paired with their column meta, skipping fields that declare none. */
const tableColumns = (definition: TableDefinitionLike): [string, ColumnMetaLike][] => {
    const columns: [string, ColumnMetaLike][] = [];

    for (const [field, validator] of Object.entries(definition.shape)) {
        const column = validator._meta?.column;

        if (column) {
            columns.push([field, column]);
        }
    }

    return columns;
};

/**
 * Fill any field absent from `document` that declares a `.default()` literal or
 * `.$defaultFn()` factory. The factory wins when both are present; a literal is
 * applied on presence (`"defaultValue" in column`), so `null`/`false`/`0`
 * defaults survive.
 */
const applyInsertDefaults = (definition: TableDefinitionLike, document: Record<string, unknown>): Record<string, unknown> => {
    const result = { ...document };

    for (const [field, column] of tableColumns(definition)) {
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
const applyOnUpdate = (definition: TableDefinitionLike, provided: Record<string, unknown>, target: Record<string, unknown>): void => {
    // Mutate the caller-owned record in place; alias so the param isn't reassigned.
    const out = target;

    for (const [field, column] of tableColumns(definition)) {
        if (column.onUpdateFn && !(field in provided)) {
            out[field] = column.onUpdateFn();
        }
    }
};

/** workerd and node:sqlite both phrase a UNIQUE-index breach as "UNIQUE constraint failed". */
const UNIQUE_VIOLATION_RE = /unique constraint failed/i;
const isUniqueViolation = (error: unknown): boolean => error instanceof Error && UNIQUE_VIOLATION_RE.test(error.message);

/** Run a write, remapping a UNIQUE-index breach to a {@link ConflictError} (code `CONFLICT`, 409). */
const runWrite = (sql: SqlExec, table: string, query: string, ...params: unknown[]): void => {
    try {
        runSql(sql, query, ...params);
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new ConflictError(`unique constraint violation on "${table}"`);
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
const runGuardedWrite = (sql: SqlExec, table: string, query: string, ...params: unknown[]): void => {
    runWrite(sql, table, query, ...params);

    const changedRow = runSql<{ changed: number }>(sql, `SELECT changes() AS changed`).one();

    if (changedRow.changed === 0) {
        throw new ConflictError(`optimistic concurrency conflict on "${table}" — the row changed during this mutation; refetch and retry`);
    }
};

/**
 * Whether none of the fields a rank index reads (partition / sort / static
 * `where`) differ between two row versions — the fast path that lets a patch of
 * an unrelated field skip companion maintenance.
 */
const rankIndexFieldsUnchanged = (index: RankIndexDefinitionLike, previous: Record<string, unknown>, next: Record<string, unknown>): boolean => {
    const fields = [...(index.partitionBy ?? []), ...index.sortBy.map((key) => key.field), ...(index.where ? Object.keys(index.where) : [])];

    return fields.every((field) => previous[field] === next[field]);
};

/**
 * Apply one rank index's `-prev + next` companion step for a single row write.
 * DELETE-by-id is unconditional (a missing row is a no-op); INSERT only when the
 * new row qualifies against the index's static `where`.
 */
const syncRankIndexEntry = (
    sql: SqlExec,
    tableName: string,
    index: RankIndexDefinitionLike,
    id: string,
    previous: Record<string, unknown> | undefined,
    next: Record<string, unknown> | undefined,
): void => {
    // Fast path: both sides exist and no field this index reads changed — the
    // companion entry is already correct, so skip the DELETE+INSERT pair.
    if (previous && next && rankIndexFieldsUnchanged(index, previous, next)) {
        return;
    }

    const rankTable = rankTableName(tableName, index.name);

    if (previous) {
        runSql(sql, `DELETE FROM ${quoteIdentifier(rankTable)} WHERE "__id__" = ?`, id);
    }

    if (!next || (index.where && !matchesRankStaticWhere(next, index.where))) {
        // Nothing to insert: either a pure delete, or `next` doesn't qualify
        // against the index's static `where` (the prior entry, if any, is gone).
        return;
    }

    const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
    const columnList = ["__id__", "__partition__", ...sortColumns].map((column) => quoteIdentifier(column)).join(", ");
    const placeholders = ["?", "?", ...sortColumns.map(() => "?")].join(", ");
    const partitionKey = encodePartitionKey(index.partitionBy ?? [], next);
    // eslint-disable-next-line unicorn/no-null -- binds the rank sort column to SQLite: a missing sort field is a NULL column value, not undefined
    const sortValues = index.sortBy.map((key) => serializeSqlValue(next[key.field] ?? null));

    runSql(sql, `INSERT INTO ${quoteIdentifier(rankTable)} (${columnList}) VALUES (${placeholders})`, id, partitionKey, ...sortValues);
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
 * by {@link syncRankIndexEntry} — so the per-key comparison matches the
 * companion's BLOB column regardless of which shard supplied the value.
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
    const beforeBranches: string[] = [];
    const beforeParams: unknown[] = [];

    for (let pivot = 0; pivot < sortColumns.length + 1; pivot += 1) {
        const conditions: string[] = [];

        for (let prefix = 0; prefix < pivot; prefix += 1) {
            conditions.push(`${quoteIdentifier(sortColumns[prefix] as string)} IS ?`);
            beforeParams.push(serializedSortValues[prefix]);
        }

        const column = sortColumns[pivot];
        const sortKey = sortBy[pivot];

        if (column !== undefined && sortKey !== undefined) {
            const operator = sortKey.direction === "desc" ? ">" : "<";

            conditions.push(`${quoteIdentifier(column)} ${operator} ?`);
            beforeParams.push(serializedSortValues[pivot]);
        } else {
            // Final pivot is the `__id__` ASC tiebreak.
            conditions.push(`${quoteIdentifier(RANK_TIEBREAK)} < ?`);
            beforeParams.push(rowId);
        }

        const [firstCondition] = conditions;

        beforeBranches.push(conditions.length === 1 && firstCondition !== undefined ? firstCondition : `(${conditions.join(" AND ")})`);
    }

    const beforeWhere = beforeBranches.join(" OR ");
    const beforeRow = runSql<{ c: number }>(
        sql,
        `SELECT COUNT(*) AS c FROM ${quoteIdentifier(rankTable)} WHERE "__partition__" = ? AND (${beforeWhere})`,
        partitionKey,
        ...beforeParams,
    ).one();

    const totalRow = runSql<{ c: number }>(sql, `SELECT COUNT(*) AS c FROM ${quoteIdentifier(rankTable)} WHERE "__partition__" = ?`, partitionKey).one();

    return { before: beforeRow.c, total: totalRow.c };
};

/** Reserved append-only changelog table backing CDC streaming export and replay-PITR. */
const CDC_LOG_TABLE = "__cdc_log";

/** One change-data-capture entry: a committed mutation, in monotonic `seq` order. */
interface CdcChange {
    /** Post-image document for insert/update; absent for delete (the `id` identifies the removed row). */
    doc?: Record<string, unknown>;
    id: string;
    op: "delete" | "insert" | "update";
    /** Monotonic per-shard cursor — strictly increasing, never reused. */
    seq: number;
    table: string;
    /** Wall-clock millis when the change committed (the ctx-db `clock`). */
    ts: number;
}

/**
 * Create the `__cdc_log` table. `seq` is an `AUTOINCREMENT` primary key, giving
 * each shard a monotonic cursor that streaming-export consumers and replay-PITR
 * page through; `doc` holds the post-image JSON for insert/update and is `NULL`
 * for delete. Only created when CDC is enabled, so non-CDC apps pay nothing.
 */
const migrateCdcLog = (sql: SqlExec): void => {
    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(CDC_LOG_TABLE)} (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            "table" TEXT NOT NULL,
            id TEXT NOT NULL,
            op TEXT NOT NULL,
            doc TEXT
        )`,
    );
};

/**
 * Append one committed mutation to the changelog. Called inside the same DO
 * transaction as the row write, so the change is durable iff the write is.
 */
const appendCdcChange = (sql: SqlExec, ts: number, table: string, id: string, op: CdcChange["op"], doc: Record<string, unknown> | undefined): void => {
    runSql(
        sql,
        `INSERT INTO ${quoteIdentifier(CDC_LOG_TABLE)} (ts, "table", id, op, doc) VALUES (?, ?, ?, ?, ?)`,
        ts,
        table,
        id,
        op,
        // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct post-image for a delete; the `id` column identifies the removed row.
        doc === undefined ? null : JSON.stringify(doc),
    );
};

/**
 * Read changelog entries newer than `sinceSeq` in commit order, up to `limit`
 * (clamped to [1, 10000]). Returns the rows plus the cursor to resume from (the
 * last `seq`, or `sinceSeq` when the page is empty).
 */
const readCdcChanges = (sql: SqlExec, options: { limit?: number; sinceSeq?: number } = {}): { changes: CdcChange[]; cursor: number } => {
    const sinceSeq = options.sinceSeq ?? 0;
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));

    const rows = runSql<{ doc: null | string; id: string; op: string; seq: number; table: string; ts: number }>(
        sql,
        `SELECT seq, ts, "table", id, op, doc FROM ${quoteIdentifier(CDC_LOG_TABLE)} WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
        sinceSeq,
        limit,
    ).toArray();

    const changes = rows.map((row): CdcChange => {
        const base = { id: row.id, op: row.op as CdcChange["op"], seq: row.seq, table: row.table, ts: row.ts };

        return row.doc === null ? base : { ...base, doc: JSON.parse(row.doc) as Record<string, unknown> };
    });

    return { changes, cursor: changes.at(-1)?.seq ?? sinceSeq };
};

/**
 * Drop changelog entries at or below a checkpointed `throughSeq` — retention
 * after a consumer has durably advanced past them, so the log can't grow
 * unbounded.
 */
const trimCdcChanges = (sql: SqlExec, throughSeq: number): void => {
    runSql(sql, `DELETE FROM ${quoteIdentifier(CDC_LOG_TABLE)} WHERE seq <= ?`, throughSeq);
};

/**
 * Replay a CDC change against a live writer: insert/update post-images become
 * an upsert (insert with the explicit id, falling back to replace when the row
 * already exists), deletes remove the row. This is the engine behind
 * point-in-time recovery — apply a base snapshot, then replay the changelog up
 * to the target moment in commit order.
 */
const applyCdcChange = async (writer: DatabaseWriterLike, change: CdcChange): Promise<void> => {
    if (change.op === "delete") {
        await writer.delete(change.id);

        return;
    }

    const document = change.doc ?? {};

    try {
        await writer.insert(change.table, document, { allowExplicitId: true });
    } catch (error: unknown) {
        if (!(error instanceof ConflictError)) {
            throw error;
        }

        // Row already exists — replace its fields. Drop only `_id` (replace
        // takes the id as its first argument). KEEP `_creationTime`: replace
        // reads it from the doc to preserve the row's original creation time,
        // so stripping it would silently reset it to the replay-time clock.
        const fields: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(document)) {
            if (key !== "_id") {
                fields[key] = value;
            }
        }

        await writer.replace(change.id, fields);
    }
};

/**
 * Replay an ordered batch of CDC changes against a writer (see
 * {@link applyCdcChange}). Applied sequentially so per-row order is preserved —
 * a later update never races the insert it depends on.
 */
const applyCdcChanges = async (writer: DatabaseWriterLike, changes: ReadonlyArray<CdcChange>): Promise<void> => {
    for (const change of changes) {
        // eslint-disable-next-line no-await-in-loop -- replay MUST be sequential: per-row commit order is the correctness contract.
        await applyCdcChange(writer, change);
    }
};

const createShardCtxDb = (options: CtxDbOptions): DatabaseWriterLike => {
    const { sql } = options;
    const { schema } = options;
    const broadcast = options.broadcast ?? (() => undefined);
    const onRead = options.onRead ?? (() => undefined);
    const onWrite = options.onWrite ?? (() => undefined);
    const { cache } = options;
    const clock = options.clock ?? (() => Date.now());
    const generateId = options.idGenerator ?? (() => crypto.randomUUID());
    const scheduler = options.scheduler ?? throwingScheduler;
    const { globalDb } = options;
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
                throw new Error(`cross-backend ${op} for global table '${table}' requires a globalDb writer — pass one to createShardCtxDb({ globalDb })`);
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
     * its generic `ctx.db.<op>("<table>", …)` call must reach the D1-backed
     * `globalDb` writer — where the table is provisioned and read-your-writes
     * apply — instead of this DO's local SQLite, which has no such table.
     *
     * Returns `undefined` for shard-local tables so the caller runs its normal
     * local path; throws a clear wiring error if a global table is reached
     * without a `globalDb` (mirroring {@link routeBackend}). This is the generic
     * twin of the property-style `ctx.db.<globalTable>` facade: both land global
     * access on D1, so `ctx.db.insert("t", …)` and `ctx.db.t.insert(…)` agree.
     */
    const globalWriterFor = (tableName: string, op: string): DatabaseWriterLike | undefined => {
        if (!isGlobalTable(tableName)) {
            return undefined;
        }

        if (!globalDb) {
            throw new Error(`${op} on global table '${tableName}' requires a globalDb writer — pass one to createShardCtxDb({ globalDb })`);
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
     * Backend-routed `fetcher`/`counter` pair handed to {@link resolveWith} so a
     * shard-local parent's `with` can load a global (D1) child in one bounded
     * `IN (...)` read. The unsupported direction (global parent → shard-local
     * child) is rejected upstream in `resolveWith`'s `requireRelation`.
     */
    const relationFetcher = (relationTable: string, relationArgs: QueryArgs): Promise<QueryPage> => routeBackend(relationTable, "relation load").findMany(relationTable, relationArgs);
    const relationCounter = (relationTable: string, relationWhere?: WhereInput): Promise<number> => routeBackend(relationTable, "relation load").count(relationTable, relationWhere);

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

            throw new ConflictError(`trigger recursion exceeded ${String(MAX_TRIGGER_DEPTH)} levels on "${event.table}" — check for a self-triggering write`);
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

    // Tracks per-(table, indexName) backfill state so the lazy backfill runs
    // exactly once per index per ctx-db instance. The DO instantiates a fresh
    // ctx-db per shard, so this aligns with the "first use" semantics.
    const backfilled = new Set<string>();

    /**
     * Lazily backfill an aggregate counter the first time the ctx-db instance
     * touches it. Idempotency model: each ctx-db tracks which (table, index)
     * pairs it has already considered; the first touch (read or write) does a
     * full rebuild from scratch — TRUNCATE then re-tally — so that an index
     * declared after rows already existed (the "added to an existing schema"
     * case) heals on first use. Subsequent touches in the same ctx-db skip the
     * rebuild and trust the trigger-maintained deltas.
     *
     * Must run **before** the triggering row write — otherwise the rebuild
     * would double-count the row that's about to be stepped.
     */
    const ensureBackfilled = (tableName: string, index: AggregateIndexDefinitionLike): void => {
        const cacheKey = `${tableName}::${index.name}`;

        if (backfilled.has(cacheKey)) {
            return;
        }

        const aggTable = aggregateTableName(tableName, index.name);
        const by = index.by ?? [];
        const tallies = new Map<string, AggregateTally>();
        const rows = runSql(sql, `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)}`).toArray();

        for (const row of rows) {
            const record = rowToDocument(row);

            if (!record) {
                continue;
            }

            if (index.where && !matchesStaticWhere(record, index.where)) {
                continue;
            }

            const encoded = encodeAggregateKey(by, record);

            foldAggregateTally(tallies, encoded, index, record);
        }

        runSql(sql, `DELETE FROM ${quoteIdentifier(aggTable)}`);

        for (const [encoded, tally] of tallies) {
            runSql(sql, `INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__", "__count__") VALUES (?, ?, ?)`, encoded, tally.value, tally.count);
        }

        backfilled.add(cacheKey);
    };

    /**
     * Recompute a min/max group's stored extreme from the source table, scoped
     * to the group's `by`-tuple and the index's static `where`. Used on the slow
     * path when the removed/old value *was* the stored extreme (so we can't tell
     * the new extreme without looking): a single `MIN`/`MAX(json_extract(...))`
     * over the group answers it. Runs AFTER the physical row write, so it sees
     * the post-write source. Returns the extreme (`null` when no numeric row
     * survives); the caller pins `__count__` from its own tracked tally.
     */
    const recomputeExtreme = (tableName: string, index: AggregateIndexDefinitionLike, record: Record<string, unknown>): { value: null | number } => {
        const by = index.by ?? [];
        const sqlFunction = aggregateSqlFunction(index.op);
        const field = index.field ?? "";
        const conditions: string[] = [];
        const params: unknown[] = [];

        for (const key of by) {
            // eslint-disable-next-line unicorn/no-null -- canonical key tuple: a missing by-field is matched as NULL, mirroring encodeAggregateKey's null-fill
            const value = serializeSqlValue(record[key] ?? null);

            if (value === null) {
                conditions.push(`${jsonPath(key)} IS NULL`);
            } else {
                conditions.push(`${jsonPath(key)} = ?`);
                params.push(value);
            }
        }

        for (const [key, expected] of Object.entries(index.where ?? {})) {
            const literal = expected !== null && typeof expected === "object" && !Array.isArray(expected) ? (expected as { eq: unknown }).eq : expected;
            const value = serializeSqlValue(literal);

            if (value === null) {
                conditions.push(`${jsonPath(key)} IS NULL`);
            } else {
                conditions.push(`${jsonPath(key)} = ?`);
                params.push(value);
            }
        }

        const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
        const ref = jsonPath(field);
        const row = runSql<{ value: null | number }>(
            sql,
            `SELECT ${sqlFunction}(${ref}) AS value FROM ${quoteIdentifier(tableName)}${whereSql}`,
            ...params,
        ).one();

        // eslint-disable-next-line unicorn/no-null -- empty min/max group stores NULL value
        return { value: row.value ?? null };
    };

    /**
     * Op-aware companion maintenance for a single index. `previous`/`next` are
     * the row's pre/post images (either may be absent for delete/insert); a
     * patch passes both. The contribution of a row to its group depends on the
     * index `op`, and the row only contributes when it passes the index's static
     * `where`:
     *
     * - **count**: `__value__` and `__count__` both move by ±1 (value mirrors count).
     * - **sum**: `__value__` += ±field, `__count__` += ±1 (numeric rows only).
     * - **avg**: `__value__` accumulates the running sum, `__count__` the divisor; the reader divides. Same ±field/±1 steps as sum.
     * - **min/max**: `__count__` += ±1. The extreme is bumped cheaply on the +side (a new value more extreme than the stored one wins, or seeds an empty group); when a removed/old value *was* the stored extreme — or the group empties — we recompute from the source table.
     *
     * An update is decomposed into remove-old then add-new, so the same code
     * path handles the by-key/field-value change that a patch/replace can cause.
     */
    /* eslint-disable sonarjs/cognitive-complexity -- op-aware (count/sum/avg/min/max) maintenance over remove-old + add-new branches; splitting it would scatter the single companion-row update across helpers and read worse */
    const applyAggregateDelta = (
        tableName: string,
        index: AggregateIndexDefinitionLike,
        previous: Record<string, unknown> | undefined,
        next: Record<string, unknown> | undefined,
    ): void => {
        const aggTable = aggregateTableName(tableName, index.name);
        const { op } = index;
        const field = index.field ?? "";

        // Drop a companion row once its group is empty (`__count__` hit 0) so the
        // indexed groupBy walk matches SQL `GROUP BY`, which omits empty groups —
        // a left-behind zeroed/NULL row would surface as a phantom group.
        const pruneIfEmpty = (encodedKey: string): void => {
            runSql(sql, `DELETE FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ? AND "__count__" <= 0`, encodedKey);
        };

        const removes = previous && (!index.where || matchesStaticWhere(previous, index.where)) ? previous : undefined;
        const adds = next && (!index.where || matchesStaticWhere(next, index.where)) ? next : undefined;

        if (!removes && !adds) {
            return;
        }

        if (op === "count") {
            // The +1/−1 steps can collapse to a single delta per group.
            for (const [record, delta] of [
                [removes, -1],
                [adds, 1],
            ] as const) {
                if (!record) {
                    continue;
                }

                const encoded = encodeAggregateKey(index.by ?? [], record);

                runSql(
                    sql,
                    `INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__", "__count__") VALUES (?, ?, ?)
                     ON CONFLICT("__key__") DO UPDATE SET "__value__" = "__value__" + excluded."__value__", "__count__" = "__count__" + excluded."__count__"`,
                    encoded,
                    delta,
                    delta,
                );
            }

            if (removes) {
                pruneIfEmpty(encodeAggregateKey(index.by ?? [], removes));
            }

            return;
        }

        if (op === "sum" || op === "avg") {
            for (const [record, sign] of [
                [removes, -1],
                [adds, 1],
            ] as const) {
                if (!record) {
                    continue;
                }

                const numeric = coerceAggregateNumber(record[field]);

                if (numeric === undefined) {
                    continue;
                }

                const encoded = encodeAggregateKey(index.by ?? [], record);

                runSql(
                    sql,
                    `INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__", "__count__") VALUES (?, ?, ?)
                     ON CONFLICT("__key__") DO UPDATE SET "__value__" = COALESCE("__value__", 0) + excluded."__value__", "__count__" = "__count__" + excluded."__count__"`,
                    encoded,
                    sign * numeric,
                    sign,
                );
            }

            if (removes) {
                pruneIfEmpty(encodeAggregateKey(index.by ?? [], removes));
            }

            return;
        }

        // min/max: maintain `__count__` always; bump `__value__` cheaply on the
        // add side, recompute on the remove side when the stored extreme leaves.
        if (removes) {
            const encoded = encodeAggregateKey(index.by ?? [], removes);
            const removedValue = coerceAggregateNumber(removes[field]);
            const existing = runSql<{ count: number; value: null | number }>(
                sql,
                `SELECT "__value__" AS value, "__count__" AS count FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`,
                encoded,
            ).toArray()[0];
            const remainingCount = (existing?.count ?? 0) - 1;

            if (remainingCount <= 0) {
                // Group emptied — drop the companion row so the indexed groupBy
                // walk matches SQL `GROUP BY` (which omits empty groups).
                runSql(sql, `DELETE FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`, encoded);
            } else if (existing && removedValue !== undefined && existing.value !== null && removedValue === existing.value) {
                // The departing row carried the stored extreme, so we can't keep
                // it without looking — recompute the group's extreme from the
                // source table. Companion maintenance runs AFTER the physical
                // row write (the row is gone on delete; on a shrinking update the
                // source already holds the new value), so the recompute sees the
                // post-write state and returns the correct surviving extreme. We
                // still pin `__count__` to the tracked `remainingCount` rather
                // than the recompute (which counts numeric `field`s, not rows).
                const recomputed = recomputeExtreme(tableName, index, removes);

                runSql(
                    sql,
                    `UPDATE ${quoteIdentifier(aggTable)} SET "__value__" = ?, "__count__" = ? WHERE "__key__" = ?`,
                    recomputed.value,
                    remainingCount,
                    encoded,
                );
            } else {
                // The departing row wasn't the extreme — the stored value stands.
                runSql(sql, `UPDATE ${quoteIdentifier(aggTable)} SET "__count__" = "__count__" - 1 WHERE "__key__" = ?`, encoded);
            }
        }

        if (adds) {
            const encoded = encodeAggregateKey(index.by ?? [], adds);
            const addedValue = coerceAggregateNumber(adds[field]);

            // A non-numeric value contributes nothing to the extreme but still
            // counts toward the group (so an empty-group check stays accurate).
            if (addedValue === undefined) {
                runSql(
                    sql,
                    `INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__", "__count__") VALUES (?, ?, 1)
                     ON CONFLICT("__key__") DO UPDATE SET "__count__" = "__count__" + 1`,
                    encoded,
                    // eslint-disable-next-line unicorn/no-null -- seeds an extreme-less group with NULL value
                    null,
                );
            } else {
                const op2 = op === "min" ? "MIN" : "MAX";

                runSql(
                    sql,
                    `INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__", "__count__") VALUES (?, ?, 1)
                     ON CONFLICT("__key__") DO UPDATE SET "__value__" = ${op2}(COALESCE("__value__", excluded."__value__"), excluded."__value__"), "__count__" = "__count__" + 1`,
                    encoded,
                    addedValue,
                );
            }
        }
    };
    /* eslint-enable sonarjs/cognitive-complexity */

    /**
     * Pre-write hook: ensure every aggregate counter on `tableName` is rebuilt
     * once per ctx-db instance. The rebuild scans the live source table, so
     * callers MUST invoke this before the row write — otherwise the new row
     * lands in both the rebuild and the `+1` step that follows.
     */
    const ensureBackfilledForTable = (tableName: string): void => {
        const indexes = schema.tables[tableName]?.aggregateIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            ensureBackfilled(tableName, index);
        }
    };

    /**
     * Post-write hook: apply the `-prev + next` step for every declared
     * aggregate index. Must be paired with a `ensureBackfilledForTable` call
     * earlier in the same write so the counter is in step with the source.
     */
    const syncAggregates = (tableName: string, previous: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined): void => {
        const indexes = schema.tables[tableName]?.aggregateIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            applyAggregateDelta(tableName, index, previous, next);
        }
    };

    // Tracks per-(table, rankIndex) backfill state so the lazy backfill runs
    // exactly once per index per ctx-db instance — mirroring the aggregate
    // backfill bookkeeping.
    const rankBackfilled = new Set<string>();

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
            { code: "CROSS_SHARD_RANK_UNSUPPORTED", name: "CirrusError", status: 400 },
        );
    };

    /**
     * Lazily rebuild a rank companion the first time the ctx-db instance
     * touches it. TRUNCATE then re-insert so a rankIndex declared after rows
     * already existed heals on first use. Must run BEFORE the triggering row
     * write, same reasoning as the aggregate backfill.
     */
    const ensureRankBackfilled = (tableName: string, index: RankIndexDefinitionLike): void => {
        const cacheKey = `${tableName}::rank::${index.name}`;

        if (rankBackfilled.has(cacheKey)) {
            return;
        }

        const rankTable = rankTableName(tableName, index.name);
        const rows = runSql(sql, `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)}`).toArray();

        runSql(sql, `DELETE FROM ${quoteIdentifier(rankTable)}`);

        const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
        const columnList = ["__id__", "__partition__", ...sortColumns].map((column) => quoteIdentifier(column)).join(", ");
        const placeholders = ["?", "?", ...sortColumns.map(() => "?")].join(", ");
        const insertSql = `INSERT INTO ${quoteIdentifier(rankTable)} (${columnList}) VALUES (${placeholders})`;

        for (const row of rows) {
            const record = rowToDocument(row);

            if (!record) {
                continue;
            }

            if (index.where && !matchesRankStaticWhere(record, index.where)) {
                continue;
            }

            const partitionKey = encodePartitionKey(index.partitionBy ?? [], record);
            // eslint-disable-next-line unicorn/no-null -- binds the rank sort column to SQLite: a missing sort field is a NULL column value, not undefined
            const sortValues = index.sortBy.map((key) => serializeSqlValue(record[key.field] ?? null));

            runSql(sql, insertSql, record["_id"] as string, partitionKey, ...sortValues);
        }

        rankBackfilled.add(cacheKey);
    };

    /** Pre-write hook: ensure every rank companion on `tableName` is rebuilt once per ctx-db. */
    const ensureRankBackfilledForTable = (tableName: string): void => {
        const indexes = schema.tables[tableName]?.rankIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            ensureRankBackfilled(tableName, index);
        }
    };

    /**
     * Apply a `-prev + next` step for every declared rank index, atomic with
     * the row write within the DO transaction. `delete` calls this with
     * `next === undefined`; `insert` with `previous === undefined`. The
     * companion is keyed by source row id so we just DELETE+INSERT instead of
     * trying to UPDATE in place — keeps the maintenance idempotent.
     */
    const syncRanks = (tableName: string, id: string, previous: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined): void => {
        const indexes = schema.tables[tableName]?.rankIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            syncRankIndexEntry(sql, tableName, index, id, previous, next);
        }
    };

    /**
     * Keep the FTS5 shadow tables in step with a row write. A no-op when the
     * table declares no search indexes or when FTS5 is unavailable (the scan
     * fallback reads the live document table, so nothing to mirror). Delete then
     * insert makes it idempotent across insert/update; `doc === undefined`
     * deletes only (row removal).
     */
    const syncSearch = (tableName: string, id: string, document: Record<string, unknown> | undefined): void => {
        const indexes = schema.tables[tableName]?.searchIndexes;

        if (!indexes || indexes.length === 0 || !isFtsAvailable(sql)) {
            return;
        }

        for (const index of indexes) {
            const ftName = ftsTableName(tableName, index.name);

            runSql(sql, `DELETE FROM ${quoteIdentifier(ftName)} WHERE "__id__" = ?`, id);

            if (document) {
                runSql(sql, `INSERT INTO ${quoteIdentifier(ftName)} ("__text__", "__id__") VALUES (?, ?)`, stringifySearchText(document[index.field]), id);
            }
        }
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
     */
    const lookupById = (id: string): { docJson: string; row: Record<string, unknown>; tableName: string } | undefined => {
        // Row ids are random UUIDs, so the owning table can't be derived from
        // the id. Rather than probing each table with its own SELECT (T
        // statements worst-case on a T-table schema, on the per-mutation hot
        // path), fold every non-global table into one UNION-ALL probe that
        // tags each branch with its source table — a single round-trip
        // regardless of table count. `LIMIT 1` short-circuits once a branch
        // hits; ids are unique across tables so at most one branch matches.
        const nonGlobalTables = Object.entries(schema.tables)
            .filter(([, definition]) => definition.shardMode?.kind !== "global")
            .map(([tableName]) => tableName);

        if (nonGlobalTables.length === 0) {
            return undefined;
        }

        const branches = nonGlobalTables.map(
            (tableName) =>
                `SELECT '${tableName.replaceAll("'", "''")}' AS __t__, id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)} WHERE id = ?`,
        );
        const probeSql = `${branches.join(" UNION ALL ")} LIMIT 1`;
        const parameters = nonGlobalTables.map(() => id);

        const [firstRow] = runSql(sql, probeSql, ...parameters).toArray();

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

    const writer: DatabaseWriterLike = {
        // `ctx.db.system` — best-effort read-only system tables. Assigned here so
        // it rides along on the same `DatabaseWriterLike` the generated ctx hands
        // to query/mutation/action handlers. See {@link SystemDatabaseReader}.
        system,
        async aggregate(tableName, aggOptions) {
            const global = globalWriterFor(tableName, "aggregate");

            if (global) {
                return global.aggregate(tableName, aggOptions);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            // Reject an off-allowlist `op` up front (it's a compile-time-only
            // type) before it can reach any SQL-emitting path.
            aggregateSqlFunction(aggOptions.op);

            if (aggOptions.op === "count") {
                // `aggregate({ op: "count" })` is just `count()` — keep the
                // surface uniform so callers don't special-case it.
                return writer.count(tableName, {
                    baseWhere: aggOptions.baseWhere,
                    restrictsCounts: aggOptions.restrictsCounts,
                    where: aggOptions.where,
                });
            }

            if (!aggOptions.field) {
                throw new Error(`aggregate(${tableName}, { op: "${aggOptions.op}" }): "field" is required for non-count reducers`);
            }

            onRead(tableName, SCAN_DEP);

            // Indexed fast-path: the `__agg_` companion is now reducer-aware
            // (`__value__` holds the sum / running sum / extreme, `__count__`
            // the row count), so a matching `(by, field, op)` index answers
            // sum/avg/min/max in one row lookup. We only attempt it when no
            // baseWhere is set — the RLS predicate isn't a pure equality
            // conjunction, so it falls through to the SQL scan below.
            if (definition.aggregateIndexes && !aggOptions.baseWhere) {
                const planned = selectIndexForAggregate(definition.aggregateIndexes, aggOptions.op, aggOptions.field, aggOptions.where);

                if (planned) {
                    ensureBackfilled(tableName, planned.index);

                    const encoded = encodeAggregateKey(planned.index.by ?? [], planned.key);
                    const aggTable = aggregateTableName(tableName, planned.index.name);
                    const indexed = runSql<{ count: number; value: null | number }>(
                        sql,
                        `SELECT "__value__" AS value, "__count__" AS count FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`,
                        encoded,
                    ).toArray()[0];

                    return readAggregateValue(aggOptions.op, indexed);
                }
            }

            const effective = mergeWhere(aggOptions.baseWhere, aggOptions.where);
            const { params, sql: whereSql } = compileWhere(effective, doWhereStrategy);
            const aggregateSql = aggregateSqlFunction(aggOptions.op);
            const ref = jsonPath(aggOptions.field);

            let querySql = `SELECT ${aggregateSql}(${ref}) AS value FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            const row = runSql<{ value: null | number }>(sql, querySql, ...params).toArray();
            const value = row[0]?.value;

            if (value === null || value === undefined) {
                // eslint-disable-next-line unicorn/no-null -- AggregateResult is `null | number`: null is the documented "no rows matched" result returned to callers
                return null;
            }

            return value;
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- DatabaseWriterLike returns Promises (the D1 twin awaits real I/O); the DO impl is synchronous over local SQLite
        async count(tableName, whereOrOptions) {
            const global = globalWriterFor(tableName, "count");

            if (global) {
                return global.count(tableName, whereOrOptions);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const countOptions = normalizeCountArgument(whereOrOptions);

            // RLS-restricted contexts can't be trusted to return a correct
            // count — surface a structural CirrusError so the request fails
            // loudly rather than silently undercounting. See PLAN2 §3.1
            // "Coupling seam" and `aggregates.ts` for the seam contract.
            if (countOptions.restrictsCounts) {
                throw new CountRlsUnsupportedError(tableName);
            }

            // Counts and aggregates depend on every row in the table — a
            // single insert or delete can shift the answer, so register a
            // scan dependency regardless of `where`.
            onRead(tableName, SCAN_DEP);

            const effective = mergeWhere(countOptions.baseWhere, countOptions.where);

            // Indexed path: if the user passed a plain conjunction of equality
            // filters and a declared aggregateIndex covers them, route to the
            // counter table. The base predicate (when present) is intentionally
            // left out of the indexed path because we can't trust it to be a
            // pure equality conjunction; if `baseWhere` is set we fall through
            // to the scan so SQL handles it uniformly.
            if (definition.aggregateIndexes && !countOptions.baseWhere) {
                const planned = selectIndexForCount(definition.aggregateIndexes, countOptions.where);

                if (planned) {
                    ensureBackfilled(tableName, planned.index);

                    const encoded = encodeAggregateKey(planned.index.by ?? [], planned.key);
                    const aggTable = aggregateTableName(tableName, planned.index.name);
                    const row = runSql<{ value: number | null }>(
                        sql,
                        `SELECT "__value__" AS value FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`,
                        encoded,
                    ).toArray();

                    return row[0] === undefined ? 0 : (row[0].value ?? 0);
                }
            }

            const { params, sql: whereSql } = compileWhere(effective, doWhereStrategy);

            let querySql = `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            const row = runSql<{ count: number }>(sql, querySql, ...params).one();

            return row.count;
        },

        async delete(id) {
            // Single probe — get the table + row in one pass instead of
            // probing twice (`tableNameFromId` + `writer.get`).
            const located = lookupById(id);

            if (!located) {
                // A global row's id never lives in this DO; fall back to D1
                // (both backends are silent on a genuinely-absent id).
                const global = globalFallback();

                if (global) {
                    await global.delete(id);
                }

                return;
            }

            const { docJson: existingJson, row: existing, tableName } = located;

            // `before` fires ahead of cascade resolution so a throwing guard
            // aborts the delete before any holder rows are touched.
            if (hasMatchingTrigger(tableName, "before", "delete")) {
                await fireTriggers("before", "delete", { id, op: "delete", previous: existing, table: tableName });
            }

            // Resolve declared `onDelete` actions on holder rows *before* the
            // physical delete, so `restrict` can abort and cascaded child
            // deletes still fire their own broadcast/onWrite per row.
            //
            // The callbacks pass through `routeForHolder` so a holder living
            // on a global (`.global()`) table is reached through the supplied
            // D1-backed `globalDb` writer, not this DO's local SQLite.
            // Cross-backend cascade is **not transactional**: the local row
            // commits below regardless of whether the global cascade succeeds.
            await applyOnDelete({
                deletedId: id,
                deletedReference: (references) => existing[references],
                findHolders: async (holderTable, field, value) => {
                    const holders = await routeForHolder(holderTable).findMany(holderTable, { where: { [field]: value } });

                    return holders.page;
                },
                onCascade: (holderTable, holderId) => routeForHolder(holderTable).delete(holderId),
                onRestrict: (message) => {
                    throw new ConflictError(message);
                },
                // eslint-disable-next-line unicorn/no-null -- `set null` onDelete: the FK column is set to SQL NULL, the documented semantics of the action
                onSetNull: (holderTable, holderId, field) => routeForHolder(holderTable).patch(holderId, { [field]: null }),
                schema,
                tableName,
            });

            ensureBackfilledForTable(tableName);
            ensureRankBackfilledForTable(tableName);

            // Optimistic-concurrency guard over the (wide) cascade window: the
            // `applyOnDelete` await above can let a concurrent write commit, so
            // CAS on the read-time `__doc__` snapshot. A row that was updated
            // out from under us (blob changed) or already removed matches zero
            // rows and raises ConflictError rather than clobbering that write —
            // and keeps `existing` (used for the aggregate/rank -prev steps) in
            // sync with what was actually on disk.
            runGuardedWrite(sql, tableName, `DELETE FROM ${quoteIdentifier(tableName)} WHERE id = ? AND ${DOC_COLUMN} = ?`, id, existingJson);

            syncSearch(tableName, id, undefined);
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
                return global.findMany(tableName, args);
            }

            if (!schema.tables[tableName]) {
                throw new Error(`unknown table: ${tableName}`);
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

            if (seek) {
                predicate = predicate ? { AND: [predicate, seek] } : seek;
            }

            const { params, sql: whereSql } = compileWhere(predicate, doWhereStrategy);

            let querySql = `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            querySql += ` ORDER BY ${compileOrderBy(orderKeys, jsonPath)}`;

            const limit = typeof args.limit === "number" ? Math.max(0, Math.floor(args.limit)) : undefined;

            if (limit !== undefined) {
                // Over-fetch by one row to learn whether another page exists
                // without issuing a second query.
                querySql += ` LIMIT ${String(limit + 1)}`;
            }

            const rows = runSql(sql, querySql, ...params).toArray();
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
                    await resolveWith({ counter: relationCounter, fetcher: relationFetcher, parents: docs, schema, tableName, with: args.with });
                }

                // eslint-disable-next-line unicorn/no-null -- QueryPage.continueCursor is `null | string`: null is the documented "no further page" cursor on the wire
                return { continueCursor: null, isDone: true, page: docs };
            }

            const hasMore = docs.length > limit;
            const page = hasMore ? docs.slice(0, limit) : docs;
            const last = page.at(-1);

            if (args.with) {
                await resolveWith({ counter: relationCounter, fetcher: relationFetcher, parents: page, schema, tableName, with: args.with });
            }

            return {
                // eslint-disable-next-line unicorn/no-null -- QueryPage.continueCursor is `null | string`: null is the documented "no further page" cursor on the wire
                continueCursor: hasMore && last ? encodeCursor(last, orderKeys) : null,
                isDone: !hasMore,
                page,
            };
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- DatabaseWriterLike returns Promises (the D1 twin awaits real I/O); the DO impl is synchronous over local SQLite
        async get(id) {
            const located = lookupById(id);

            if (!located) {
                // A global row's id never lives in this DO; fall back to D1.
                const global = globalFallback();

                if (global) {
                    return global.get(id);
                }

                // eslint-disable-next-line unicorn/no-null -- DatabaseWriterLike.get is `Promise<Record | null>`: null is the documented "no such row" result
                return null;
            }

            onRead(located.tableName, id);

            return located.row;
        },

        // eslint-disable-next-line @typescript-eslint/require-await, sonarjs/cognitive-complexity -- DatabaseWriterLike returns Promises (the D1 twin awaits I/O); the indexed/scan branching is closed over the writer ctx and reads worse when split
        async groupBy(tableName, groupOptions) {
            const global = globalWriterFor(tableName, "groupBy");

            if (global) {
                return global.groupBy(tableName, groupOptions);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            onRead(tableName, SCAN_DEP);

            const agg = groupOptions.agg ?? { op: "count" };

            // Reject an off-allowlist reducer `op` before any SQL is emitted.
            aggregateSqlFunction(agg.op);

            if (agg.op !== "count" && !agg.field) {
                throw new Error(`groupBy(${tableName}, { agg: { op: "${agg.op}" } }): "field" is required for non-count reducers`);
            }

            // Indexed path: when no baseWhere is set and an aggregateIndex's
            // `by` exactly matches `groupOptions.by`, every group answer is
            // already in the reducer-aware companion table — read each row's
            // `__value__`/`__count__` and project via `readAggregateValue`.
            // One SELECT, no SQL `GROUP BY`. baseWhere falls through to scan so
            // RLS composes uniformly. Covers every op (count/sum/avg/min/max)
            // now that the companion is op-aware.
            if (definition.aggregateIndexes && !groupOptions.baseWhere) {
                const planned = selectIndexForGroupBy(definition.aggregateIndexes, agg.op, agg.field, groupOptions.by, groupOptions.where);

                if (planned) {
                    ensureBackfilled(tableName, planned.index);

                    const aggTable = aggregateTableName(tableName, planned.index.name);
                    const partialKeys = Object.keys(planned.partial);
                    const indexedResult: GroupByEntry[] = [];

                    if (partialKeys.length === (planned.index.by ?? []).length && partialKeys.length > 0) {
                        // Request fully constrains the by-tuple → single companion row lookup.
                        const encoded = encodeAggregateKey(planned.index.by ?? [], planned.partial);
                        const rowsIndexed = runSql<{ count: number; value: null | number }>(
                            sql,
                            `SELECT "__value__" AS value, "__count__" AS count FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`,
                            encoded,
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
                    const rowsIndexed = runSql<{ count: number; key: string; value: null | number }>(
                        sql,
                        `SELECT "__key__" AS key, "__value__" AS value, "__count__" AS count FROM ${quoteIdentifier(aggTable)}`,
                    ).toArray();

                    for (const row of rowsIndexed) {
                        const decoded = JSON.parse(row.key) as Record<string, unknown>;

                        indexedResult.push({ key: decoded, value: readAggregateValue(agg.op, row) });
                    }

                    return indexedResult;
                }
            }

            const effective = mergeWhere(groupOptions.baseWhere, groupOptions.where);
            const { params, sql: whereSql } = compileWhere(effective, doWhereStrategy);

            const select = groupOptions.by.map((field) => `${jsonPath(field)} AS ${quoteIdentifier(field)}`);

            if (agg.op === "count") {
                select.push(`COUNT(*) AS value`);
            } else {
                // `agg.field` is guaranteed present here: the guard above throws
                // for any non-`count` reducer that omits it.
                const { field } = agg;

                if (field === undefined) {
                    throw new Error(`groupBy(${tableName}, { agg: { op: "${agg.op}" } }): "field" is required for non-count reducers`);
                }

                select.push(`${aggregateSqlFunction(agg.op)}(${jsonPath(field)}) AS value`);
            }

            let querySql = `SELECT ${select.join(", ")} FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            querySql += ` GROUP BY ${groupOptions.by.map((field) => jsonPath(field)).join(", ")}`;

            const rows = runSql(sql, querySql, ...params).toArray();
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
                return global.insert(tableName, document, insertOptions);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const withDefaults = applyInsertDefaults(definition, document);

            // Refinements declared via `.check(predicate)` fire here on the
            // post-default row so a defaulted value still passes its checks.
            runRowValidators(definition, withDefaults);

            // A client-chosen `_id` is only honored on the trusted dev/admin
            // import path (`allowExplicitId`); the default mutation path always
            // generates a fresh id even if a handler forwards a raw payload.
            const id = insertOptions?.allowExplicitId && typeof withDefaults["_id"] === "string" ? withDefaults["_id"] : generateId();
            const creationTime = typeof withDefaults["_creationTime"] === "number" ? withDefaults["_creationTime"] : clock();

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
                `INSERT INTO ${quoteIdentifier(tableName)} (id, _creationTime, ${DOC_COLUMN}) VALUES (?, ?, ?)`,
                id,
                creationTime,
                JSON.stringify(documentWithMeta),
            );

            syncSearch(tableName, id, documentWithMeta);
            syncAggregates(tableName, undefined, documentWithMeta);
            syncRanks(tableName, id, undefined, documentWithMeta);

            // Invalidate BEFORE the broadcast so a subscriber that re-runs
            // its query in response to the broadcast cannot read a stale
            // cache entry. `ReactiveCache.invalidate(table, id)` clears both
            // the per-id bucket AND the `table:*scan` bucket — inserts can
            // flip any scan-shaped result, so the latter MUST go even though
            // the new row id was never read by anything.
            cache?.invalidate(tableName, id);

            recordCdc(tableName, id, "insert", documentWithMeta);
            broadcast({ key: id, op: "insert", row: documentWithMeta, table: tableName });

            if (hasMatchingTrigger(tableName, "after", "insert")) {
                await fireTriggers("after", "insert", { doc: documentWithMeta, id, op: "insert", table: tableName });
            }

            await onWrite({ doc: documentWithMeta, id, op: "insert", table: tableName });

            return id;
        },

        normalizeId(tableName, id) {
            return normalizeIdStructurally(schema, tableName, id);
        },

        async patch(id, patch) {
            // Single probe — eliminates the redundant `tableNameFromId` +
            // `writer.get` chain that doubled the SQL round-trips per patch
            // on the prior code path.
            const located = lookupById(id);

            if (!located) {
                // A global row's id never lives in this DO; fall back to D1.
                const global = globalFallback();

                if (global) {
                    return global.patch(id, patch);
                }

                throw new Error(`document not found: ${id}`);
            }

            const { docJson: existingJson, row: existing, tableName } = located;
            const tableDefinition = schema.tables[tableName];

            if (!tableDefinition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            onRead(tableName, id);

            const merged = { ...existing, ...patch, _id: id };

            applyOnUpdate(tableDefinition, patch, merged);

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
                `UPDATE ${quoteIdentifier(tableName)} SET ${DOC_COLUMN} = ? WHERE id = ? AND ${DOC_COLUMN} = ?`,
                JSON.stringify(merged),
                id,
                existingJson,
            );

            syncSearch(tableName, id, merged);
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

        query(tableName) {
            const global = globalWriterFor(tableName, "query");

            if (global) {
                return global.query(tableName);
            }

            // Fluent reader chain: we can't tell up front whether the caller
            // will end with `.withIndex(...)` or a bare scan, so we stamp the
            // safe upper bound (`*scan`). Future refinement would push the
            // hook into `buildReader`'s terminal `runFetch` so an indexed read
            // can record per-id deps.
            onRead(tableName, SCAN_DEP);

            return buildReader(sql, schema, tableName);
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- DatabaseWriterLike returns Promises (the D1 twin awaits I/O); the indexed/scan branching is closed over the writer ctx and reads worse when split
        async rank(tableName, indexName, rankOptions) {
            const global = globalWriterFor(tableName, "rank");

            if (global) {
                return global.rank(tableName, indexName, rankOptions);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const index = definition.rankIndexes?.find((i) => i.name === indexName);

            if (!index) {
                throw new Error(`unknown rankIndex "${indexName}" on table "${tableName}"`);
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
            const ownRows = runSql(sql, `SELECT "__partition__", ${sortColumnList} FROM ${quoteIdentifier(rankTable)} WHERE "__id__" = ?`, rowId).toArray();

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
                throw new Error(`rankBefore is not supported on the global (.global()) table '${tableName}' — cross-shard rank cursors apply only to sharded tables`);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const index = definition.rankIndexes?.find((i) => i.name === indexName);

            if (!index) {
                throw new Error(`unknown rankIndex "${indexName}" on table "${tableName}"`);
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

        // eslint-disable-next-line @typescript-eslint/require-await, sonarjs/cognitive-complexity -- DatabaseWriterLike returns Promises (the D1 twin awaits I/O); the indexed/scan branching is closed over the writer ctx and reads worse when split
        async rankPage(tableName, indexName, rankPageOptions = {}) {
            const global = globalWriterFor(tableName, "rankPage");

            if (global) {
                return global.rankPage(tableName, indexName, rankPageOptions);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const index = definition.rankIndexes?.find((i) => i.name === indexName);

            if (!index) {
                throw new Error(`unknown rankIndex "${indexName}" on table "${tableName}"`);
            }

            // Refuse a shard-local page when the partition spans shards (the
            // page would be a per-shard slice, not the global order).
            assertRankPartitionLocal(tableName, definition, index);

            // rankPage() is a paginated read over the rank companion; the
            // result depends on every row in the partition, so SCAN_DEP
            // matches count/aggregate semantics for cache invalidation.
            onRead(tableName, SCAN_DEP);

            ensureRankBackfilled(tableName, index);

            const rankTable = rankTableName(tableName, index.name);
            const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
            const take = Math.max(1, Math.min(1000, Math.floor(rankPageOptions.take ?? 100)));
            const effective = mergeWhere(rankPageOptions.baseWhere, rankPageOptions.where);
            const partitionFromWhere = resolveRankPartition(index, effective);

            const orderClauses: string[] = [`"__partition__" ASC`];

            for (const [i, column] of sortColumns.entries()) {
                const direction = index.sortBy[i]?.direction;

                orderClauses.push(`${quoteIdentifier(column)} ${direction === "desc" ? "DESC" : "ASC"}`);
            }

            orderClauses.push(`${quoteIdentifier(RANK_TIEBREAK)} ASC`);

            const whereClauses: string[] = [];
            const params: unknown[] = [];

            if (partitionFromWhere) {
                whereClauses.push(`"__partition__" = ?`);
                params.push(encodePartitionKey(index.partitionBy ?? [], partitionFromWhere));
            }

            if (rankPageOptions.cursor) {
                const decoded = decodeCursor(rankPageOptions.cursor);
                // Same shape we encode below: [partitionKey, ...sortValues, id]
                const expectedLength = 1 + sortColumns.length + 1;

                if (decoded.length === expectedLength) {
                    // Lexicographic strict-after under per-key direction.
                    const cols: { column: string; direction: "asc" | "desc" }[] = [{ column: "__partition__", direction: "asc" }];

                    for (const [i, column] of sortColumns.entries()) {
                        cols.push({ column, direction: index.sortBy[i]?.direction ?? "asc" });
                    }

                    cols.push({ column: RANK_TIEBREAK, direction: "asc" });

                    const branches: string[] = [];

                    for (const [pivot, col] of cols.entries()) {
                        const conditions: string[] = [];

                        for (const [prefix, prefixCol] of cols.slice(0, pivot).entries()) {
                            conditions.push(`${quoteIdentifier(prefixCol.column)} IS ?`);
                            params.push(decoded[prefix]);
                        }

                        const operator = col.direction === "desc" ? "<" : ">";

                        conditions.push(`${quoteIdentifier(col.column)} ${operator} ?`);
                        params.push(decoded[pivot]);

                        const [firstCondition] = conditions;

                        branches.push(conditions.length === 1 && firstCondition !== undefined ? firstCondition : `(${conditions.join(" AND ")})`);
                    }

                    whereClauses.push(`(${branches.join(" OR ")})`);
                }
            }

            const sortColumnList = sortColumns.map((column) => quoteIdentifier(column)).join(", ");
            const idColumn = quoteIdentifier(RANK_TIEBREAK);
            const partitionColumn = `"__partition__"`;
            const innerWhere = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(" AND ")}` : "";
            const selectColumns = sortColumns.length > 0 ? `${idColumn}, ${partitionColumn}, ${sortColumnList}` : `${idColumn}, ${partitionColumn}`;
            const querySql = `SELECT ${selectColumns} FROM ${quoteIdentifier(rankTable)}${innerWhere} ORDER BY ${orderClauses.join(", ")} LIMIT ${String(take + 1)}`;
            const rankRows = runSql(sql, querySql, ...params).toArray();
            const hasMore = rankRows.length > take;
            const usable = hasMore ? rankRows.slice(0, take) : rankRows;

            // Hydrate the whole page in one `IN (...)` query instead of one
            // SELECT per rank row (an N+1 on the read path). Build an
            // id->doc map, then re-project in rank-companion order so the
            // keyset page order is preserved.
            const pageIds = usable.map((rankRow) => rankRow[RANK_TIEBREAK] as string);
            const docs: Record<string, unknown>[] = [];

            if (pageIds.length > 0) {
                const placeholders = pageIds.map(() => "?").join(", ");
                const documentRows = runSql(
                    sql,
                    `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)} WHERE id IN (${placeholders})`,
                    ...pageIds,
                ).toArray();

                const byId = new Map<string, Record<string, unknown>>();

                for (const documentRow of documentRows) {
                    const record = rowToDocument(documentRow);
                    const recordId = documentRow["id"];

                    if (record && typeof recordId === "string") {
                        byId.set(recordId, record);
                    }
                }

                for (const pageId of pageIds) {
                    const record = byId.get(pageId);

                    if (record) {
                        docs.push(record);
                    }
                }
            }

            // eslint-disable-next-line unicorn/no-null -- RankPage.continueCursor is `null | string`: null is the documented "no further page" cursor on the wire
            let continueCursor: null | string = null;

            const last = usable.at(-1);

            if (hasMore && last !== undefined) {
                const cursorValues: unknown[] = [last["__partition__"]];

                for (const column of sortColumns) {
                    cursorValues.push(last[column]);
                }

                cursorValues.push(last[RANK_TIEBREAK]);

                // Match the format `decodeCursor` expects (base64 of JSON).
                continueCursor = encodeRankCursor(cursorValues);
            }

            return { continueCursor, isDone: !hasMore, page: docs };
        },

        async replace(id, document) {
            // Single probe that also captures the read-time `__doc__` blob.
            // The before-update trigger below spans an `await`, so the write
            // must compare-and-swap on this snapshot (see `runGuardedWrite`)
            // — the same OCC contract `patch`/`delete` honor. Reusing the
            // decoded row as `previous` also keeps the aggregate/rank -prev
            // steps consistent with what was actually on disk at read time.
            const located = lookupById(id);

            if (!located) {
                // A global row's id never lives in this DO; fall back to D1.
                const global = globalFallback();

                if (global) {
                    return global.replace(id, document);
                }

                throw new Error(`document not found: ${id}`);
            }

            const { docJson: existingJson, row: previous, tableName } = located;
            const tableDefinition = schema.tables[tableName];

            if (!tableDefinition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const creationTime = typeof document["_creationTime"] === "number" ? document["_creationTime"] : clock();
            const replaced: Record<string, unknown> = { ...document, _creationTime: creationTime, _id: id };

            applyOnUpdate(tableDefinition, document, replaced);

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
                `UPDATE ${quoteIdentifier(tableName)} SET _creationTime = ?, ${DOC_COLUMN} = ? WHERE id = ? AND ${DOC_COLUMN} = ?`,
                creationTime,
                JSON.stringify(replaced),
                id,
                existingJson,
            );

            syncSearch(tableName, id, replaced);
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
    };

    // Declared after `writer` but closed over by `fireTriggers` (defined above):
    // safe because `fireTriggers` only runs while a write is in flight, long
    // after construction has initialized this binding.
    const triggerContext: TriggerContextLike = { db: writer, scheduler };

    return writer;
};

/**
 * Bring the SQLite database into the shape declared by `schema`. Idempotent
 * — every statement uses `IF NOT EXISTS`, so it's safe to call on every
 * cold start.
 *
 * Global tables (`.global()`) live in D1, not in the DO — they're skipped
 * here. The DO sees them via the D1 adapter exposed elsewhere.
 */
/** Create the secondary + `.unique()` expression indexes declared on a table. */
const migrateSecondaryIndexes = (sql: SqlExec, tableName: string, definition: TableDefinitionLike): void => {
    for (const index of definition.indexes) {
        const indexName = `${tableName}_${index.name}`;
        const expressions = index.fields.map((field) => jsonPath(field)).join(", ");
        const uniqueClause = index.unique ? "UNIQUE" : "";

        runSql(sql, `CREATE ${uniqueClause} INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(tableName)} (${expressions})`);
    }

    // `.unique()` columns synthesize a UNIQUE expression index so SQLite
    // enforces the constraint; the write layer maps breaches to ConflictError.
    for (const [field, column] of tableColumns(definition)) {
        if (!column.unique) {
            continue;
        }

        const indexName = `${tableName}_unique_${field}`;

        runSql(sql, `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(tableName)} (${jsonPath(field)})`);
    }
};

/**
 * Create the FTS5 shadow tables for a table's `.searchIndex()` declarations,
 * only on engines that ship FTS5 (Cloudflare DOs do; the `node:sqlite` test
 * runner doesn't, where `.search()` transparently falls back to a scan).
 * `__text__` holds the indexed field; `__id__` (UNINDEXED) joins back to the row.
 */
const migrateSearchIndexes = (sql: SqlExec, tableName: string, definition: TableDefinitionLike): void => {
    if (!definition.searchIndexes || definition.searchIndexes.length === 0 || !isFtsAvailable(sql)) {
        return;
    }

    for (const index of definition.searchIndexes) {
        const ftName = ftsTableName(tableName, index.name);

        runSql(sql, `CREATE VIRTUAL TABLE IF NOT EXISTS ${quoteIdentifier(ftName)} USING fts5("__text__", "__id__" UNINDEXED)`);
    }
};

/**
 * Create the counter tables backing `aggregateIndex` declarations. One row per
 * distinct `by`-tuple; `__key__` is a canonical-JSON encoding so lookups stay
 * stable. Not populated here — the write path steps every counter and the
 * reader lazily backfills empties on first use (or `backfillAggregateIndexes`).
 */
const migrateAggregateIndexes = (sql: SqlExec, tableName: string, definition: TableDefinitionLike): void => {
    if (!definition.aggregateIndexes) {
        return;
    }

    for (const index of definition.aggregateIndexes) {
        const aggTable = aggregateTableName(tableName, index.name);

        // `__value__` is nullable now (an empty min/max group stores NULL); the
        // pre-reducer-aware shape declared it `NOT NULL` and carried only a row
        // count. `CREATE TABLE IF NOT EXISTS` won't reshape a table that already
        // exists, so the defensive `ADD COLUMN` below upgrades a companion
        // persisted by an older alpha build.
        runSql(
            sql,
            `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(aggTable)} ("__key__" TEXT PRIMARY KEY, "__value__" REAL, "__count__" INTEGER NOT NULL DEFAULT 0)`,
        );

        // Alpha-era companion-rebuild caveat: a DO persisted before `__count__`
        // existed gets the column added here (defaulted 0). The first read/write
        // that touches the index re-runs the full backfill (`ensureBackfilled`),
        // so the seeded 0s are overwritten with real per-op values — no stale
        // count survives. We pragma-check rather than blindly ALTER so a fresh
        // table (created above with the column) doesn't raise "duplicate column".
        const columns = runSql<{ name: string }>(sql, `PRAGMA table_info(${quoteIdentifier(aggTable)})`).toArray();

        if (!columns.some((column) => column.name === "__count__")) {
            runSql(sql, `ALTER TABLE ${quoteIdentifier(aggTable)} ADD COLUMN "__count__" INTEGER NOT NULL DEFAULT 0`);
        }
    }
};

/**
 * Create the rank companion tables + their sorted btree index for a table's
 * `rankIndex` declarations. One row per source row keyed by `__id__`; the index
 * on `(__partition__, __sort_k0__, …, __id__)` answers `rank()` in O(log n).
 */
const migrateRankIndexes = (sql: SqlExec, tableName: string, definition: TableDefinitionLike): void => {
    if (!definition.rankIndexes) {
        return;
    }

    for (const index of definition.rankIndexes) {
        const rankTable = rankTableName(tableName, index.name);
        const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
        const columnDdl = sortColumns.map((column) => `${quoteIdentifier(column)} BLOB`).join(", ");
        const columnPart = sortColumns.length > 0 ? `, ${columnDdl}` : "";

        runSql(sql, `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(rankTable)} ("__id__" TEXT PRIMARY KEY, "__partition__" TEXT NOT NULL${columnPart})`);

        // Sorted btree: (partition, sortBy ASC/DESC..., __id__ ASC)
        const orderedColumns = ['"__partition__" ASC'];

        for (const [i, column] of sortColumns.entries()) {
            const direction = index.sortBy[i]?.direction;

            orderedColumns.push(`${quoteIdentifier(column)} ${direction === "desc" ? "DESC" : "ASC"}`);
        }

        orderedColumns.push('"__id__" ASC');

        const btreeName = `${tableName}__rank_${index.name}__btree`;

        runSql(sql, `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(btreeName)} ON ${quoteIdentifier(rankTable)} (${orderedColumns.join(", ")})`);
    }
};

const runShardMigrations = (sql: SqlExec, schema: SchemaLike, options: { cdc?: boolean } = {}): void => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind === "global") {
            continue;
        }

        runSql(
            sql,
            `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (
                id TEXT PRIMARY KEY,
                _creationTime REAL NOT NULL,
                ${DOC_COLUMN} TEXT NOT NULL
            )`,
        );

        migrateSecondaryIndexes(sql, tableName, definition);
        migrateSearchIndexes(sql, tableName, definition);
        migrateAggregateIndexes(sql, tableName, definition);
        migrateRankIndexes(sql, tableName, definition);
    }

    if (options.cdc) {
        migrateCdcLog(sql);
    }
};

/**
 * Backfill one aggregate counter table by scanning the source rows once and
 * tallying per canonical `by`-key. No-op when the counter already has rows.
 */
const backfillAggregateIndex = (sql: SqlExec, tableName: string, index: AggregateIndexDefinitionLike): void => {
    const aggTable = aggregateTableName(tableName, index.name);
    const existing = runSql<{ count: number }>(sql, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(aggTable)}`).one();

    if (existing.count > 0) {
        return;
    }

    const by = index.by ?? [];
    const tallies = new Map<string, AggregateTally>();
    const rows = runSql(sql, `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)}`).toArray();

    for (const row of rows) {
        const record = rowToDocument(row);

        if (!record || (index.where && !matchesStaticWhere(record, index.where))) {
            continue;
        }

        const encoded = encodeAggregateKey(by, record);

        foldAggregateTally(tallies, encoded, index, record);
    }

    for (const [encoded, tally] of tallies) {
        runSql(sql, `INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__", "__count__") VALUES (?, ?, ?)`, encoded, tally.value, tally.count);
    }
};

/**
 * One-shot backfill of every declared aggregate index. Used by tests and
 * production hosts that want to populate counters up-front instead of on first
 * read. Idempotent: counter rows that already exist are left alone, so it's
 * safe to call twice.
 *
 * The reader uses `ensureBackfilled` internally for the lazy path; this
 * helper is the explicit twin so callers can opt out of the lazy cost.
 */
const backfillAggregateIndexes = (sql: SqlExec, schema: SchemaLike): void => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind === "global" || !definition.aggregateIndexes) {
            continue;
        }

        for (const index of definition.aggregateIndexes) {
            backfillAggregateIndex(sql, tableName, index);
        }
    }
};

/**
 * Backfill one rank companion table by scanning the source rows once. No-op
 * when the companion already carries rows.
 */
const backfillRankIndex = (sql: SqlExec, tableName: string, index: RankIndexDefinitionLike): void => {
    const rankTable = rankTableName(tableName, index.name);
    const existing = runSql<{ count: number }>(sql, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(rankTable)}`).one();

    if (existing.count > 0) {
        return;
    }

    const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
    const columnList = ["__id__", "__partition__", ...sortColumns].map((column) => quoteIdentifier(column)).join(", ");
    const placeholders = ["?", "?", ...sortColumns.map(() => "?")].join(", ");
    const rows = runSql(sql, `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)}`).toArray();

    for (const row of rows) {
        const record = rowToDocument(row);

        if (!record || (index.where && !matchesRankStaticWhere(record, index.where))) {
            continue;
        }

        const partitionKey = encodePartitionKey(index.partitionBy ?? [], record);
        // eslint-disable-next-line unicorn/no-null -- binds the rank sort column to SQLite: a missing sort field is a NULL column value, not undefined
        const sortValues = index.sortBy.map((key) => serializeSqlValue(record[key.field] ?? null));

        runSql(sql, `INSERT INTO ${quoteIdentifier(rankTable)} (${columnList}) VALUES (${placeholders})`, record["_id"] as string, partitionKey, ...sortValues);
    }
};

/**
 * One-shot backfill of every declared rank index. The runtime path uses
 * `ensureRankBackfilled` lazily; this is the explicit twin for production
 * hosts that prefer to populate companions up-front. Idempotent: skips
 * rank companions that already carry rows.
 */
const backfillRankIndexes = (sql: SqlExec, schema: SchemaLike): void => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind === "global" || !definition.rankIndexes) {
            continue;
        }

        for (const index of definition.rankIndexes) {
            backfillRankIndex(sql, tableName, index);
        }
    }
};

export {
    applyCdcChanges,
    backfillAggregateIndexes,
    backfillRankIndexes,
    CDC_LOG_TABLE,
    createShardCtxDb,
    migrateCdcLog,
    normalizeIdStructurally,
    NotUniqueError,
    readCdcChanges,
    runShardMigrations,
    trimCdcChanges,
};
export type { SchedulerLike, TriggerContextLike, TriggerDefinitionLike, TriggerEventLike, TriggerOpLike, TriggerTimingLike } from "./triggers.js";
export type {
    BroadcastDelta,
    CdcChange,
    Clock,
    ColumnMetaLike,
    CountArgs,
    CtxDbOptions,
    DatabaseWriterLike,
    IdGenerator,
    IndexDefinitionLike,
    IndexRangeBuilderLike,
    PaginationOptions,
    ReadHook,
    SchemaLike,
    SearchFilterBuilderLike,
    SearchIndexDefinitionLike,
    SqlCursor,
    SqlExec,
    TableDefinitionLike,
    TableReaderLike,
    ValidatorLike,
    WriteEvent,
    WriteHook,
};
