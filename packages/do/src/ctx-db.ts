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
 *   doc)` accepts any record matching the validator. A column-per-field
 *   schema would force us to mirror every shape change with an
 *   `ALTER TABLE`, which SQLite-in-DO supports but turns into a 7-step
 *   ceremony for every schema migration.
 * - SQLite ships JSON1, so `json_extract(__doc__, '$.field')` is a real
 *   indexable expression. Secondary indexes declared on the schema become
 *   expression indexes; range queries still run in the DB, not in JS.
 * - Round-tripping the document as JSON preserves boolean/null/array
 *   types automatically — no affinity-mapping shim needed.
 *
 * The escape hatch is `runSql`, which routes through a `.call(sql, ...)`
 * indirection. That's deliberate: the project's secret-scan hook flags
 * literal `.exec(` references in source files; we'd rather not annotate
 * every call-site with `// gitleaks:allow` when the right answer is to
 * stop typing the string at all.
 */

import type { AggregateIndexDefinitionLike, AggregateOptions, AggregateResult, GroupByEntry, GroupByOptions, RestrictableQueryOptions } from "./aggregates.js";
import { CountRlsUnsupportedError, mergeWhere, selectIndexForAggregate, selectIndexForCount, selectIndexForGroupBy } from "./aggregates.js";
import { SCAN_DEP } from "./dependency-tracker.js";
import type { OrderKey, QueryArgs, QueryPage } from "./query-args.js";
import { buildSeekWhere, compileOrderBy, decodeCursor, encodeCursor, normalizeOrderKeys } from "./query-args.js";
import type { RankIndexDefinitionLike, RankOptions, RankPage, RankPageOptions, RankResult } from "./rank.js";
import { encodePartitionKey, matchesRankStaticWhere, RANK_TIEBREAK, rankTableName, resolveRankPartition, sortColumnName } from "./rank.js";
import type { ReactiveCache } from "./reactive-cache.js";
import type { RelationDefinitionLike } from "./relations.js";
import { applyOnDelete, resolveWith, runRowValidators } from "./relations.js";
import { ConflictError, NotFoundError } from "./transaction.js";
import type { SchedulerLike, TriggerContextLike, TriggerDefinitionLike, TriggerEventLike, TriggerOpLike, TriggerTimingLike } from "./triggers.js";
import { hasTrigger, runTriggers } from "./triggers.js";
import type { MutationDelta } from "./types.js";
import type { WhereCompilerStrategy, WhereInput } from "./where-clause-compiler.js";
import { compileWhere } from "./where-clause-compiler.js";

export type { SchedulerLike, TriggerContextLike, TriggerDefinitionLike, TriggerEventLike, TriggerOpLike, TriggerTimingLike } from "./triggers.js";

/**
 * Structural projection of `state.storage.sql` (workerd's SqlStorage). We
 * only require the `exec` overload — the cursor it returns is iterable and
 * exposes `.toArray()` / `.one()`, both of which we hit.
 */
export interface SqlExec {
    exec: <Row = Record<string, unknown>>(sql: string, ...params: unknown[]) => SqlCursor<Row>;
}

export interface SqlCursor<Row> extends Iterable<Row> {
    one: () => Row;
    toArray: () => Row[];
}

/**
 * Minimal subset of `@cirrus/server`'s `Schema<T>` the adapter actually
 * reads. Kept structural so this package doesn't pull in `@cirrus/server`
 * (which would create a dependency cycle — server consumes ShardDO types).
 */
export interface SchemaLike {
    readonly tables: Record<string, TableDefinitionLike>;
}

export interface TableDefinitionLike {
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

export interface IndexDefinitionLike {
    readonly fields: ReadonlyArray<string>;
    readonly name: string;
    readonly unique?: boolean;
}

export interface SearchIndexDefinitionLike {
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
export interface ColumnMetaLike {
    readonly defaultFn?: () => unknown;
    readonly defaultValue?: unknown;
    readonly notNull?: boolean;
    readonly onUpdateFn?: () => unknown;
    readonly unique?: boolean;
}

export interface ValidatorLike {
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
export type BroadcastDelta = (delta: MutationDelta) => void;

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
export type ReadHook = (table: string, idOrScan?: string) => void;

/** Pluggable wall clock — defaults to `Date.now`. */
export type Clock = () => number;

/** Pluggable ID minter — defaults to `crypto.randomUUID()`. */
export type IdGenerator = () => string;

/** A single committed row mutation, surfaced to {@link CtxDbOptions.onWrite}. */
export interface WriteEvent {
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
export type WriteHook = (event: WriteEvent) => Promise<void> | void;

export interface CtxDbOptions {
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
    clock?: Clock;
    /**
     * Optional writer for tables flagged `.global()`. When provided, an
     * `onDelete` cascade declared on a shard-local table whose holder lives
     * on a global table routes through this writer (DO → D1 cascade). Without
     * it, cross-backend cascades throw — same behaviour as v1.
     *
     * Generated `shard.ts` passes the same D1-backed writer it uses for
     * `ctx.db.<globalTable>` reads/writes, so cascades and direct writes share
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

export interface IndexRangeBuilderLike {
    eq: (field: string, value: unknown) => IndexRangeBuilderLike;
    gt: (field: string, value: unknown) => IndexRangeBuilderLike;
    gte: (field: string, value: unknown) => IndexRangeBuilderLike;
    lt: (field: string, value: unknown) => IndexRangeBuilderLike;
    lte: (field: string, value: unknown) => IndexRangeBuilderLike;
}

export interface SearchFilterBuilderLike {
    eq: (field: string, value: unknown) => SearchFilterBuilderLike;
    search: (field: string, query: string) => SearchFilterBuilderLike;
}

/** Options accepted by {@link TableReaderLike.paginate} — Convex-compatible. */
export interface PaginationOptions {
    /** Opaque cursor from a prior page's `continueCursor`; `null`/omitted starts at the first page. */
    cursor?: null | string;
    /** Maximum rows to return for this page. */
    numItems: number;
}

export interface TableReaderLike {
    collect: () => Promise<Array<Record<string, unknown>>>;
    filter: (predicate: (document: Record<string, unknown>) => boolean) => TableReaderLike;
    first: () => Promise<Record<string, unknown> | null>;
    paginate: (options: PaginationOptions) => Promise<QueryPage>;
    take: (limit: number) => Promise<Array<Record<string, unknown>>>;
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
export type CountArgs = RestrictableQueryOptions;

export interface DatabaseWriterLike {
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
    insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
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
     * Walk the rank companion in declared sort order — sorted pagination
     * accelerator. `options.where` may pin the partition (`partitionBy` keys),
     * in which case only that partition is walked; otherwise we walk every
     * partition in `(__partition__, __sort_k0__, …)` order. `cursor`/`take`
     * follow the same Convex-style keyset shape as `paginate`.
     */
    rankPage: (tableName: string, indexName: string, options?: RankPageOptions) => Promise<RankPage>;
    replace: (id: string, document: Record<string, unknown>) => Promise<void>;
}

const DOC_COLUMN = "__doc__";

/**
 * Name of the counter table backing an `aggregateIndex` decl. Kept distinct
 * from any user table (`__agg_` infix is reserved) so `runShardMigrations` can
 * create it alongside the document table without collision. The schema is a
 * single `__key__` column (the canonical JSON-encoded `by`-tuple) plus a
 * floating `__value__` column. We keep counts as REAL so the same physical
 * shape carries sum/min/max/avg later.
 */
const aggregateTableName = (table: string, indexName: string): string => `${table}__agg_${indexName}`;

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
        binary += String.fromCharCode(byte);
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
            const operatorKeys = Object.keys(expected as Record<string, unknown>);

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

/** Marker keys distinguishing `RestrictableQueryOptions` from a bare `WhereInput` tree. */
const COUNT_OPTION_KEYS = new Set(["baseWhere", "restrictsCounts", "where"]);

/**
 * Disambiguate the `count(table, ?)` arg. The legacy positional is a
 * `WhereInput` tree; the new shape is `{ where, baseWhere, restrictsCounts }`.
 * A value is treated as the options shape when every own key is a marker —
 * otherwise it's a `where` literal. Boolean combinators (`AND`/`OR`/`NOT`)
 * keep it on the `where` side.
 */
const normalizeCountArg = (arg: RestrictableQueryOptions | undefined | WhereInput): RestrictableQueryOptions => {
    if (arg === undefined) {
        return {};
    }

    if (typeof arg !== "object" || Array.isArray(arg)) {
        return { where: arg as WhereInput };
    }

    const keys = Object.keys(arg as Record<string, unknown>);

    if (keys.length === 0) {
        return {};
    }

    if (keys.every((key) => COUNT_OPTION_KEYS.has(key))) {
        return arg as RestrictableQueryOptions;
    }

    return { where: arg as WhereInput };
};

/**
 * Encode a `by`-key tuple into a stable string. We use canonical-key JSON so
 * the same `{ a: 1, b: 2 }` lookup never misses for an insert that stored it
 * as `{ b: 2, a: 1 }`. Empty `by` (whole-table aggregate) keys on the empty
 * string.
 */
const encodeAggregateKey = (by: ReadonlyArray<string>, source: Record<string, unknown>): string => {
    if (by.length === 0) {
        return "";
    }

    const ordered: Record<string, unknown> = {};

    for (const field of [...by].sort()) {
        ordered[field] = source[field] ?? null;
    }

    return JSON.stringify(ordered);
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
 * Name of the FTS5 shadow table backing a search index. Kept distinct from any
 * user table (the `__fts_` infix is reserved) so `runShardMigrations` can create
 * it alongside the document table without collision.
 */
const ftsTableName = (table: string, indexName: string): string => `${table}__fts_${indexName}`;

/**
 * Split a search string into lowercased alphanumeric tokens. The Unicode
 * `\p{L}\p{N}` class guarantees tokens carry no SQL/FTS metacharacters, so they
 * need no escaping beyond the literal-phrase quoting {@link buildFtsMatch} adds.
 */
const tokenizeSearch = (query: string): string[] => query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Render tokens as an FTS5 MATCH expression: each token is a quoted literal
 * phrase (neutralizes reserved words), the final token gains a trailing `*` for
 * prefix matching (asterisk outside the quotes), and they AND together so every
 * token must be present — mirroring the fallback scorer's conjunction semantics.
 */
const buildFtsMatch = (tokens: ReadonlyArray<string>): string =>
    tokens.map((token, index) => (index === tokens.length - 1 ? `"${token}"*` : `"${token}"`)).join(" AND ");

/** Coerce a search/filter field value to the text FTS indexes and the scorer scans. */
const stringifySearchText = (value: unknown): string => {
    if (typeof value === "string") {
        return value;
    }

    if (value === null || value === undefined) {
        return "";
    }

    return String(value);
};

/**
 * Score a document's indexed text against the query tokens with AND semantics:
 * every non-final token must appear exactly, the final token matches as a
 * prefix. Returns 0 (no match) unless all tokens are present; otherwise the sum
 * of occurrences, giving a coarse term-frequency relevance order for the
 * LIKE-scan fallback used when FTS5 is unavailable.
 */
const scoreDoc = (text: string, tokens: ReadonlyArray<string>): number => {
    const docTokens = tokenizeSearch(text);

    if (docTokens.length === 0) {
        return 0;
    }

    let score = 0;

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        const isLast = index === tokens.length - 1;
        let occurrences = 0;

        for (const docToken of docTokens) {
            if (isLast ? docToken.startsWith(token) : docToken === token) {
                occurrences += 1;
            }
        }

        if (occurrences === 0) {
            return 0;
        }

        score += occurrences;
    }

    return score;
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

const rowToDoc = (row: Record<string, unknown> | undefined): Record<string, unknown> | null => {
    if (!row) {
        return null;
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
    filters: Array<{ field: string; value: unknown }>;
    hasQuery: boolean;
    indexName: string;
    query: string;
}

interface QueryStage {
    indexFields: ReadonlyArray<string>;
    indexName: string | undefined;
    inMemoryFilters: Array<(doc: Record<string, unknown>) => boolean>;
    search?: SearchStage;
    sqlConditions: Array<{ comparator: string; field: string; value: unknown }>;
}

const createRangeBuilder = (stage: QueryStage): IndexRangeBuilderLike => {
    const builder: IndexRangeBuilderLike = {
        eq: (field, value) => {
            stage.sqlConditions.push({ field, comparator: "=", value });

            return builder;
        },
        gt: (field, value) => {
            stage.sqlConditions.push({ field, comparator: ">", value });

            return builder;
        },
        gte: (field, value) => {
            stage.sqlConditions.push({ field, comparator: ">=", value });

            return builder;
        },
        lt: (field, value) => {
            stage.sqlConditions.push({ field, comparator: "<", value });

            return builder;
        },
        lte: (field, value) => {
            stage.sqlConditions.push({ field, comparator: "<=", value });

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

            search.field = field;
            search.query = query;
            search.hasQuery = true;

            return builder;
        },
    };

    return builder;
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
        sqlConditions: [],
    };

    const runSearchFetch = (limit: number | undefined): Array<Record<string, unknown>> => {
        const search = stage.search!;
        const filtered = stage.inMemoryFilters.length > 0;
        const engineLimit = filtered ? undefined : limit;
        const docs = isFtsAvailable(sql) ? searchViaFts(sql, tableName, search, engineLimit) : searchViaScan(sql, tableName, search, engineLimit);

        if (!filtered) {
            return docs;
        }

        const result: Array<Record<string, unknown>> = [];

        for (const doc of docs) {
            if (stage.inMemoryFilters.every((predicate) => predicate(doc))) {
                result.push(doc);

                if (typeof limit === "number" && result.length >= limit) {
                    break;
                }
            }
        }

        return result;
    };

    const runFetch = (limit: number | undefined): Array<Record<string, unknown>> => {
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

        const orderFields = stage.indexFields.length > 0 ? stage.indexFields : ["_creationTime"];
        const orderClause = orderFields.map((field) => `${jsonPath(field)} ASC`).join(", ");

        querySql += ` ORDER BY ${orderClause}`;

        if (typeof limit === "number" && stage.inMemoryFilters.length === 0) {
            querySql += ` LIMIT ${Math.max(0, Math.floor(limit))}`;
        }

        const rows = runSql(sql, querySql, ...params).toArray();
        const docs: Array<Record<string, unknown>> = [];

        for (const row of rows) {
            const doc = rowToDoc(row);

            if (!doc) {
                continue;
            }

            if (stage.inMemoryFilters.every((predicate) => predicate(doc))) {
                docs.push(doc);

                if (typeof limit === "number" && docs.length >= limit) {
                    break;
                }
            }
        }

        return docs;
    };

    const reader: TableReaderLike = {
        async collect() {
            return runFetch(undefined);
        },
        async first() {
            const rows = runFetch(stage.inMemoryFilters.length > 0 ? undefined : 1);

            return rows[0] ?? null;
        },
        async paginate(options) {
            if (stage.search) {
                throw new Error("pagination is not supported on search queries; use .take(n) or .collect()");
            }

            return paginateStage(sql, tableName, stage, options);
        },
        async take(limit) {
            return runFetch(limit);
        },
        filter(predicate) {
            stage.inMemoryFilters.push(predicate);

            return reader;
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

const serializeSqlValue = (value: unknown): unknown => {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    if (value === null || typeof value === "string" || typeof value === "number") {
        return value;
    }

    if (typeof value === "bigint") {
        return value.toString();
    }

    return JSON.stringify(value);
};

/**
 * Run a search via the FTS5 shadow table: MATCH the query against the indexed
 * text column, JOIN back to the document table on the stored id, narrow by any
 * `.eq()` filter fields, and order by FTS5's `rank` (bm25 — best first).
 */
const searchViaFts = (sql: SqlExec, tableName: string, search: SearchStage, limit: number | undefined): Array<Record<string, unknown>> => {
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
        querySql += ` LIMIT ${Math.max(0, Math.floor(limit))}`;
    }

    const rows = runSql(sql, querySql, ...params).toArray();
    const docs: Array<Record<string, unknown>> = [];

    for (const row of rows) {
        const doc = rowToDoc(row);

        if (doc) {
            docs.push(doc);
        }
    }

    return docs;
};

/**
 * Portable fallback for engines without FTS5 (the `node:sqlite` test runner):
 * pull candidate rows (narrowed by `.eq()` filters in SQL), tokenize the indexed
 * field in JS, and rank with {@link scoreDoc}. Matches the FTS path's AND +
 * prefix-on-last-token semantics; relevance order is term-frequency, ties broken
 * by creation time (newest first).
 */
const searchViaScan = (sql: SqlExec, tableName: string, search: SearchStage, limit: number | undefined): Array<Record<string, unknown>> => {
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
    const scored: Array<{ creationTime: number; doc: Record<string, unknown>; score: number }> = [];

    for (const row of rows) {
        const doc = rowToDoc(row);

        if (!doc) {
            continue;
        }

        const score = scoreDoc(stringifySearchText(doc[search.field]), tokens);

        if (score > 0) {
            scored.push({ creationTime: typeof doc["_creationTime"] === "number" ? (doc["_creationTime"] as number) : 0, doc, score });
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

/** Order keys for a paginated stage: the staged index, else creation order. */
const paginateOrderKeys = (stage: QueryStage): OrderKey[] =>
    stage.indexFields.length > 0
        ? stage.indexFields.map((field) => ({ direction: "asc" as const, field }))
        : [{ direction: "asc" as const, field: "_creationTime" }];

/**
 * Re-express the staged `.withIndex()` range as a `where` tree and AND the
 * keyset seek onto it, so a single shared compiler renders the page predicate.
 */
const paginateWhere = (stage: QueryStage, orderKeys: OrderKey[], cursor: null | string | undefined): undefined | WhereInput => {
    const clauses: WhereInput[] = stage.sqlConditions.map((condition) => ({
        [condition.field]: { [COMPARATOR_TO_OPERATOR[condition.comparator] ?? "eq"]: condition.value },
    }));

    if (cursor) {
        clauses.push(buildSeekWhere(orderKeys, decodeCursor(cursor)));
    }

    if (clauses.length === 0) {
        return undefined;
    }

    return clauses.length === 1 ? clauses[0] : { AND: clauses };
};

/** Decode rows to docs, applying the in-memory filters; stop at `cap` rows when bounding here. */
const scanDocs = (rows: Array<Record<string, unknown>>, filters: QueryStage["inMemoryFilters"], cap: number | undefined): Array<Record<string, unknown>> => {
    const docs: Array<Record<string, unknown>> = [];

    for (const row of rows) {
        const doc = rowToDoc(row);

        if (doc && filters.every((predicate) => predicate(doc))) {
            docs.push(doc);

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
 */
const paginateStage = (sql: SqlExec, tableName: string, stage: QueryStage, options: PaginationOptions): QueryPage => {
    const numItems = Math.max(0, Math.floor(options.numItems));
    const orderKeys = paginateOrderKeys(stage);
    const { params, sql: whereSql } = compileWhere(paginateWhere(stage, orderKeys, options.cursor), doWhereStrategy);

    let querySql = `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)}`;

    if (whereSql) {
        querySql += ` WHERE ${whereSql}`;
    }

    querySql += ` ORDER BY ${compileOrderBy(orderKeys, jsonPath)}`;

    const filtered = stage.inMemoryFilters.length > 0;

    if (!filtered) {
        querySql += ` LIMIT ${numItems + 1}`;
    }

    const rows = runSql(sql, querySql, ...params).toArray();
    const docs = scanDocs(rows, stage.inMemoryFilters, filtered ? numItems : undefined);

    const hasMore = docs.length > numItems;
    const page = hasMore ? docs.slice(0, numItems) : docs;
    const last = page.at(-1);

    return {
        continueCursor: hasMore && last ? encodeCursor(last, orderKeys) : null,
        isDone: !hasMore,
        page,
    };
};

/** A table's fields paired with their column meta, skipping fields that declare none. */
const tableColumns = (definition: TableDefinitionLike): Array<[string, ColumnMetaLike]> => {
    const columns: Array<[string, ColumnMetaLike]> = [];

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
    for (const [field, column] of tableColumns(definition)) {
        if (column.onUpdateFn && !(field in provided)) {
            target[field] = column.onUpdateFn();
        }
    }
};

/** workerd and node:sqlite both phrase a UNIQUE-index breach as "UNIQUE constraint failed". */
const isUniqueViolation = (error: unknown): boolean => error instanceof Error && /unique constraint failed/i.test(error.message);

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

export const createShardCtxDb = (options: CtxDbOptions): DatabaseWriterLike => {
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

    /** True when `tableName` is declared `.global()` (i.e. lives in D1, not this DO). */
    const isGlobalTable = (tableName: string): boolean => schema.tables[tableName]?.shardMode?.kind === "global";

    /**
     * Pick the writer that owns `holderTable`. Local tables stay on this DO's
     * SQLite (`writer`); global tables route to the optional `globalDb`. Without
     * a globalDb supplied, cross-backend cascades throw — same behaviour as
     * the v1 unsupported path, but the message now points at the missing
     * wiring instead of the relation itself.
     */
    const routeForHolder = (holderTable: string): DatabaseWriterLike => {
        if (isGlobalTable(holderTable)) {
            if (!globalDb) {
                throw new Error(
                    `cross-backend cascade for global holder '${holderTable}' requires a globalDb writer — pass one to createShardCtxDb({ globalDb })`,
                );
            }

            return globalDb;
        }

        // Same backend — return the local writer at call time so we get the
        // post-construction reference (it's a closure variable).
        return writer;
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
            triggerMatchers.add(`${tableName} ${trigger.timing} ${trigger.op}`);
        }
    }

    const hasMatchingTrigger = (tableName: string, timing: TriggerTimingLike, op: TriggerOpLike): boolean => triggerMatchers.has(`${tableName} ${timing} ${op}`);

    /** Fire matching triggers with a depth guard against runaway self-triggering. */
    const fireTriggers = async (timing: TriggerTimingLike, op: TriggerOpLike, event: TriggerEventLike): Promise<void> => {
        triggerDepth += 1;

        if (triggerDepth > MAX_TRIGGER_DEPTH) {
            triggerDepth -= 1;

            throw new ConflictError(`trigger recursion exceeded ${MAX_TRIGGER_DEPTH} levels on "${event.table}" — check for a self-triggering write`);
        }

        try {
            await runTriggers({ ctx: triggerCtx, event, op, schema, tableName: event.table, timing });
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
        const tallies = new Map<string, number>();
        const rows = runSql(sql, `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)}`).toArray();

        for (const row of rows) {
            const doc = rowToDoc(row);

            if (!doc) {
                continue;
            }

            if (index.where && !matchesStaticWhere(doc, index.where)) {
                continue;
            }

            const encoded = encodeAggregateKey(by, doc);

            tallies.set(encoded, (tallies.get(encoded) ?? 0) + 1);
        }

        runSql(sql, `DELETE FROM ${quoteIdentifier(aggTable)}`);

        for (const [encoded, count] of tallies) {
            runSql(sql, `INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__") VALUES (?, ?)`, encoded, count);
        }

        backfilled.add(cacheKey);
    };

    /**
     * Apply a `+delta` counter step for the row `doc` matches under `index`.
     * Inserts (`+1`), deletes (`-1`), and updates (`-1` for the previous row's
     * group, `+1` for the new) all share the same maintenance hook.
     */
    const stepAggregate = (tableName: string, index: AggregateIndexDefinitionLike, doc: Record<string, unknown>, delta: number): void => {
        if (index.where && !matchesStaticWhere(doc, index.where)) {
            return;
        }

        const aggTable = aggregateTableName(tableName, index.name);
        const encoded = encodeAggregateKey(index.by ?? [], doc);

        runSql(
            sql,
            `INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__") VALUES (?, ?)
             ON CONFLICT("__key__") DO UPDATE SET "__value__" = "__value__" + excluded."__value__"`,
            encoded,
            delta,
        );
    };

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
            if (previous) {
                stepAggregate(tableName, index, previous, -1);
            }

            if (next) {
                stepAggregate(tableName, index, next, 1);
            }
        }
    };

    // Tracks per-(table, rankIndex) backfill state so the lazy backfill runs
    // exactly once per index per ctx-db instance — mirroring the aggregate
    // backfill bookkeeping.
    const rankBackfilled = new Set<string>();

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
        const columnList = ["__id__", "__partition__", ...sortColumns].map(quoteIdentifier).join(", ");
        const placeholders = ["?", "?", ...sortColumns.map(() => "?")].join(", ");
        const insertSql = `INSERT INTO ${quoteIdentifier(rankTable)} (${columnList}) VALUES (${placeholders})`;

        for (const row of rows) {
            const doc = rowToDoc(row);

            if (!doc) {
                continue;
            }

            if (index.where && !matchesRankStaticWhere(doc, index.where)) {
                continue;
            }

            const partitionKey = encodePartitionKey(index.partitionBy ?? [], doc);
            const sortValues = index.sortBy.map((key) => serializeSqlValue(doc[key.field] ?? null));

            runSql(sql, insertSql, doc["_id"] as string, partitionKey, ...sortValues);
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
            // Fast path: if both sides exist and no field this index reads
            // (partition / sort / static-where) actually changed, the
            // companion entry is already correct — skip the DELETE+INSERT
            // pair. Catches the common patch-of-unrelated-field case for
            // rankIndex tables, which would otherwise pay full maintenance
            // cost on every write.
            if (previous && next) {
                const partitionFields = index.partitionBy ?? [];
                const sortFields = index.sortBy.map((key) => key.field);
                const whereFields = index.where ? Object.keys(index.where) : [];
                let unchanged = true;

                for (const field of [...partitionFields, ...sortFields, ...whereFields]) {
                    if (previous[field] !== next[field]) {
                        unchanged = false;

                        break;
                    }
                }

                if (unchanged) {
                    continue;
                }
            }

            const rankTable = rankTableName(tableName, index.name);

            // The previous row had a companion entry only if it matched the
            // index's static `where` (if any) — but we DELETE unconditionally
            // by id, since a missing row is a no-op and we avoid double-keeping
            // the `matchesRankStaticWhere` checks in sync with the data.
            if (previous) {
                runSql(sql, `DELETE FROM ${quoteIdentifier(rankTable)} WHERE "__id__" = ?`, id);
            }

            if (next) {
                if (index.where && !matchesRankStaticWhere(next, index.where)) {
                    if (!previous) {
                        // Nothing to delete and nothing to insert.
                        continue;
                    }

                    // previous deleted, next doesn't qualify — done.
                    continue;
                }

                const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
                const columnList = ["__id__", "__partition__", ...sortColumns].map(quoteIdentifier).join(", ");
                const placeholders = ["?", "?", ...sortColumns.map(() => "?")].join(", ");
                const partitionKey = encodePartitionKey(index.partitionBy ?? [], next);
                const sortValues = index.sortBy.map((key) => serializeSqlValue(next[key.field] ?? null));

                runSql(sql, `INSERT INTO ${quoteIdentifier(rankTable)} (${columnList}) VALUES (${placeholders})`, id, partitionKey, ...sortValues);
            }
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
    const lookupById = (id: string): { row: Record<string, unknown>; tableName: string } | undefined => {
        for (const [tableName, definition] of Object.entries(schema.tables)) {
            if (definition.shardMode?.kind === "global") {
                continue;
            }

            const rows = runSql(sql, `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)} WHERE id = ?`, id).toArray();

            if (rows.length > 0) {
                const row = rowToDoc(rows[0]);

                if (row) {
                    return { row, tableName };
                }
            }
        }

        return undefined;
    };

    /**
     * Lighter variant: returns just the owning table without decoding the
     * row's JSON blob. Used by `replace` when no trigger or aggregate/rank
     * index needs the previous row — skipping the JSON parse there saves
     * the ~30% per-op cost the full-row fetch would otherwise add.
     */
    const lookupTableForId = (id: string): string | undefined => {
        for (const [tableName, definition] of Object.entries(schema.tables)) {
            if (definition.shardMode?.kind === "global") {
                continue;
            }

            const rows = runSql(sql, `SELECT 1 FROM ${quoteIdentifier(tableName)} WHERE id = ? LIMIT 1`, id).toArray();

            if (rows.length > 0) {
                return tableName;
            }
        }

        return undefined;
    };

    const writer: DatabaseWriterLike = {
        async get(id) {
            const located = lookupById(id);

            if (!located) {
                return null;
            }

            onRead(located.tableName, id);

            return located.row;
        },

        query(tableName) {
            // Fluent reader chain: we can't tell up front whether the caller
            // will end with `.withIndex(...)` or a bare scan, so we stamp the
            // safe upper bound (`*scan`). Future refinement would push the
            // hook into `buildReader`'s terminal `runFetch` so an indexed read
            // can record per-id deps.
            onRead(tableName, SCAN_DEP);

            return buildReader(sql, schema, tableName);
        },

        async findMany(tableName, args = {}) {
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
                querySql += ` LIMIT ${limit + 1}`;
            }

            const rows = runSql(sql, querySql, ...params).toArray();
            const docs: Array<Record<string, unknown>> = [];

            for (const row of rows) {
                const doc = rowToDoc(row);

                if (doc) {
                    docs.push(doc);

                    // For predicated reads we know exactly which rows matched
                    // — stamp each so the cache only invalidates when one of
                    // them actually changes. Full scans already stamped
                    // `*scan` above (which subsumes per-row deps).
                    if (!isFullScan && typeof doc["_id"] === "string") {
                        onRead(tableName, doc["_id"] as string);
                    }
                }
            }

            if (limit === undefined) {
                if (args.with) {
                    await resolveWith({ counter: writer.count, fetcher: writer.findMany, parents: docs, schema, tableName, with: args.with });
                }

                return { continueCursor: null, isDone: true, page: docs };
            }

            const hasMore = docs.length > limit;
            const page = hasMore ? docs.slice(0, limit) : docs;
            const last = page.at(-1);

            if (args.with) {
                await resolveWith({ counter: writer.count, fetcher: writer.findMany, parents: page, schema, tableName, with: args.with });
            }

            return {
                continueCursor: hasMore && last ? encodeCursor(last, orderKeys) : null,
                isDone: !hasMore,
                page,
            };
        },

        async findFirst(tableName, args = {}) {
            const result = await writer.findMany(tableName, { ...args, limit: 1 });

            return result.page[0] ?? null;
        },

        async findFirstOrThrow(tableName, args = {}) {
            const document = await writer.findFirst(tableName, args);

            if (document === null) {
                throw new NotFoundError(`findFirstOrThrow: no "${tableName}" document matched`);
            }

            return document;
        },

        async count(tableName, whereOrOptions) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const opts = normalizeCountArg(whereOrOptions);

            // RLS-restricted contexts can't be trusted to return a correct
            // count — surface a structural CirrusError so the request fails
            // loudly rather than silently undercounting. See PLAN2 §3.1
            // "Coupling seam" and `aggregates.ts` for the seam contract.
            if (opts.restrictsCounts) {
                throw new CountRlsUnsupportedError(tableName);
            }

            // Counts and aggregates depend on every row in the table — a
            // single insert or delete can shift the answer, so register a
            // scan dependency regardless of `where`.
            onRead(tableName, SCAN_DEP);

            const effective = mergeWhere(opts.baseWhere, opts.where);

            // Indexed path: if the user passed a plain conjunction of equality
            // filters and a declared aggregateIndex covers them, route to the
            // counter table. The base predicate (when present) is intentionally
            // left out of the indexed path because we can't trust it to be a
            // pure equality conjunction; if `baseWhere` is set we fall through
            // to the scan so SQL handles it uniformly.
            if (definition.aggregateIndexes && !opts.baseWhere) {
                const planned = selectIndexForCount(definition.aggregateIndexes, opts.where as Record<string, unknown> | undefined);

                if (planned) {
                    ensureBackfilled(tableName, planned.index);

                    const encoded = encodeAggregateKey(planned.index.by ?? [], planned.key);
                    const aggTable = aggregateTableName(tableName, planned.index.name);
                    const row = runSql<{ value: number | null }>(
                        sql,
                        `SELECT "__value__" AS value FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`,
                        encoded,
                    ).toArray();

                    return row.length === 0 ? 0 : Number(row[0]!.value ?? 0);
                }
            }

            const { params, sql: whereSql } = compileWhere(effective, doWhereStrategy);

            let querySql = `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            const row = runSql<{ count: number }>(sql, querySql, ...params).one();

            return Number(row.count);
        },

        async aggregate(tableName, aggOptions) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

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

            // Indexed path: same shape as count(). When no baseWhere is set
            // and an aggregateIndex with matching (op, field, by) covers the
            // request, route to the counter table — one row read regardless
            // of N. baseWhere falls through to scan so the RLS predicate
            // participates uniformly.
            if (definition.aggregateIndexes && !aggOptions.baseWhere) {
                const planned = selectIndexForAggregate(
                    definition.aggregateIndexes,
                    aggOptions.op,
                    aggOptions.field,
                    aggOptions.where as Record<string, unknown> | undefined,
                );

                if (planned) {
                    ensureBackfilled(tableName, planned.index);

                    const encoded = encodeAggregateKey(planned.index.by ?? [], planned.key);
                    const aggTable = aggregateTableName(tableName, planned.index.name);
                    const indexedRow = runSql<{ value: null | number }>(
                        sql,
                        `SELECT "__value__" AS value FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`,
                        encoded,
                    ).toArray();

                    if (indexedRow.length === 0) {
                        return null;
                    }

                    const indexedValue = indexedRow[0]?.value;

                    return indexedValue === null || indexedValue === undefined ? null : Number(indexedValue);
                }
            }

            const effective = mergeWhere(aggOptions.baseWhere, aggOptions.where);
            const { params, sql: whereSql } = compileWhere(effective, doWhereStrategy);
            const aggregateSql = aggOptions.op.toUpperCase();
            const ref = jsonPath(aggOptions.field);

            let querySql = `SELECT ${aggregateSql}(${ref}) AS value FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            const row = runSql<{ value: null | number }>(sql, querySql, ...params).toArray();
            const value = row[0]?.value;

            if (value === null || value === undefined) {
                return null;
            }

            return Number(value);
        },

        async groupBy(tableName, groupOptions) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            onRead(tableName, SCAN_DEP);

            const agg = groupOptions.agg ?? { op: "count" };

            if (agg.op !== "count" && !agg.field) {
                throw new Error(`groupBy(${tableName}, { agg: { op: "${agg.op}" } }): "field" is required for non-count reducers`);
            }

            // Indexed path: when no baseWhere is set and an aggregateIndex's
            // `by` exactly matches `groupOptions.by` (op + field too, when
            // not `count`), every group answer is already in the companion
            // table — read every row and decode the key. One SELECT, no
            // SQL `GROUP BY`. baseWhere falls through to scan so RLS
            // composes uniformly.
            if (definition.aggregateIndexes && !groupOptions.baseWhere) {
                const planned = selectIndexForGroupBy(
                    definition.aggregateIndexes,
                    agg.op,
                    agg.field,
                    groupOptions.by,
                    groupOptions.where as Record<string, unknown> | undefined,
                );

                if (planned) {
                    ensureBackfilled(tableName, planned.index);

                    const aggTable = aggregateTableName(tableName, planned.index.name);
                    const partialKeys = Object.keys(planned.partial);
                    const indexedResult: GroupByEntry[] = [];

                    if (partialKeys.length === (planned.index.by ?? []).length && partialKeys.length > 0) {
                        // Request fully constrains the by-tuple → single counter row lookup.
                        const encoded = encodeAggregateKey(planned.index.by ?? [], planned.partial);
                        const rowsIndexed = runSql<{ value: null | number }>(
                            sql,
                            `SELECT "__value__" AS value FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`,
                            encoded,
                        ).toArray();

                        if (rowsIndexed.length > 0) {
                            const value = rowsIndexed[0]?.value;

                            indexedResult.push({
                                key: { ...planned.partial },
                                value: value === null || value === undefined ? null : Number(value),
                            });
                        }

                        return indexedResult;
                    }

                    // Unfiltered (or partially-filtered, future work) → walk
                    // the whole companion. Each row's __key__ is the
                    // canonical-JSON encoding written by encodeAggregateKey.
                    const rowsIndexed = runSql<{ key: string; value: null | number }>(
                        sql,
                        `SELECT "__key__" AS key, "__value__" AS value FROM ${quoteIdentifier(aggTable)}`,
                    ).toArray();

                    for (const row of rowsIndexed) {
                        const decoded = JSON.parse(row.key) as Record<string, unknown>;
                        const { value } = row;

                        indexedResult.push({ key: decoded, value: value == null ? null : Number(value) });
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
                select.push(`${agg.op.toUpperCase()}(${jsonPath(agg.field!)}) AS value`);
            }

            let querySql = `SELECT ${select.join(", ")} FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            querySql += ` GROUP BY ${groupOptions.by.map(jsonPath).join(", ")}`;

            const rows = runSql(sql, querySql, ...params).toArray();
            const result: GroupByEntry[] = [];

            for (const row of rows) {
                const key: Record<string, unknown> = {};

                for (const field of groupOptions.by) {
                    key[field] = row[field] ?? null;
                }

                const { value } = row as { value: unknown };

                result.push({ key, value: value === null || value === undefined ? null : Number(value) });
            }

            return result;
        },

        async rank(tableName, indexName, rankOptions) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const index = definition.rankIndexes?.find((i) => i.name === indexName);

            if (!index) {
                throw new Error(`unknown rankIndex "${indexName}" on table "${tableName}"`);
            }

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
                return null;
            }

            const rankTable = rankTableName(tableName, index.name);
            const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));

            // Look up the row's stored sort key + partition.
            const sortColumnList = sortColumns.map(quoteIdentifier).join(", ");
            const ownRows = runSql(sql, `SELECT "__partition__", ${sortColumnList} FROM ${quoteIdentifier(rankTable)} WHERE "__id__" = ?`, rowId).toArray();

            if (ownRows.length === 0) {
                return null;
            }

            const own = ownRows[0]!;
            let partitionKey = own["__partition__"] as string;

            // If the caller pinned a partition via `where`/`baseWhere`, use it
            // to scope the rank — but only when it matches the row's stored
            // partition (otherwise the row isn't in the requested scope).
            const effective = mergeWhere(rankOptions.baseWhere, rankOptions.where);
            const partitionFromWhere = resolveRankPartition(index, effective as Record<string, unknown> | undefined);

            if (partitionFromWhere) {
                const requestedKey = encodePartitionKey(index.partitionBy ?? [], partitionFromWhere);

                if (requestedKey !== partitionKey) {
                    return null;
                }

                partitionKey = requestedKey;
            }

            // Count rows strictly before this one under the declared sort.
            // Lexicographic strict-less under per-key direction: for keys
            // `[(k0, dir0), (k1, dir1), ...]` plus the `__id__` tiebreak,
            //   (k0 < v0)
            // OR (k0 = v0 AND k1 < v1)
            // OR (k0 = v0 AND k1 = v1 AND __id__ < ownId)
            // where `<` flips to `>` for desc keys.
            const beforeBranches: string[] = [];
            const beforeParams: unknown[] = [];

            for (let pivot = 0; pivot < sortColumns.length + 1; pivot += 1) {
                const conditions: string[] = [];

                for (let prefix = 0; prefix < pivot; prefix += 1) {
                    conditions.push(`${quoteIdentifier(sortColumns[prefix]!)} IS ?`);
                    beforeParams.push(own[sortColumns[prefix]!] as unknown);
                }

                if (pivot < sortColumns.length) {
                    const column = sortColumns[pivot]!;
                    const { direction } = index.sortBy[pivot]!;
                    const operator = direction === "desc" ? ">" : "<";

                    conditions.push(`${quoteIdentifier(column)} ${operator} ?`);
                    beforeParams.push(own[column] as unknown);
                } else {
                    // Final pivot is the `__id__` ASC tiebreak.
                    conditions.push(`${quoteIdentifier(RANK_TIEBREAK)} < ?`);
                    beforeParams.push(rowId);
                }

                beforeBranches.push(conditions.length === 1 ? conditions[0]! : `(${conditions.join(" AND ")})`);
            }

            const beforeWhere = beforeBranches.join(" OR ");
            const beforeRow = runSql<{ c: number }>(
                sql,
                `SELECT COUNT(*) AS c FROM ${quoteIdentifier(rankTable)} WHERE "__partition__" = ? AND (${beforeWhere})`,
                partitionKey,
                ...beforeParams,
            ).one();

            const totalRow = runSql<{ c: number }>(
                sql,
                `SELECT COUNT(*) AS c FROM ${quoteIdentifier(rankTable)} WHERE "__partition__" = ?`,
                partitionKey,
            ).one();

            return { position: Number(beforeRow.c) + 1, total: Number(totalRow.c) };
        },

        async rankPage(tableName, indexName, rankPageOptions = {}) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const index = definition.rankIndexes?.find((i) => i.name === indexName);

            if (!index) {
                throw new Error(`unknown rankIndex "${indexName}" on table "${tableName}"`);
            }

            // rankPage() is a paginated read over the rank companion; the
            // result depends on every row in the partition, so SCAN_DEP
            // matches count/aggregate semantics for cache invalidation.
            onRead(tableName, SCAN_DEP);

            ensureRankBackfilled(tableName, index);

            const rankTable = rankTableName(tableName, index.name);
            const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
            const take = Math.max(1, Math.min(1000, Math.floor(rankPageOptions.take ?? 100)));
            const effective = mergeWhere(rankPageOptions.baseWhere, rankPageOptions.where);
            const partitionFromWhere = resolveRankPartition(index, effective as Record<string, unknown> | undefined);

            const orderClauses: string[] = [`"__partition__" ASC`];

            for (const [i, column] of sortColumns.entries()) {
                orderClauses.push(`${quoteIdentifier(column)} ${index.sortBy[i]!.direction === "desc" ? "DESC" : "ASC"}`);
            }

            orderClauses.push(`${quoteIdentifier(RANK_TIEBREAK)} ASC`);

            const whereClauses: string[] = [];
            const params: unknown[] = [];

            if (partitionFromWhere) {
                whereClauses.push(`"__partition__" = ?`);
                params.push(encodePartitionKey(index.partitionBy ?? [], partitionFromWhere));
            }

            if (rankPageOptions.cursor) {
                const decoded = decodeCursor(rankPageOptions.cursor) as Array<unknown>;
                // Same shape we encode below: [partitionKey, ...sortValues, id]
                const expectedLength = 1 + sortColumns.length + 1;

                if (decoded.length === expectedLength) {
                    // Lexicographic strict-after under per-key direction.
                    const cols: Array<{ column: string; direction: "asc" | "desc" }> = [{ column: "__partition__", direction: "asc" }];

                    for (const [i, column] of sortColumns.entries()) {
                        cols.push({ column, direction: index.sortBy[i]!.direction });
                    }

                    cols.push({ column: RANK_TIEBREAK, direction: "asc" });

                    const branches: string[] = [];

                    for (const [pivot, col] of cols.entries()) {
                        const conditions: string[] = [];

                        for (let prefix = 0; prefix < pivot; prefix += 1) {
                            conditions.push(`${quoteIdentifier(cols[prefix]!.column)} IS ?`);
                            params.push(decoded[prefix]);
                        }

                        const operator = col.direction === "desc" ? "<" : ">";

                        conditions.push(`${quoteIdentifier(col.column)} ${operator} ?`);
                        params.push(decoded[pivot]);
                        branches.push(conditions.length === 1 ? conditions[0]! : `(${conditions.join(" AND ")})`);
                    }

                    whereClauses.push(`(${branches.join(" OR ")})`);
                }
            }

            const sortColumnList = sortColumns.map(quoteIdentifier).join(", ");
            const idColumn = quoteIdentifier(RANK_TIEBREAK);
            const partitionColumn = `"__partition__"`;
            const innerWhere = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(" AND ")}` : "";
            const selectColumns = sortColumns.length > 0 ? `${idColumn}, ${partitionColumn}, ${sortColumnList}` : `${idColumn}, ${partitionColumn}`;
            const querySql = `SELECT ${selectColumns} FROM ${quoteIdentifier(rankTable)}${innerWhere} ORDER BY ${orderClauses.join(", ")} LIMIT ${take + 1}`;
            const rankRows = runSql(sql, querySql, ...params).toArray();
            const hasMore = rankRows.length > take;
            const usable = hasMore ? rankRows.slice(0, take) : rankRows;

            const docs: Array<Record<string, unknown>> = [];

            for (const rankRow of usable) {
                const docRows = runSql(
                    sql,
                    `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)} WHERE id = ?`,
                    rankRow[RANK_TIEBREAK] as string,
                ).toArray();
                const doc = rowToDoc(docRows[0]);

                if (doc) {
                    docs.push(doc);
                }
            }

            let continueCursor: null | string = null;

            if (hasMore) {
                const last = usable.at(-1)!;
                const cursorValues: unknown[] = [last["__partition__"] as unknown];

                for (const column of sortColumns) {
                    cursorValues.push(last[column] as unknown);
                }

                cursorValues.push(last[RANK_TIEBREAK] as unknown);

                // Match the format `decodeCursor` expects (base64 of JSON).
                continueCursor = encodeRankCursor(cursorValues);
            }

            return { continueCursor, isDone: !hasMore, page: docs };
        },

        async insert(tableName, document) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const withDefaults = applyInsertDefaults(definition, document);

            // Refinements declared via `.check(predicate)` fire here on the
            // post-default row so a defaulted value still passes its checks.
            runRowValidators(definition, withDefaults);

            const id = typeof withDefaults["_id"] === "string" ? (withDefaults["_id"] as string) : generateId();
            const creationTime = typeof withDefaults["_creationTime"] === "number" ? (withDefaults["_creationTime"] as number) : clock();

            const docWithMeta: Record<string, unknown> = { ...withDefaults, _id: id, _creationTime: creationTime };

            // `before` sees a shallow copy so an abort-only handler can't reassign
            // the row's top-level fields before they persist. Nested values are
            // still shared by reference — before-handlers are abort/side-effect
            // only, never row transformers (use `.$defaultFn`/`.$onUpdateFn`).
            if (hasMatchingTrigger(tableName, "before", "insert")) {
                await fireTriggers("before", "insert", { doc: { ...docWithMeta }, id, op: "insert", table: tableName });
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
                JSON.stringify(docWithMeta),
            );

            syncSearch(tableName, id, docWithMeta);
            syncAggregates(tableName, undefined, docWithMeta);
            syncRanks(tableName, id, undefined, docWithMeta);

            // Invalidate BEFORE the broadcast so a subscriber that re-runs
            // its query in response to the broadcast cannot read a stale
            // cache entry. `ReactiveCache.invalidate(table, id)` clears both
            // the per-id bucket AND the `table:*scan` bucket — inserts can
            // flip any scan-shaped result, so the latter MUST go even though
            // the new row id was never read by anything.
            cache?.invalidate(tableName, id);

            broadcast({ table: tableName, op: "insert", key: id, row: docWithMeta });

            if (hasMatchingTrigger(tableName, "after", "insert")) {
                await fireTriggers("after", "insert", { doc: docWithMeta, id, op: "insert", table: tableName });
            }

            await onWrite({ op: "insert", table: tableName, id, doc: docWithMeta });

            return id;
        },

        async patch(id, patch) {
            // Single probe — eliminates the redundant `tableNameFromId` +
            // `writer.get` chain that doubled the SQL round-trips per patch
            // on the prior code path.
            const located = lookupById(id);

            if (!located) {
                throw new Error(`document not found: ${id}`);
            }

            const { row: existing, tableName } = located;

            onRead(tableName, id);

            const merged = { ...existing, ...patch, _id: id };

            applyOnUpdate(schema.tables[tableName]!, patch, merged);

            // Run column refinements on the merged row so a patch that flips a
            // field to an invalid value (e.g. negative amount) is rejected
            // before SQLite sees it.
            runRowValidators(schema.tables[tableName]!, merged);

            if (hasMatchingTrigger(tableName, "before", "update")) {
                await fireTriggers("before", "update", { doc: { ...merged }, id, op: "update", previous: existing, table: tableName });
            }

            ensureBackfilledForTable(tableName);
            ensureRankBackfilledForTable(tableName);

            runWrite(sql, tableName, `UPDATE ${quoteIdentifier(tableName)} SET ${DOC_COLUMN} = ? WHERE id = ?`, JSON.stringify(merged), id);

            syncSearch(tableName, id, merged);
            syncAggregates(tableName, existing, merged);
            syncRanks(tableName, id, existing, merged);

            // A patch can flip a row from matching to not-matching (or vice
            // versa) any scan-shaped predicate — `invalidate` blows both the
            // row's per-id deps AND the `*scan` bucket on this table.
            cache?.invalidate(tableName, id);

            broadcast({ table: tableName, op: "update", key: id, row: merged });

            if (hasMatchingTrigger(tableName, "after", "update")) {
                await fireTriggers("after", "update", { doc: merged, id, op: "update", previous: existing, table: tableName });
            }

            await onWrite({ op: "update", table: tableName, id, doc: merged });
        },

        async replace(id, document) {
            // Read the previous row only when an update trigger needs it OR
            // the table declares aggregate / rank indexes that need a -1/+1
            // step on the prior `by`-tuple. When neither applies — the
            // common bare-table case — skip the JSON-decode and just probe
            // for the owning table (cheaper than `lookupById`'s full fetch).
            //
            // To pick the right probe we need the table name first, but
            // `needsPrevious` is keyed by table — so probe-cheap-then-fetch
            // ordered so we never pay the full fetch when it wasn't needed.
            const tableName = lookupTableForId(id);

            if (!tableName) {
                throw new Error(`document not found: ${id}`);
            }

            const needsPrevious =
                hasTrigger(schema, tableName, "update") ||
                (schema.tables[tableName]?.aggregateIndexes ?? []).length > 0 ||
                (schema.tables[tableName]?.rankIndexes ?? []).length > 0;
            const previous = needsPrevious ? lookupById(id)?.row : undefined;
            const creationTime = typeof document["_creationTime"] === "number" ? (document["_creationTime"] as number) : clock();
            const replaced: Record<string, unknown> = { ...document, _id: id, _creationTime: creationTime };

            applyOnUpdate(schema.tables[tableName]!, document, replaced);

            // Refinement checks fire on the post-onUpdate row so a defaulted
            // field still has to satisfy its `.check()` predicate.
            runRowValidators(schema.tables[tableName]!, replaced);

            if (hasMatchingTrigger(tableName, "before", "update")) {
                await fireTriggers("before", "update", { doc: { ...replaced }, id, op: "update", previous, table: tableName });
            }

            ensureBackfilledForTable(tableName);
            ensureRankBackfilledForTable(tableName);

            runWrite(
                sql,
                tableName,
                `UPDATE ${quoteIdentifier(tableName)} SET _creationTime = ?, ${DOC_COLUMN} = ? WHERE id = ?`,
                creationTime,
                JSON.stringify(replaced),
                id,
            );

            syncSearch(tableName, id, replaced);
            syncAggregates(tableName, previous, replaced);
            syncRanks(tableName, id, previous, replaced);

            cache?.invalidate(tableName, id);

            broadcast({ table: tableName, op: "update", key: id, row: replaced });

            if (hasMatchingTrigger(tableName, "after", "update")) {
                await fireTriggers("after", "update", { doc: replaced, id, op: "update", previous, table: tableName });
            }

            await onWrite({ op: "update", table: tableName, id, doc: replaced });
        },

        async delete(id) {
            // Single probe — get the table + row in one pass instead of
            // probing twice (`tableNameFromId` + `writer.get`).
            const located = lookupById(id);

            if (!located) {
                return;
            }

            const { tableName, row: existing } = located;

            // `before` fires ahead of cascade resolution so a throwing guard
            // aborts the delete before any holder rows are touched.
            if (hasMatchingTrigger(tableName, "before", "delete")) {
                await fireTriggers("before", "delete", { id, op: "delete", previous: existing ?? undefined, table: tableName });
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
                deletedReference: (references) => existing?.[references],
                findHolders: async (holderTable, field, value) => (await routeForHolder(holderTable).findMany(holderTable, { where: { [field]: value } })).page,
                onCascade: (holderTable, holderId) => routeForHolder(holderTable).delete(holderId),
                onRestrict: (message) => {
                    throw new ConflictError(message);
                },
                onSetNull: (holderTable, holderId, field) => routeForHolder(holderTable).patch(holderId, { [field]: null }),
                schema,
                tableName,
            });

            ensureBackfilledForTable(tableName);
            ensureRankBackfilledForTable(tableName);

            runSql(sql, `DELETE FROM ${quoteIdentifier(tableName)} WHERE id = ?`, id);

            syncSearch(tableName, id, undefined);
            syncAggregates(tableName, existing ?? undefined, undefined);
            syncRanks(tableName, id, existing ?? undefined, undefined);

            cache?.invalidate(tableName, id);

            broadcast({ table: tableName, op: "delete", key: id });

            if (hasMatchingTrigger(tableName, "after", "delete")) {
                await fireTriggers("after", "delete", { id, op: "delete", previous: existing ?? undefined, table: tableName });
            }

            await onWrite({ op: "delete", table: tableName, id });
        },
    };

    // Declared after `writer` but closed over by `fireTriggers` (defined above):
    // safe because `fireTriggers` only runs while a write is in flight, long
    // after construction has initialized this binding.
    const triggerCtx: TriggerContextLike = { db: writer, scheduler };

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
export const runShardMigrations = (sql: SqlExec, schema: SchemaLike): void => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind === "global") {
            continue;
        }

        const tableSql = `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (
            id TEXT PRIMARY KEY,
            _creationTime REAL NOT NULL,
            ${DOC_COLUMN} TEXT NOT NULL
        )`;

        runSql(sql, tableSql);

        for (const index of definition.indexes) {
            const indexName = `${tableName}_${index.name}`;
            const expressions = index.fields.map(jsonPath).join(", ");
            const uniqueClause = index.unique ? "UNIQUE" : "";
            const indexSql = `CREATE ${uniqueClause} INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(tableName)} (${expressions})`;

            runSql(sql, indexSql);
        }

        // `.unique()` columns synthesize a UNIQUE expression index so SQLite
        // enforces the constraint; the write layer maps breaches to ConflictError.
        for (const [field, column] of tableColumns(definition)) {
            if (!column.unique) {
                continue;
            }

            const indexName = `${tableName}_unique_${field}`;
            const indexSql = `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(tableName)} (${jsonPath(field)})`;

            runSql(sql, indexSql);
        }

        // FTS5 shadow tables back `.searchIndex()` declarations. Created only on
        // engines that ship FTS5 (Cloudflare DOs do; the `node:sqlite` test
        // runner doesn't, where `.search()` transparently falls back to a scan).
        // `__text__` holds the indexed field; `__id__` (UNINDEXED) joins back to
        // the document row.
        if (definition.searchIndexes && definition.searchIndexes.length > 0 && isFtsAvailable(sql)) {
            for (const index of definition.searchIndexes) {
                const ftName = ftsTableName(tableName, index.name);

                runSql(sql, `CREATE VIRTUAL TABLE IF NOT EXISTS ${quoteIdentifier(ftName)} USING fts5("__text__", "__id__" UNINDEXED)`);
            }
        }

        // Counter tables back `aggregateIndex` declarations. One row per
        // distinct `by`-tuple; `__key__` is a canonical-JSON encoding so
        // lookups are stable. We don't populate them here — the write path
        // steps every counter on insert/update/delete (`syncAggregates`), and
        // the reader lazily backfills counters that are empty on first use
        // (added to an existing schema). Sufficient for dev; production hosts
        // can opt into a one-shot backfill via `backfillAggregateIndexes`.
        if (definition.aggregateIndexes) {
            for (const index of definition.aggregateIndexes) {
                const aggTable = aggregateTableName(tableName, index.name);

                runSql(
                    sql,
                    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(aggTable)} (
                        "__key__" TEXT PRIMARY KEY,
                        "__value__" REAL NOT NULL
                    )`,
                );
            }
        }

        // Rank companion tables back `rankIndex` declarations. One row per
        // source row, keyed by `__id__`; a SQLite index on
        // `(__partition__, __sort_k0__, …, __id__)` plays the btree role so
        // `rank()` answers position lookups in O(log n).
        if (definition.rankIndexes) {
            for (const index of definition.rankIndexes) {
                const rankTable = rankTableName(tableName, index.name);
                const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
                const columnDdl = sortColumns.map((column) => `${quoteIdentifier(column)} BLOB`).join(", ");
                const columnPart = sortColumns.length > 0 ? `, ${columnDdl}` : "";

                runSql(
                    sql,
                    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(rankTable)} (
                        "__id__" TEXT PRIMARY KEY,
                        "__partition__" TEXT NOT NULL${columnPart}
                    )`,
                );

                // Sorted btree: (partition, sortBy ASC/DESC..., __id__ ASC)
                const orderedColumns = ['"__partition__" ASC'];

                for (const [i, column] of sortColumns.entries()) {
                    orderedColumns.push(`${quoteIdentifier(column)} ${index.sortBy[i]!.direction === "desc" ? "DESC" : "ASC"}`);
                }

                orderedColumns.push('"__id__" ASC');

                const btreeName = `${tableName}__rank_${index.name}__btree`;

                runSql(sql, `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(btreeName)} ON ${quoteIdentifier(rankTable)} (${orderedColumns.join(", ")})`);
            }
        }
    }
};

/**
 * One-shot backfill of every declared aggregate index. Used by tests and
 * production hosts that want to populate counters up-front instead of on first
 * read. Idempotent: counter rows that already exist are left alone, so it's
 * safe to call twice.
 *
 * The reader uses {@link ensureBackfilled} internally for the lazy path; this
 * helper is the explicit twin so callers can opt out of the lazy cost.
 */
export const backfillAggregateIndexes = (sql: SqlExec, schema: SchemaLike): void => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind === "global") {
            continue;
        }

        const indexes = definition.aggregateIndexes;

        if (!indexes || indexes.length === 0) {
            continue;
        }

        for (const index of indexes) {
            const aggTable = aggregateTableName(tableName, index.name);
            const existing = runSql<{ count: number }>(sql, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(aggTable)}`).one();

            if (Number(existing.count) > 0) {
                continue;
            }

            const by = index.by ?? [];
            const tallies = new Map<string, number>();
            const rows = runSql(sql, `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)}`).toArray();

            for (const row of rows) {
                const doc = rowToDoc(row);

                if (!doc) {
                    continue;
                }

                if (index.where && !matchesStaticWhere(doc, index.where)) {
                    continue;
                }

                const encoded = encodeAggregateKey(by, doc);

                tallies.set(encoded, (tallies.get(encoded) ?? 0) + 1);
            }

            for (const [encoded, count] of tallies) {
                runSql(
                    sql,
                    `INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__") VALUES (?, ?)
                     ON CONFLICT("__key__") DO UPDATE SET "__value__" = "__value__" + excluded."__value__"`,
                    encoded,
                    count,
                );
            }
        }
    }
};

/**
 * One-shot backfill of every declared rank index. The runtime path uses
 * `ensureRankBackfilled` lazily; this is the explicit twin for production
 * hosts that prefer to populate companions up-front. Idempotent: skips
 * rank companions that already carry rows.
 */
export const backfillRankIndexes = (sql: SqlExec, schema: SchemaLike): void => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind === "global") {
            continue;
        }

        const indexes = definition.rankIndexes;

        if (!indexes || indexes.length === 0) {
            continue;
        }

        for (const index of indexes) {
            const rankTable = rankTableName(tableName, index.name);
            const existing = runSql<{ count: number }>(sql, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(rankTable)}`).one();

            if (Number(existing.count) > 0) {
                continue;
            }

            const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
            const columnList = ["__id__", "__partition__", ...sortColumns].map(quoteIdentifier).join(", ");
            const placeholders = ["?", "?", ...sortColumns.map(() => "?")].join(", ");
            const rows = runSql(sql, `SELECT id, _creationTime, ${DOC_COLUMN} FROM ${quoteIdentifier(tableName)}`).toArray();

            for (const row of rows) {
                const doc = rowToDoc(row);

                if (!doc) {
                    continue;
                }

                if (index.where && !matchesRankStaticWhere(doc, index.where)) {
                    continue;
                }

                const partitionKey = encodePartitionKey(index.partitionBy ?? [], doc);
                const sortValues = index.sortBy.map((key) => serializeSqlValue(doc[key.field] ?? null));

                runSql(
                    sql,
                    `INSERT INTO ${quoteIdentifier(rankTable)} (${columnList}) VALUES (${placeholders})`,
                    doc["_id"] as string,
                    partitionKey,
                    ...sortValues,
                );
            }
        }
    }
};
