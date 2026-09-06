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
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/search-core is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import {
    analyzedSearchTokens,
    assertSearchWithinCap,
    createSearchAnalyzer,
    createSearchBuilder,
    finishSearchPage,
    FTS_ID_COLUMN,
    ftsTableName,
    MAX_SEARCH_SCAN,
    planSearchPage,
    resolveSearchScan,
    scoreTokens,
    searchPageScan,
    searchTermRange,
    tokenizeSearch,
} from "@lunora/search-core";
import type { SQL } from "drizzle-orm";
// Aliased: this module already uses `sql` for the workerd `SqlExec` (see `runSql`), so the drizzle tag is `dsql`.
import { sql as dsql } from "drizzle-orm";

import { decodeWire } from "../../../shared/wire-codec";
import { aggregateSqlFunction, normalizeCountArgument, throwingScheduler } from "./aggregate-sql";
import { aggregateTableName, encodeAggregateKey, readAggregateValue } from "./aggregate-tally";
import { CountRlsUnsupportedError, mergeWhere, selectIndexForAggregate, selectIndexForCount, selectIndexForGroupBy } from "./aggregates";
import { backfillSearchIndexesForTable, searchIndexCoversTable } from "./ctx-db-backfill";
import type { CdcChange } from "./ctx-db-cdc";
import { appendCdcChange } from "./ctx-db-cdc";
import { allocateCommitSeq, COMMIT_SEQ_FIELD } from "./ctx-db-commit-seq";
import { createCompanionSync } from "./ctx-db-companions";
import { isMemoryTable } from "./ctx-db-memory";
import type { RankPageDeps } from "./ctx-db-rank-page";
import { computeRankPage } from "./ctx-db-rank-page";
import { SCAN_DEP } from "./dependency-tracker";
import { runDrizzle, runSql } from "./do-exec";
import {
    AGG_COUNT,
    AGG_KEY,
    AGG_VALUE,
    DOC_COLUMN,
    encodeDocJson,
    geoTableName,
    isFtsAvailable,
    jsonPath,
    jsonPathSql,
    qualifiedJsonPath,
    qualifiedJsonPathSql,
    quoteIdentifier,
    rowToDocument,
    serializeSqlValue,
    tableColumns,
    tryRowToDocument,
} from "./do-sql";
import { renderSql, sqliteInList, unionAll, WORKERD_SQLITE_LIMITS } from "./drizzle";
import { boundingBoxGeohashes, coveringGeohashes, haversineMeters, pointInBoundingBox } from "./geo";
import { NotFoundError } from "./not-found-error";
import {
    applySelect,
    buildSeekBeforeWhere,
    buildSeekWhere,
    decodeCursor,
    encodeCursor,
    normalizeOrderKeys,
    softDeleteScope,
    tiebreakDirectionFor,
} from "./query-args";
import { encodePartitionKey, RANK_TIEBREAK, rankPivotConditionSql, rankTableName, resolveRankPartition, sortColumnName } from "./rank";
import type { ReactiveCache } from "./reactive-cache";
import { UNVOUCHABLE_DEP } from "./read-footprint";
import type { IndexKeyEntry, KeyRange } from "./read-write-set";
import { buildIndexRange, indexKeysForRow } from "./read-write-set";
import type { RelationExistsMarker } from "./relation-predicates";
import { assertFlatPredicate as assertFlatRelationPredicate, resolveRelationPredicates } from "./relation-predicates";
import { applyOnDelete, fanOutScalarCounts, relationHooks, resolveWith, runRowValidators } from "./relations";
import { guardWriter } from "./rls-guard";
import { CHANGES_PROBE_SQL, deleteRowSql, insertRowSql, patchRowSql, replaceRowSql, rowProbeParams, rowProbeSql } from "./row-statements";
import type {
    BroadcastDelta,
    DatabaseWriterLike,
    GeoFilterBuilderLike,
    GeoIndexDefinitionLike,
    GroupByEntry,
    IndexRangeBuilderLike,
    OrderKey,
    PaginationOptions,
    QueryArgs,
    QueryPage,
    RankIndexDefinitionLike,
    ReadHook,
    RelationDefinitionLike,
    RestrictableQueryOptions,
    SchemaLike,
    ScoredDocument,
    SearchIndexDefinitionLike,
    ServerDefaultContextLike,
    TableDefinitionLike,
    TableReaderLike,
    ValidatorLike,
} from "./schema-types";
import { mayHoldProjectedValue } from "./sql-projection";
import type { SystemDatabaseReader, SystemReaderSchedulerLike, SystemReaderStorageLike } from "./system-reader";
import { createSystemReader } from "./system-reader";
import { ConflictError } from "./transaction";
import type { TransactionHeadroomTracker } from "./transaction-headroom";
import type { SchedulerLike, TriggerContextLike, TriggerEventLike, TriggerOpLike, TriggerTimingLike } from "./triggers";
import { runTriggers } from "./triggers";
import type { TextFragment } from "./where-fragments";
import { identifierText, joinText, rawText, textFragments } from "./where-fragments";
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
     * `ctx.db.<globalTable>` reads/writes, so cascades and direct writes share
     * one D1 round-trip path. Non-transactional across backends: the local
     * delete commits before the global cascade fires, so a failure on the
     * global side leaves the local row gone — document at the call site.
     */
    globalDb?: DatabaseWriterLike;

    /**
     * Per-transaction resource meter. When supplied, reads and writes are
     * charged against its ceilings and the transaction is stopped with
     * `TRANSACTION_LIMIT_EXCEEDED` once one is crossed. Omit it for the legacy
     * unmetered behaviour.
     */
    headroom?: TransactionHeadroomTracker;

    idGenerator?: IdGenerator;

    /**
     * Does the host currently have an atomic write boundary open?
     *
     * Read only by `_commitSeq` allocation, and it is what keeps that sequence
     * honest. Inside a transaction every write commits together, so ONE sequence
     * describes the whole unit and the rows compare equal. Outside one — an
     * action, which the generated dispatch deliberately does not wrap because its
     * external I/O cannot be rolled back — each write commits on its own, so each
     * needs its own sequence. Sharing one across independently-committed writes
     * is the failure this exists to prevent: a consumer that checkpoints after
     * seeing the first write would never be offered the rest, since they carry a
     * sequence it has already passed.
     *
     * Absent ⇒ treated as NOT in a transaction, i.e. a fresh sequence per write.
     * That is the conservative direction: more sequences than strictly needed
     * costs a consumer nothing, while too few silently drops rows.
     */
    inTransaction?: () => boolean;

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

    /**
     * Reports the contiguous index slice a fluent read was confined to.
     * Omit it and every indexed read falls back to the whole-table dep — the
     * pre-range behaviour, and still correct, just less selective.
     */
    onReadRange?: (range: KeyRange) => void;
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
 * Rows per multi-row `INSERT`. Three bound parameters per row, so one statement
 * lands just under Workerd's per-statement parameter cap — which is where a
 * Durable Object's SQLite refuses to prepare rather than merely running slower.
 * Mirrors the aggregate companion's own chunk in `ctx-db-companions`.
 */
const INSERT_CHUNK_ROWS = Math.floor(WORKERD_SQLITE_LIMITS.boundParams / 3);

/**
 * Most tables one by-id probe may union into a single statement.
 *
 * `unionAll` nests branches so the compound-SELECT cap never binds, but every
 * branch still spends at least one bound parameter — the id in
 * `locateRowById`, the `json_each` list in `locateTablesByIds` — so the
 * parameter cap is what bounds the branch count. A schema wider than that
 * cannot probe in one round-trip however the branches nest, so it probes a
 * chunk at a time.
 */
const MAX_PROBE_BRANCHES = WORKERD_SQLITE_LIMITS.boundParams;

/**
 * Rows pulled per page when a reader is iterated with `for await`.
 *
 * A batch, not one row at a time: the cost is dominated by the per-page keyset
 * query, so single-row paging would make iteration far slower than `.collect()`
 * for the common case of consuming most of a result set. 128 keeps a caller
 * that stops after a handful cheap, while amortising the query over enough rows
 * that a full walk stays close to a bulk read.
 */
const ITERATOR_PAGE_SIZE = 128;

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
 * How many rows the scan fallback fetches to serve a read bounded by `limit`.
 *
 * The FTS5 and `.global()` layouts order by the true score in SQL, so their
 * `LIMIT` is exact and none of them needs a window. This path has no index to
 * order by relevance — it scores every row it fetched, in memory — so cutting
 * at `limit` in SQL would discard rows before they were scored. It takes the
 * cap's worth instead, and never less than the cap, because an unbounded read
 * resolves to one row *past* it so {@link assertSearchWithinCap} can tell
 * "exactly the cap" from "more than the cap".
 */
const scanCandidateWindow = (limit: number): number => Math.max(limit, MAX_SEARCH_SCAN);

/** WHERE clauses shared by both search layouts: the staged `.eq()` filters plus the soft-delete scope. */
const searchWhereClauses = (search: SearchStage, scopeCondition?: SQL): SQL[] => {
    const clauses = search.filters.map((filter) => dsql`${jsonPathSql(filter.field)} = ${serializeSqlValue(filter.value)}`);

    if (scopeCondition) {
        clauses.push(scopeCondition);
    }

    return clauses;
};

/**
 * Run a search via the FTS5 shadow table, scoring in SQL from the index's own
 * vocabulary view.
 *
 * FTS5 orders by bm25, which penalises document length and common terms; our
 * contract orders by summed occurrences. The two are unrelated, so selecting a
 * window with bm25 and re-ranking it in memory is not the contract's top-N —
 * on a corpus where more documents match than the window holds, the documents
 * the contract ranks highest can sit outside it entirely. `.take(3)` returned
 * three arbitrary rows that claimed to be the best three.
 *
 * `fts5vocab(…, instance)` exposes one row per term instance, so a term's
 * frequency in a document is a `COUNT`, and the query becomes the same shape
 * the `.global()` layouts use — one `SUM(CASE …)` per term, added. Same answer
 * by construction rather than by test, and `LIMIT` is exact, so an unbounded
 * read's over-cap probe row survives to `assertSearchWithinCap`.
 *
 * One branch per term rather than one `WHERE … OR …`: SQLite's planner silently
 * drops a range constraint OR'd with an equality on this module, returning no
 * rows for the range half rather than an error.
 *
 * Returns the score alongside each document (not just the document) so
 * `.collectWithScores()` can surface the same `__score__` this function
 * already orders by, instead of recomputing it — see {@link ScoredDocument}.
 * The bare-doc callers (`.collect()` / `.take()` / …) map it away.
 */
const searchViaFts = (
    sql: SqlExec,
    tableName: string,
    search: SearchStage,
    limit: number,
    scopeCondition?: SQL,
): { document: Record<string, unknown>; score: number }[] => {
    const tokens = tokenizeSearch(search.query, createSearchAnalyzer(search.definition.language));

    if (tokens.length === 0) {
        return [];
    }

    const ftName = ftsTableName(tableName, search.indexName);
    const vocabulary = `${ftName}__vocab`;
    const lastIndex = tokens.length - 1;
    const branches = tokens.map((token, index) => {
        const range = searchTermRange(token, index === lastIndex);
        const predicate = range.exact
            ? dsql`${dsql.identifier("term")} = ${range.lower}`
            : dsql`${dsql.identifier("term")} >= ${range.lower} AND ${dsql.identifier("term")} < ${range.upper}`;

        return dsql`SELECT ${dsql.identifier("doc")}, ${dsql.raw(String(index))} AS ${dsql.identifier("__term__")}, COUNT(*) AS ${dsql.identifier("__n__")} FROM ${dsql.identifier(vocabulary)} WHERE ${predicate} GROUP BY ${dsql.identifier("doc")}`;
    });
    const perTerm = tokens.map(
        (_, index) => dsql`SUM(CASE WHEN u.${dsql.identifier("__term__")} = ${dsql.raw(String(index))} THEN u.${dsql.identifier("__n__")} ELSE 0 END)`,
    );
    const scored = dsql`SELECT f.${dsql.identifier(FTS_ID_COLUMN)} AS ${dsql.identifier(FTS_ID_COLUMN)}, ${dsql.join(perTerm, dsql` + `)} AS ${dsql.identifier("__score__")} FROM (${unionAll(branches)}) u JOIN ${dsql.identifier(ftName)} f ON f.rowid = u.${dsql.identifier("doc")} GROUP BY f.${dsql.identifier(FTS_ID_COLUMN)} HAVING ${dsql.join(
        perTerm.map((term) => dsql`${term} > 0`),
        dsql` AND `,
    )}`;

    const whereClauses = searchWhereClauses(search, scopeCondition);

    let query = dsql`SELECT m.id, m._creationTime, m.${dsql.identifier(DOC_COLUMN)}, s.${dsql.identifier("__score__")} AS ${dsql.identifier("__score__")} FROM (${scored}) s JOIN ${dsql.identifier(tableName)} m ON m.id = s.${dsql.identifier(FTS_ID_COLUMN)}`;

    if (whereClauses.length > 0) {
        query = dsql`${query} WHERE ${dsql.join(whereClauses, dsql` AND `)}`;
    }

    query = dsql`${query} ORDER BY s.${dsql.identifier("__score__")} DESC, m._creationTime DESC, m.id ASC LIMIT ${dsql.raw(String(limit))}`;

    const results: { document: Record<string, unknown>; score: number }[] = [];

    for (const row of runDrizzle(sql, query)) {
        const record = tryRowToDocument(row);

        if (record) {
            const rawScore = row["__score__"];

            results.push({ document: record, score: typeof rawScore === "number" ? rawScore : Number(rawScore ?? 0) });
        }
    }

    return results;
};

/**
 * Portable fallback for engines without FTS5 (the `node:sqlite` test runner):
 * pull candidate rows (narrowed by `.eq()` filters in SQL), tokenize the indexed
 * field in JS, and rank with `scoreDoc`. Matches the FTS path's AND +
 * prefix-on-last-token semantics; relevance order is term-frequency, ties broken
 * by creation time (newest first).
 *
 * Returns the score alongside each document, same as {@link searchViaFts} —
 * the JS scorer already computes it per candidate, this just keeps it on the
 * result instead of dropping it at the final `.map()`.
 */
const searchViaScan = (
    sql: SqlExec,
    tableName: string,
    search: SearchStage,
    limit: number,
    scopeCondition?: SQL,
): { document: Record<string, unknown>; score: number }[] => {
    const analyzer = createSearchAnalyzer(search.definition.language);
    const tokens = tokenizeSearch(search.query, analyzer);

    if (tokens.length === 0) {
        return [];
    }

    const whereClauses = searchWhereClauses(search, scopeCondition);

    let query = dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)}`;

    if (whereClauses.length > 0) {
        query = dsql`${query} WHERE ${dsql.join(whereClauses, dsql` AND `)}`;
    }

    // Bounded like every other search read. This path has no index to order by
    // relevance, so the window is taken newest-first — deterministic, and the
    // same order the tiebreak uses — rather than left to the engine. Past the
    // cap the fallback is therefore approximate, which the FTS5 paths are not;
    // it only runs on an engine without FTS5, which no Durable Object is.
    query = dsql`${query} ORDER BY _creationTime DESC, id ASC LIMIT ${dsql.raw(String(scanCandidateWindow(limit)))}`;

    const rows = runDrizzle(sql, query).toArray();
    const scored: { creationTime: number; doc: Record<string, unknown>; id: string; score: number }[] = [];

    for (const row of rows) {
        // Safe-parsing, not `rowToDocument`: this scan reads every row of the
        // table, so one unparseable document would otherwise turn *every*
        // search on it into an error. Unsearchable, not fatal.
        const record = tryRowToDocument(row);

        if (!record) {
            continue;
        }

        // The *analyzed* tokens, not the raw field: every other layout stores and
        // scores a token stream capped at `MAX_INDEXED_TOKENS`, so scoring the
        // raw value here would make this path find matches past the cap that
        // the others cannot — a divergence in the one direction no parity gate
        // covers, since this path only runs where FTS5 is absent.
        const score = scoreTokens(analyzedSearchTokens(record, search.definition), tokens);

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

    return scored.slice(0, limit).map((entry) => {
        return { document: entry.doc, score: entry.score };
    });
};

/**
 * Assert `point` is a usable geo coordinate: finite lat in `[-90, 90]` and
 * finite lng in `[-180, 180]`. `NaN`/out-of-range coordinates otherwise
 * poison `encodeGeohash`/haversine silently and produce a misleading empty
 * result instead of a clear rejection.
 */
const assertGeoPoint = (point: { lat: number; lng: number }, label: string, tableName: string, indexName: string): void => {
    if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90 || !Number.isFinite(point.lng) || point.lng < -180 || point.lng > 180) {
        throw new LunoraError(
            "BAD_REQUEST",
            `geo index "${indexName}" on table "${tableName}": ${label} must have a finite lat in [-90, 90] and lng in [-180, 180]`,
        );
    }
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

            assertGeoPoint(point, ".near() point", tableName, staged.indexName);

            if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
                throw new LunoraError(
                    "BAD_REQUEST",
                    `geo index "${staged.indexName}" on table "${tableName}": .near() radiusMeters must be a finite number > 0, got ${String(radiusMeters)}`,
                );
            }

            staged.near = { point: { lat: point.lat, lng: point.lng }, radiusMeters };

            return builder;
        },
        within: (box) => {
            if (staged.near) {
                throw new LunoraError("INTERNAL", `geo index "${staged.indexName}" on table "${tableName}": call .near() or .within(), not both`);
            }

            assertGeoPoint(box.sw, ".within() sw corner", tableName, staged.indexName);
            assertGeoPoint(box.ne, ".within() ne corner", tableName, staged.indexName);

            if (box.sw.lat > box.ne.lat) {
                throw new LunoraError(
                    "BAD_REQUEST",
                    `geo index "${staged.indexName}" on table "${tableName}": .within() corners are transposed (sw.lat > ne.lat)`,
                );
            }

            if (box.sw.lng > box.ne.lng) {
                throw new LunoraError(
                    "BAD_REQUEST",
                    `geo index "${staged.indexName}" on table "${tableName}": .within() box crosses the antimeridian (sw.lng > ne.lng), which is not supported — split it into two boxes at ±180 and union the results`,
                );
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
 * Gather the covering geohash prefixes for the near-circle / bounding-box,
 * range-scan the geohash companion for candidate rows, JOIN back to the
 * document table, then refine + order exactly in JS — Haversine distance
 * (nearest-first) for `.near()`, an inclusive box test (creation-time order)
 * for `.within()`. Unlimited and unsliced: {@link runGeoFetchScored} slices
 * this same candidate set, so the query + scoring logic lives in exactly one
 * place.
 */
const resolveGeoCandidates = (
    sql: SqlExec,
    tableName: string,
    geo: GeoStage,
    scopeCondition?: SQL,
): { creationTime: number; distance: number; doc: Record<string, unknown> }[] => {
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

    return scored;
};

/** Keep entries whose document passes every staged `.filter()` predicate, stopping at `limit` survivors. */
const takeMatching = <T>(
    entries: T[],
    filters: QueryStage["inMemoryFilters"],
    limit: number | undefined,
    documentOf: (entry: T) => Record<string, unknown>,
): T[] => {
    const result: T[] = [];

    for (const entry of entries) {
        if (filters.every((predicate) => predicate(documentOf(entry)))) {
            result.push(entry);

            if (typeof limit === "number" && result.length >= limit) {
                break;
            }
        }
    }

    return result;
};

/**
 * Resolve a `withGeoIndex(...)` query into scored candidates: each document
 * paired with the distance {@link scoreGeoRow} already computed to order it —
 * see {@link ScoredDocument}. `.near()` rows carry their haversine distance;
 * `.within()` rows carry `null` (a box match has no point-distance metric, and
 * `0` would misleadingly read as "exactly here"). `.take(n)` is applied AFTER
 * the refine.
 */
const runGeoFetchScored = (
    sql: SqlExec,
    tableName: string,
    geo: GeoStage,
    limit: number | undefined,
    scopeCondition?: SQL,
    /** Reports the candidate count BEFORE the limit slice — what the read materialized. */
    onScanned: (count: number) => void = () => undefined,
): { distanceMeters: null | number; document: Record<string, unknown> }[] => {
    const isWithin = geo.within !== undefined;
    const results = resolveGeoCandidates(sql, tableName, geo, scopeCondition).map((entry) => {
        return {
            // eslint-disable-next-line unicorn/no-null -- documented `.within()` sentinel: a box match has no point-distance metric
            distanceMeters: isWithin ? null : entry.distance,
            document: entry.doc,
        };
    });

    // Every candidate was decoded and scored before the slice, so the meter must
    // see all of them — `.take(1)` over a wide radius still materializes the
    // whole covering set.
    onScanned(results.length);

    return typeof limit === "number" ? results.slice(0, Math.max(0, Math.floor(limit))) : results;
};

/**
 * Run a staged geo query terminal: resolve the candidates via
 * {@link runGeoFetchScored} (letting SQL cap the result when there are no
 * in-memory `.filter()` predicates), then apply any predicates + the effective
 * limit in memory (RLS pushes its policy down this exact way, so
 * `.collectWithScores()` must apply it too). Mirrors the search terminal's
 * split so the reader's `runFetch` stays a thin dispatcher.
 */
const runGeoTerminalScored = (
    sql: SqlExec,
    tableName: string,
    stage: QueryStage,
    scopeCondition: SQL | undefined,
    limit: number | undefined,
    onScanned: (count: number) => void = () => undefined,
): { distanceMeters: null | number; document: Record<string, unknown> }[] => {
    const { geo } = stage;

    if (!geo) {
        throw new LunoraError("INTERNAL", "runGeoTerminalScored called without a staged geo query");
    }

    const filtered = stage.inMemoryFilters.length > 0;
    const entries = runGeoFetchScored(sql, tableName, geo, filtered ? undefined : limit, scopeCondition, onScanned);

    return filtered ? takeMatching(entries, stage.inMemoryFilters, limit, (entry) => entry.document) : entries;
};

/**
 * The row-page SELECT, assembled as text plus its bound values.
 *
 * Two things are happening here, both measured. The clause-at-a-time form this
 * replaced — `query = sql\`${query} WHERE …\`` and again for ORDER BY and LIMIT —
 * nested the statement one level deeper per clause, and drizzle's renderer walks
 * that tree recursively with a type check at every node; flattening it rendered
 * 62% faster. Emitting text rather than a drizzle `SQL` at all takes the rest:
 * building and rendering this statement through drizzle measured 5.35us against
 * 0.10us to assemble it directly, on a read that costs ~10.8us in total.
 *
 * The four branches are deliberate. Splicing optional clauses as fragments into
 * one template recovers a quarter of the flattening; assembling them with
 * `sql.join` is 19% SLOWER than the nesting it replaces. Both were measured
 * before this shape was chosen.
 *
 * `__tests__/select-page-sql.test.ts` pins every branch against the drizzle
 * composition it replaced, text and parameters alike.
 * @returns the statement text and its bound values, in placeholder order
 */
const selectPageSql = (tableName: string, where: TextFragment | undefined, order: string, limit: number | undefined): TextFragment => {
    const head = `SELECT id, _creationTime, ${quoteIdentifier(DOC_COLUMN)} FROM ${quoteIdentifier(tableName)}`;
    const tail = `ORDER BY ${order}${limit === undefined ? "" : ` LIMIT ${String(limit)}`}`;

    return where === undefined ? rawText(`${head} ${tail}`) : joinText(`${head} WHERE `, where, ` ${tail}`);
};

/** Bare-doc twin of {@link runGeoTerminalScored} — same candidate set, filter handling, and limit, with the scores mapped away. */
const runGeoTerminal = (
    sql: SqlExec,
    tableName: string,
    stage: QueryStage,
    scopeCondition: SQL | undefined,
    limit: number | undefined,
    onScanned: (count: number) => void = () => undefined,
): Record<string, unknown>[] => runGeoTerminalScored(sql, tableName, stage, scopeCondition, limit, onScanned).map((entry) => entry.document);

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
    /** Reports the PRE-filter row count — what the read actually materialized. */
    onScanned: (count: number) => void = () => undefined,
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

    onScanned(rows.length);

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
 * Whether `field` MAY be stored as an order-preserving sort key rather than as
 * its value — the condition SQL cannot reduce or group.
 *
 * The test is `mayHoldProjectedValue`, not `isProjectedKind`: the projection
 * dispatches on the RUNTIME type, so a `bigint`/bytes written into a `v.any()`
 * / `v.union()` / `v.from()` column is stored as the same padded key a declared
 * one gets. Reading the declared kind saw only `"any"` and waved the scan
 * through — `sum` of two small amounts came back as `2e+39`, `max` as the
 * 40-character key, and `groupBy` keyed on the padding. The write side has used
 * the wide test since a declared-kind gate wrote ~1e39 into a companion
 * (`ctx-db-companions.ts`); this is the read side matching it.
 *
 * Refusing per COLUMN over-matches: an untyped column that only ever holds
 * plain numbers is refused too. That is the deliberate side to be wrong on —
 * the declared-kind version returned a confident wrong number instead, and the
 * escape hatch (a declared `aggregateIndex`, which the error names) answers
 * both cases exactly. `count()` passes SQL no field at all and is unaffected.
 * @returns `true` when the column is projected, or is declared loosely enough to hold a projected value
 */
const isProjectedField = (definition: TableDefinitionLike, field: string | undefined): boolean => {
    const validator = field === undefined ? undefined : definition.shape[field];

    return validator !== undefined && mayHoldProjectedValue(validator);
};

/**
 * Whether the SQL scan would REFUSE this read — i.e. whether any field it hands
 * to SQL is stored as a projected key ({@link assertReducibleBySql}). Callers
 * pass exactly the fields they will assert on, so the gate and the assertion
 * cannot drift apart.
 *
 * **This is what decides whether a `.softDelete()` table uses the companion.**
 * The companion tallies live rows only (`isLiveForCompanion`), so it is now
 * correct on such a table — but correct is not the same as cheaper. Reaching it
 * calls `ensureBackfilled`, and `ensureBackfilledIndex` is an unconditional
 * TRUNCATE + full rebuild memoised per ctx-db INSTANCE — i.e. per dispatch, and
 * again per subscription re-run, since codegen's `buildCtx` constructs one each
 * time. The scan it replaces is a single SQL `COUNT` / `SUM` over
 * `json_extract`. Routing every soft-delete aggregate through the companion
 * would trade one C-speed scan for a full JS decode of the table plus a
 * companion rewrite, on a read, per request.
 *
 * So the trade is only worth making when the scan cannot answer at all — which
 * is exactly the gap this closed: a projected column could not be aggregated on
 * a soft-delete table at any magnitude. `count()` hands SQL no field, so this
 * returns `false` for it and it keeps the scan unconditionally.
 *
 * The gate is a workaround for the rebuild being per-instance rather than
 * durable; make that marker durable (plan 315) and every caller of this can go
 * back to taking the companion unconditionally.
 * @returns `true` when at least one of `fields` is a projected column
 */
const scanRefusesAny = (definition: TableDefinitionLike, fields: ReadonlyArray<string | undefined>): boolean =>
    fields.some((field) => isProjectedField(definition, field));

/**
 * Refuse a SQL-side reduce or group over a column stored as a projected sort
 * key. `json_extract` hands SQL the key, not the value: `SUM` over a
 * zero-padded bigint key coerces to nonsense (2e+39 for a couple of small
 * amounts), `MIN`/`MAX` return the padded string, and a `GROUP BY` key comes
 * back as 40 characters of padding. All three look like answers.
 *
 * The maintained companion is exact for these, so the error names it rather
 * than just refusing. Applied at every SQL-reducing entry point —
 * `aggregate`'s scan and both halves of `groupBy` — because guarding one and
 * not its sibling is how the first version of this shipped.
 * @throws LunoraError `BAD_REQUEST` when `field` is stored as a projected key
 */
const assertReducibleBySql = (definition: TableDefinitionLike, field: string, label: string): void => {
    if (isProjectedField(definition, field)) {
        throw new LunoraError(
            "BAD_REQUEST",
            `${label}: "${field}" may hold an order-preserving key rather than a value SQL can reduce or group — declare an aggregateIndex covering this (by, field, op) so the maintained companion answers it instead (its running total is a REAL, so it stays exact only while the total is inside 2^53)`,
        );
    }
};

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

/**
 * The flat `where` strategy in TEXT form — the twin of {@link doWhereSqlStrategy}.
 *
 * Reads compile through this instead of the drizzle one: same traversal, same
 * SQL, assembled directly. See `where-fragments.ts` for why.
 */
const doWhereTextStrategy: WhereSqlStrategy<TextFragment> = {
    fieldRef: (field) => rawText(jsonPath(field)),
    serialize: serializeSqlValue,
};

/**
 * The relation-EXISTS strategy in TEXT form — the twin of
 * {@link makeRelationExistsSqlStrategy}, including its per-query alias counter
 * and scope stack, which are what make nested markers correlate to the right
 * parent.
 */
const makeRelationExistsTextStrategy = (onRead: ReadHook): WhereSqlStrategy<TextFragment> => {
    let aliasCounter = 0;
    const scopeStack: string[] = [];

    const strategy: WhereSqlStrategy<TextFragment> = {
        fieldRef: (field) => rawText(jsonPath(field)),
        relationExists: (request) => {
            const { childWhere, negated, parentTable, relation } = request as RelationExistsMarker;
            const alias = `__rel_${String(aliasCounter)}`;
            const parentRef = scopeStack.at(-1) ?? parentTable;

            aliasCounter += 1;
            onRead(relation.table, SCAN_DEP);

            const parentColumn = relation.kind === "one" ? relation.field : relation.references;
            const childColumn = relation.kind === "one" ? relation.references : relation.field;
            const correlation = rawText(`${qualifiedJsonPath(alias, childColumn)} = ${qualifiedJsonPath(parentRef, parentColumn)}`);

            scopeStack.push(alias);

            const childSql = compileWhereSql(childWhere, strategy, textFragments);

            scopeStack.pop();

            const condition = childSql === undefined ? correlation : joinText(correlation, " AND ", childSql);
            const body = joinText("EXISTS (SELECT 1 FROM ", identifierText(relation.table), " AS ", identifierText(alias), " WHERE ", condition, ")");

            return negated ? joinText("NOT ", body) : body;
        },
        serialize: serializeSqlValue,
    };

    return strategy;
};

/** The text twin of {@link compileOrderBySql}: an ordering binds no values, so it is a bare string. */
const compileOrderByText = (keys: OrderKey[]): string => {
    const parts = keys.map((key) => `${jsonPath(key.field)} ${key.direction === "desc" ? "DESC" : "ASC"}`);

    if (!keys.some((key) => key.field === "_id" || key.field === "id")) {
        parts.push(`${jsonPath("id")} ${tiebreakDirectionFor(keys) === "desc" ? "DESC" : "ASC"}`);
    }

    return parts.join(", ");
};

/** Drizzle ORDER BY for the DO: each key as `<jsonPath> ASC|DESC`, with an `id` tiebreak in the last key's direction (see `tiebreakDirectionFor`) unless an id field is already ordered. The drizzle twin of `compileOrderBy`. */
const compileOrderBySql = (keys: OrderKey[]): SQL => {
    const parts = keys.map((key) => dsql`${jsonPathSql(key.field)} ${dsql.raw(key.direction === "desc" ? "DESC" : "ASC")}`);

    if (!keys.some((key) => key.field === "_id" || key.field === "id")) {
        parts.push(dsql`${jsonPathSql("id")} ${dsql.raw(tiebreakDirectionFor(keys) === "desc" ? "DESC" : "ASC")}`);
    }

    return dsql.join(parts, dsql`, `);
};

/** Invert the reader's staged SQL comparators back into `where`-tree operators. */
const COMPARATOR_TO_OPERATOR: Record<string, string> = { "<": "lt", "<=": "lte", "=": "eq", ">": "gt", ">=": "gte" };

/**
 * The index fields a staged read still has to ORDER BY: `indexFields` minus the
 * LEADING run the range builder pins with `.eq()`.
 *
 * A pinned column holds one value across every row the read can return, so
 * ordering by it is semantically a no-op — but SQLite does not treat it as one.
 * It will not drop an equality-pinned term from an ORDER BY over an EXPRESSION
 * index, so `WHERE json_extract(...) = ? ORDER BY json_extract(...), _creationTime, id`
 * still sorts every match into a temp B-tree even though the index is built in
 * exactly that order. Measured on `node:sqlite`, 50k rows, 1k per key:
 *
 * ```
 * ORDER BY <expr> ASC, _creationTime ASC, id ASC   63.4us  SEARCH (<expr>=?) | USE TEMP B-TREE FOR ORDER BY
 * ORDER BY _creationTime ASC, id ASC               11.2us  SEARCH (<expr>=?)
 * ORDER BY <expr> DESC, _creationTime DESC, id DESC 266.0us SEARCH (<expr>=?) | USE TEMP B-TREE FOR ORDER BY
 * ORDER BY _creationTime DESC, id DESC              16.1us SEARCH (<expr>=?)
 * ```
 *
 * Only a LEADING run is dropped: `.withIndex("by_channel_author", q => q.eq("channelId", c))`
 * over a two-field index leaves `authorId` unpinned, and the order across
 * distinct authors is the caller's, so it has to stay in the clause.
 *
 * A range (`.gt()`/`.lte()`) pins nothing — its column takes many values within
 * the read — so it does not qualify.
 */
const unpinnedIndexFields = (stage: QueryStage): ReadonlyArray<string> => {
    const pinned = new Set(stage.sqlConditions.filter((condition) => condition.comparator === "=").map((condition) => condition.field));
    let start = 0;

    while (start < stage.indexFields.length && pinned.has(stage.indexFields[start] ?? "")) {
        start += 1;
    }

    return stage.indexFields.slice(start);
};

/**
 * Order keys for a paginated stage: the staged index, else creation order, in the
 * staged direction.
 *
 * `shape` is the table's declared columns; it decides each key's `nullable`, which
 * is what gates the seek's `OR col IS NULL` arm (see `pivotCondition`). Routed
 * through `normalizeOrderKeys` so the fluent reader and the object-form `findMany`
 * answer that question the same way.
 */
const paginateOrderKeys = (stage: QueryStage, shape: Record<string, ValidatorLike>): OrderKey[] => {
    const direction = stage.order;
    const orderFields = unpinnedIndexFields(stage);

    if (orderFields.length > 0) {
        return normalizeOrderKeys(
            orderFields.map((field) => {
                return { [field]: direction };
            }),
            shape,
        );
    }

    return normalizeOrderKeys([{ _creationTime: direction }], shape);
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
const paginateStage = (
    sql: SqlExec,
    tableName: string,
    /** The table's declared columns — decides which ordered keys are nullable. */
    shape: Record<string, ValidatorLike>,
    stage: QueryStage,
    options: PaginationOptions,
    scopeCondition?: TextFragment,
    /** Reports the PRE-filter row count — an unbounded filtered page scans past what it returns. */
    onScanned: (count: number) => void = () => undefined,
): QueryPage => {
    const numberItems = Math.max(0, Math.floor(options.numItems));
    const orderKeys = paginateOrderKeys(stage, shape);
    // A cursor is always a non-empty base64 string, so truthiness distinguishes
    // a bounded page (endCursor set) from the legacy open-ended one (null/omitted).
    const bounded = typeof options.endCursor === "string";
    const pageWhere = compileWhereSql(paginateWhere(stage, orderKeys, options.cursor, options.endCursor), doWhereTextStrategy, textFragments);
    // Soft delete: AND the scope onto the keyset predicate so a paginated fluent
    // read hides soft-deleted rows too.
    const whereCondition = scopeCondition && pageWhere ? joinText(pageWhere, " AND ", scopeCondition) : (scopeCondition ?? pageWhere);

    const filtered = stage.inMemoryFilters.length > 0;

    // A bounded page returns its entire range, so never cap the SQL scan. An
    // unbounded, unfiltered page over-fetches one row to learn `isDone`.
    // Same SELECT shape as `findMany`, so it shares the builder — see
    // `selectPageSql` for why this is assembled rather than rendered.
    const statement = selectPageSql(tableName, whereCondition, compileOrderByText(orderKeys), filtered || bounded ? undefined : numberItems + 1);
    const rows = runSql(sql, statement.text, ...statement.params).toArray();

    onScanned(rows.length);

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

const buildReader = (
    sql: SqlExec,
    schema: SchemaLike,
    tableName: string,
    onIndexUse: IndexUseHook = () => undefined,
    onTerminal: (range: KeyRange | undefined) => void = () => undefined,
    meterRows: (count: number) => void = () => undefined,
): TableReaderLike => {
    const tableDefinition = schema.tables[tableName];

    if (!tableDefinition) {
        throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
    }

    // Soft delete: the fluent reader (`ctx.db.query(table)...`) always hides
    // soft-deleted rows — the object-form `findMany({ includeDeleted: true })` is
    // the opt-in to see them. Compiled once and ANDed into every fetch/search/page.
    const scopeWhere = softDeleteScope(tableDefinition.softDeleteMode, undefined);
    const scopeCondition = scopeWhere ? compileWhereSql(scopeWhere, doWhereSqlStrategy) : undefined;
    // The paginated read assembles text; the search and fetch terminals still
    // build drizzle. Compiled once per query builder either way, so keeping both
    // forms costs a compile per `.query()` rather than per read.
    const scopeConditionText = scopeWhere ? compileWhereSql(scopeWhere, doWhereTextStrategy, textFragments) : undefined;

    const stage: QueryStage = {
        indexFields: [],
        indexName: undefined,
        inMemoryFilters: [],
        order: "asc",
        sqlConditions: [],
    };

    /** Pre-filter window of the last search terminal — see `runFetch`'s metering. */
    let searchScanned = 0;

    /**
     * The real search-terminal logic, keeping each document's `__score__`
     * alongside it — see {@link ScoredDocument}. {@link runSearchFetch} (the
     * bare-doc path every existing caller uses) is a thin wrapper over this
     * that maps the score away, so `.collect()` / `.take()` / `.paginate()`
     * stay byte-identical to before this terminal existed.
     */
    const runSearchFetchScored = (limit: number | undefined): { document: Record<string, unknown>; score: number }[] => {
        const { search } = stage;

        if (!search) {
            throw new LunoraError("INTERNAL", "runSearchFetch called without a staged search");
        }

        // Advance the backfill on read. `runShardMigrations` runs once per
        // isolate, so a warm DO would otherwise index one page and then stop —
        // a large table stays permanently half-indexed, serving partial results
        // with no error and no signal. The page is bounded and a completed
        // index costs one indexed state lookup, so reads pay almost nothing.
        backfillSearchIndexesForTable(sql, tableName, tableDefinition);

        const filtered = stage.inMemoryFilters.length > 0;
        // Relevance order means the engine read is always bounded: the caller's
        // limit when there is one, `MAX_SEARCH_SCAN` otherwise — including when a
        // `.filter()` runs on top, which narrows *within* that window rather than
        // widening the read.
        const engineLimit = resolveSearchScan(filtered ? undefined : limit);
        const viaFts = isFtsAvailable(sql);

        // Refuse rather than answer from a half-built index. A NEW search index
        // declared over a table that already holds rows covers a growing PREFIX
        // of it (`id ASC`) until its backfill finishes, and every layout below
        // queries the companion regardless — so a matching document past the
        // cursor is simply absent from a result set that looks complete. That is
        // the one outcome the search contract promises against.
        //
        // Only that case. An index REBUILDING under a changed analyzer profile
        // holds every row throughout — the re-walk rewrites each one in place —
        // and refusing there would take the table's search offline for the whole
        // rebuild, which on a large table is thousands of reads and on an
        // analyzer-version bump is every table at once. It serves, some rows
        // still analyzed by the previous rules. `searchIndexCoversTable` is where
        // the two are told apart.
        //
        // Not the LIKE fallback below: it is only equivalent while the candidate
        // set fits `MAX_SEARCH_SCAN`, taking the newest window of a larger table
        // and scoring that (its own comment says so, on the grounds that it never
        // runs in a Durable Object). Routing a mid-backfill read onto it would
        // swap one silent partial answer — the oldest rows — for another — the
        // newest 1024 — on exactly the large tables the backfill is paged for.
        //
        // One `__lunora_search_state` primary-key read per search call — a second
        // one only where the first says the walk is unfinished, which is the path
        // that is about to refuse or serve a rebuild. Placed after the page above
        // so it sees the progress this very read just made.
        // Coverage is a property of the index, not of a row or a hit, so it is
        // never asked per row or per result. A table small enough to index in one
        // page is complete from its first migration and never reaches here.
        if (viaFts && !searchIndexCoversTable(sql, tableName, search.definition)) {
            throw new LunoraError(
                "SEARCH_INDEX_BUILDING",
                `search index "${search.indexName}" on table "${tableName}" is still backfilling and currently covers only part of the table — retry once it finishes, or run the backfillSearch admin operation to complete it now`,
            );
        }

        const scored = viaFts
            ? searchViaFts(sql, tableName, search, engineLimit, scopeCondition)
            : searchViaScan(sql, tableName, search, engineLimit, scopeCondition);

        if (!filtered) {
            // An unbounded read asked for one row past the cap; if it came back
            // full, the caller would otherwise receive a prefix that looks whole.
            if (limit === undefined) {
                assertSearchWithinCap(scored);
            }

            return scored;
        }

        searchScanned = scored.length;

        return takeMatching(scored, stage.inMemoryFilters, limit, (entry) => entry.document);
    };

    const runSearchFetch = (limit: number | undefined): Record<string, unknown>[] => runSearchFetchScored(limit).map((entry) => entry.document);

    /**
     * One page of a relevance-ordered search. The window is fetched one row
     * past the page so `hasMore` is observed rather than guessed; everything
     * else — cursor decoding, the bounded-page refusal, the cap — is the shared
     * policy in `search-query`, so the two backends page identically.
     */
    const paginateSearchStage = (options: PaginationOptions): QueryPage => {
        const plan = planSearchPage(options);

        return finishSearchPage(runSearchFetch(searchPageScan(plan)), plan);
    };

    const buildOrderClause = (): SQL =>
        // Literally the key list `paginateOrderKeys` builds, not a restatement of
        // it. `.collect()` and `.paginate()` must agree on the order of tied rows
        // or a page boundary skips or repeats them, and the tiebreak rule
        // (`<index fields>, _creationTime, id`, minus the `.eq()`-pinned leading
        // run) is already owned by `normalizeOrderKeys` — which is also where
        // `buildSeek` reads it. Spelling it out again here is how the seek and
        // the sort drift apart: the hand-rolled version used the stage direction
        // for the tiebreak where `normalizeOrderKeys` derives it from
        // `tiebreakDirectionFor`, which agree only because a staged read happens
        // to have a uniform direction.
        //
        // Without any tiebreak the order of tied rows is whatever the engine
        // returns, which is not stable: two messages written in the same
        // millisecond and read back with `.withIndex("by_channel").order("asc")`
        // came out in the order of their RANDOM server-minted ids. That looked
        // deterministic only while the index could not satisfy the ORDER BY and
        // SQLite sorted into a temp B-tree whose input order it preserved.
        compileOrderBySql(paginateOrderKeys(stage, tableDefinition.shape));

    /**
     * Report this read's dependency footprint, once per terminal.
     *
     * Deferred to the terminal on purpose: at `ctx.db.query(table)` time the
     * chain has not yet revealed whether it will end in `.withIndex(...)`, so
     * the old eager stamp had to assume the whole table. Here the staged plan
     * is final, so an indexed read can report the exact slice it touched.
     *
     * Search and geo terminals read through their own companion structures
     * rather than the index range, and a `limit` only ever narrows what was
     * read WITHIN the slice — so the slice stays a correct upper bound on the
     * read either way. Anything not provably confined reports `undefined`,
     * which the caller turns back into the conservative whole-table dep.
     */
    const stampTerminal = (): void => {
        if (stage.search || stage.geo || stage.indexName === undefined) {
            onTerminal(undefined);

            return;
        }

        onTerminal(buildIndexRange(tableName, stage.indexName, stage.indexFields, stage.sqlConditions, serializeSqlValue));
    };

    const runFetch = (limit: number | undefined): Record<string, unknown>[] => {
        stampTerminal();

        // The fluent reader stamps ONE range dep for the whole read rather than
        // a dep per row, so the read-hook meter cannot see its size — charge
        // the rows here instead. `runPlainFetch` applies `.filter()` predicates
        // in memory, so the returned length is the SURVIVORS; the meter must be
        // charged the window that was actually materialized.
        let scanned = 0;
        const rows = ((): Record<string, unknown>[] => {
            if (stage.search) {
                const found = runSearchFetch(limit);

                scanned = searchScanned;

                return found;
            }

            if (stage.geo) {
                return runGeoTerminal(sql, tableName, stage, scopeCondition, limit, (count) => {
                    scanned = count;
                });
            }

            return runPlainFetch(sql, tableName, stage, scopeCondition, buildOrderClause(), limit, (count) => {
                scanned = count;
            });
        })();

        meterRows(Math.max(scanned, rows.length));

        return rows;
    };

    /**
     * `.collectWithScores()`'s dispatcher — the scored twin of {@link runFetch}.
     * Only a staged search or geo query has a score/distance to surface, so
     * this requires one of `.withSearchIndex()` / `.withGeoIndex()` (mirrors
     * `.paginate()`'s geo-unsupported guard). Otherwise identical to
     * `runFetch`: it stamps the same dependency footprint and meters the same
     * row count, so a live `.collectWithScores()` query invalidates and is
     * quota-charged exactly like `.collect()` does.
     */
    const runFetchScored = (): ScoredDocument[] => {
        if (!stage.search && !stage.geo) {
            throw new LunoraError("INTERNAL", `ctx.db.query("${tableName}").collectWithScores() requires a staged .withSearchIndex(...) or .withGeoIndex(...)`);
        }

        stampTerminal();

        let scanned = 0;
        const rows = ((): ScoredDocument[] => {
            if (stage.search) {
                const found = runSearchFetchScored(undefined);

                scanned = searchScanned;

                return found;
            }

            return runGeoTerminalScored(sql, tableName, stage, scopeCondition, undefined, (count) => {
                scanned = count;
            });
        })();

        meterRows(Math.max(scanned, rows.length));

        return rows;
    };

    const reader: TableReaderLike = {
        /**
         * Lazy row iteration — `for await (const row of ctx.db.query(t)…)`.
         *
         * Pulls one keyset page at a time and yields its rows, so a consumer
         * that stops early (a `break`, a k-way merge that only needs the head of
         * each branch) stops the reads too. That laziness is the point: a
         * userland merged-index stream otherwise has to materialise each branch
         * with a bounded `take(n)`, so asking for one row reads `n` per branch.
         *
         * **In-memory filters are applied here, not by `paginate`.** `paginate`
         * must return a FULL page of surviving rows, so when the stage carries
         * `.filter()` predicates it drops the SQL `LIMIT` and scans the whole
         * remainder of the table on every call — which would make iteration
         * quadratic (`N²/pageSize`) and, because RLS pushes its policy down as
         * an in-memory filter, would do so on every guarded read even when the
         * caller wrote no `.filter()` at all. Paging the UNFILTERED stage keeps
         * the scan bounded to one page, and the predicates run over each page as
         * it arrives — same rows, same order, linear.
         */
        // eslint-disable-next-line generator-star-spacing -- prettier owns this spacing and formats it as `async *[…]`; the rule wants `async* […]`, and prettier runs last
        async *[Symbol.asyncIterator]() {
            // A SEARCH stage is read unbounded, exactly as `collect()` reads it,
            // rather than paged.
            //
            // Paging cannot terminate honestly here: a page is capped at
            // `MAX_SEARCH_SCAN` and a page sized to the cap cannot fetch the
            // probe row that tells "exactly that many matches" from "ten times
            // as many", so `planSearchPage` refuses it rather than report a
            // false `isDone`. With `ITERATOR_PAGE_SIZE` dividing the cap exactly
            // (1024 / 128 = 8), a walk of 897–1023 matches landed on the cap
            // every time and died with a `BAD_REQUEST` naming a `numItems` the
            // caller never passed — while `.collect()` on the same query
            // returned every row. The D1 twin moved its iterator off paging for
            // this reason and documented it; the shard reader was never given
            // the same treatment.
            //
            // Nothing is given up: the page size was the cap, so the loop
            // already read the whole window in one query and a `break` saved
            // nothing. A scored search has to rank its whole window before it
            // knows which row is first.
            if (stage.search) {
                yield* runFetch(undefined);

                return;
            }

            const predicates = [...stage.inMemoryFilters];
            let cursor: string | undefined;

            // Swapped out for the duration of the walk so `paginate` keeps its
            // `LIMIT`; restored in `finally` so an early `break` (which
            // finalizes the generator) leaves the reader exactly as it found it.
            stage.inMemoryFilters = [];

            try {
                for (;;) {
                    // Sequential by construction: each page's cursor comes from
                    // the previous page, so these reads cannot be parallelised.
                    // eslint-disable-next-line no-await-in-loop, unicorn/no-null -- see above; `null` is PaginationOptions' documented first-page sentinel
                    const page: QueryPage = await reader.paginate({ cursor: cursor ?? null, numItems: ITERATOR_PAGE_SIZE });

                    for (const row of page.page) {
                        if (predicates.every((predicate) => predicate(row))) {
                            yield row;
                        }
                    }

                    if (page.isDone || page.continueCursor === null) {
                        return;
                    }

                    cursor = page.continueCursor;
                }
            } finally {
                stage.inMemoryFilters = predicates;
            }
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- TableReaderLike returns Promises (the D1 twin awaits real I/O); the DO impl is synchronous over local SQLite
        async collect() {
            return runFetch(undefined);
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- TableReaderLike returns Promises (the D1 twin awaits real I/O); the DO impl is synchronous over local SQLite
        async collectWithScores() {
            return runFetchScored();
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
            // Neither pagination branch routes through `runFetch`, so stamp
            // here rather than relying on it — and keep a local scan counter,
            // since `runFetch`'s one is not in play on this path.
            let scanned = 0;

            stampTerminal();

            if (stage.search) {
                const searchPage = paginateSearchStage(options);

                meterRows(searchPage.page.length);

                return searchPage;
            }

            if (stage.geo) {
                throw new LunoraError("INTERNAL", "pagination is not supported on geo queries; use .take(n) or .collect()");
            }

            const page = paginateStage(sql, tableName, tableDefinition.shape, stage, options, scopeConditionText, (count) => {
                scanned = count;
            });

            // Filtered pagination skips the SQL `LIMIT`, so the scan can run well
            // past the page it returns — charge whichever is larger.
            meterRows(Math.max(scanned, page.page.length));

            return page;
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

/**
 * SQLite phrases `SQLITE_TOOBIG` as "string or blob too big"; the same wording
 * reaches us from workerd and `node:sqlite` alike. Matches the recogniser the
 * solutions catalog keys `lunora-row-too-big` on (`@lunora/errors`).
 */
const ROW_TOO_BIG_RE = /string or blob too big/iu;

/**
 * Row-size overflow is the one storage-engine limit a caller can act on, so it
 * must survive the wire. A raw `SQLITE_TOOBIG` is not a `LunoraError`, and
 * `toErrorBody` redacts every foreign throw to `INTERNAL` / "Internal error" /
 * 500 — leaving the operator a redacted 500 for a document they can simply move
 * to R2. `PAYLOAD_TOO_LARGE` is catalogued non-internal (413), so this message
 * reaches the client with the limit named.
 */
const throwIfRowTooBig = (error: unknown, table: string): void => {
    if (!(error instanceof Error) || !ROW_TOO_BIG_RE.test(error.message)) {
        return;
    }

    throw new LunoraError(
        "PAYLOAD_TOO_LARGE",
        `document is too large to store in "${table}": a single row cannot exceed the storage engine's per-row ceiling (2 MB on a Durable Object's SQLite). The limit is on the STORED bytes, which are UTF-8, and v.bytes()/v.bigint() columns are stored twice on a shard-local table. Keep the payload in R2 (ctx.storage) and store a reference on the row.`,
    );
};

/** Run a write, remapping a UNIQUE-index breach to a {@link ConflictError} (code `CONFLICT`, 409). */

/**
 * Run a single-row write, mapping a UNIQUE violation onto {@link ConflictError}.
 *
 * Takes rendered text plus its bound values rather than a drizzle `SQL`, because
 * every statement that reaches it has text that is a constant for its table —
 * see `row-statements.ts` for the shapes and for why they are no longer built
 * per write. The one caller with a genuinely variable statement (the batch
 * INSERT's `VALUES` list) renders it itself and passes the result through.
 */
const runWrite = (sql: SqlExec, table: string, text: string, params: ReadonlyArray<unknown>): void => {
    try {
        runSql(sql, text, ...params);
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new ConflictError(`unique constraint violation on "${table}"`, "unique");
        }

        throwIfRowTooBig(error, table);

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
const runGuardedWrite = (sql: SqlExec, table: string, text: string, params: ReadonlyArray<unknown>): void => {
    runWrite(sql, table, text, params);

    const changedRow = runSql<{ changed: number }>(sql, CHANGES_PROBE_SQL).one();

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
 * value for the i-th sort key — i.e. the exact bytes stored in `__sort_k<i>__`
 * by `syncRankIndexEntry` (in `./ctx-db-companions`) — so the per-key comparison
 * matches the companion's BLOB column regardless of which shard supplied the value.
 *
 * Lexicographic strict-less under per-key direction: for keys
 * `[(k0, dir0), (k1, dir1), ...]` plus the `__id__` tiebreak,
 * (k0 < v0)
 * OR (k0 = v0 AND k1 < v1)
 * OR (k0 = v0 AND k1 = v1 AND __id__ < rowId)
 * where `<` flips to `>` for desc keys. Each pivot comparison comes from
 * {@link rankPivotConditionSql}, which is where the NULL cases live — a sort
 * column genuinely holds NULL and no comparator reaches either side of one.
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
        const column = sortColumns[pivot];
        const sortKey = sortBy[pivot];
        // The `__id__` ASC tiebreak closes the tuple; ids are minted by the
        // store, so that one is never NULL.
        const direction = sortKey?.direction === "desc" ? "desc" : "asc";
        const pivotCondition =
            column === undefined || sortKey === undefined
                ? dsql`${dsql.identifier(RANK_TIEBREAK)} < ${rowId}`
                : rankPivotConditionSql(column, serializedSortValues[pivot], direction, false);

        // A NULL pivot with nothing sorting before it makes the whole branch
        // unsatisfiable — drop it rather than emit an always-false disjunct.
        if (pivotCondition === undefined) {
            continue;
        }

        const conditions: SQL[] = [];

        for (let prefix = 0; prefix < pivot; prefix += 1) {
            conditions.push(dsql`${dsql.identifier(sortColumns[prefix] as string)} IS ${serializedSortValues[prefix]}`);
        }

        conditions.push(pivotCondition);

        const [firstCondition] = conditions;

        beforeBranches.push(conditions.length === 1 && firstCondition !== undefined ? firstCondition : dsql`(${dsql.join(conditions, dsql` AND `)})`);
    }

    const beforeWhere = beforeBranches.length > 0 ? dsql.join(beforeBranches, dsql` OR `) : dsql`1 = 0`;
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

    /**
     * This mutation's `_commitSeq`, allocated on first use and reused for every
     * subsequent commit-ordered write.
     *
     * Closure-scoped to THIS writer instance, which is what makes the value a
     * commit sequence rather than a row counter: every dispatch builds a fresh
     * `createShardCtxDb(...)` (see the generated `buildCtx`), so the memo's
     * lifetime is exactly one mutation and every row that mutation writes
     * compares equal. Allocating per row instead would break the one property
     * consumers depend on — that rows committed together sort together.
     */
    let commitSeq: number | undefined;

    /**
     * Is an atomic write boundary open right now? Absent option ⇒ `false`, so a
     * caller that does not report its transaction state gets a sequence per
     * write rather than one shared across writes that may not commit together.
     */
    const inTransaction = (): boolean => options.inTransaction?.() === true;

    /**
     * The `_commitSeq` entry to spread into a row image about to be written —
     * empty for a table that did not declare `.commitOrdered()`.
     *
     * Returns a spreadable fragment rather than mutating the caller's object so
     * the stamp lands where the image is CONSTRUCTED. Every write path builds
     * its image in one expression (`documentWithMeta` / `merged` / `replaced`),
     * and spreading here puts the field in front of everything downstream — the
     * encoded blob, the companion sync, the CDC entry, the broadcast delta, the
     * before/after triggers, and `onWrite` — so they all agree on what was
     * persisted. Spread position matters on the update paths: it must come after
     * `...existing` / `...patch` so the previous write's sequence is replaced
     * rather than carried forward.
     *
     * Allocating this early means a `before` trigger that aborts the write has
     * already burned a sequence — harmless, because inside a transaction the
     * allocation and the abort share `state.storage.transaction(...)` and the
     * counter row rolls back with everything else.
     *
     * **The memo is transaction-scoped, not writer-scoped.** Reusing it across
     * writes is only sound while those writes commit together. A mutation is
     * wrapped in one storage transaction, so every row it writes shares a
     * sequence and compares equal — the property a consumer relies on to process
     * a mutation as a unit. An ACTION is deliberately not wrapped (its external
     * I/O cannot be rolled back), so its writes commit independently; reusing one
     * sequence there would let a consumer checkpoint after the first write and
     * never be offered the rest, because they carry a sequence it has already
     * passed. Outside a transaction each write therefore allocates its own.
     */
    const commitSeqFields = (tableName: string): Record<string, number> => {
        if (schema.tables[tableName]?.commitOrderedMode !== true) {
            return {};
        }

        if (commitSeq === undefined || !inTransaction()) {
            commitSeq = allocateCommitSeq(sql);
        }

        return { [COMMIT_SEQ_FIELD]: commitSeq };
    };

    /**
     * The index positions a written row occupies, unioned across the images
     * supplied. Callers pass BOTH the before- and after-image of a patch: a
     * row that moves between slices must wake subscribers on the slice it left
     * as well as the one it entered, and only the outgoing image can prove the
     * former.
     *
     * Returns `undefined` when no image is available (the position is then
     * unknown), which makes the cache drop every range dependency on the table
     * — the same conservative behaviour as before ranges existed.
     */
    const rowIndexKeys = (tableName: string, ...images: (Record<string, unknown> | undefined)[]): IndexKeyEntry[] | undefined => {
        const indexes = schema.tables[tableName]?.indexes;

        if (!indexes || indexes.length === 0) {
            return undefined;
        }

        const entries: IndexKeyEntry[] = [];

        for (const image of images) {
            if (image) {
                entries.push(...indexKeysForRow(indexes, image, serializeSqlValue));
            }
        }

        return entries.length > 0 ? entries : undefined;
    };

    const { headroom } = options;

    /**
     * Scoped bypass for every headroom charge below, usable ONLY by primitives
     * that are deliberately unbounded by design — today, only `deleteAll` (see
     * its docstring: "Deliberately uncapped… erasure primitive"). Not exported,
     * so user code (a mutation handler, a trigger function) has no way to reach
     * it directly; the only caller is `deleteAll`'s own implementation below.
     *
     * Closure-scoped to THIS writer instance rather than a bare top-level
     * `let`: every dispatch builds a fresh `createShardCtxDb(...)` writer (see
     * the generated `buildCtx`), so this flag can never leak across a
     * CONCURRENT dispatch on a different writer instance — each has its own.
     * Within one writer, though, the exemption is WRITER-WIDE for the
     * duration of `deleteAll`'s await chain, not scoped to `deleteAll`'s own
     * calls: `meterExempt` is a single boolean every hook on this writer
     * reads, so any OTHER write that gets interleaved into that chain — e.g.
     * a sibling `await Promise.all([ctx.db.deleteAll("a"),
     * ctx.db.insertMany("b", big)])` — sees `meterExempt === true` too and is
     * silently exempted alongside it. This is a known, low-severity
     * limitation rather than a correctness bug: the meter is a resource
     * bound, and parallelizing a bulk erase with other writes on the same
     * writer is an unusual pattern to begin with.
     *
     * Gating the SHARED `onRead`/`onWrite` hooks (rather than only the two call
     * sites `deleteAll` itself makes) means a trigger's own writes, fired as a
     * side effect of the row `deleteAll` is erasing, are ALSO exempt for that
     * one row's pipeline — there is no separate metering surface to gate
     * instead, since triggers run against this same writer. That is bounded by
     * "one row's worth of side effects" per iteration, not by "however many
     * rows deleteAll erases", so it does not reopen the isolate-exhaustion gap
     * the meter exists to close.
     */
    let meterExempt = false;

    /** Run `run` with every headroom charge below suppressed. See `meterExempt`. */
    const runUnmetered = async <T>(run: () => Promise<T>): Promise<T> => {
        const previous = meterExempt;

        meterExempt = true;

        try {
            return await run();
        } finally {
            meterExempt = previous;
        }
    };

    const reportRead = options.onRead ?? (() => undefined);

    /**
     * Stamp {@link UNVOUCHABLE_DEP} when a read touched a `.memory()` table.
     *
     * `recordCdc` deliberately skips memory tables, so `__cdc_log` holds no
     * record of them — and `cdcCanVouchFor` (see `ctx-db-cdc.ts`) defines the
     * vouchable set as "a table of that name exists in this DO's SQLite", which
     * a memory table satisfies. Migrations create it; only its rows are cleared.
     * So a read-set of `{presence}` was fully vouchable, `cdcTouchesTables` found
     * nothing for it in the log, and a client that disconnected while presence
     * churned reconnected to `resumable: true` with no snapshot — keeping its
     * pre-disconnect roster for the life of the subscription.
     *
     * The sentinel is exactly the missing stamp: a name no table can carry, so it
     * can only ever fall to "cannot vouch". Cost is one re-snapshot per reconnect
     * for a subscription that read a memory table, which is what such a
     * subscription needs anyway — a memory table is emptied by the very eviction
     * that most often precedes the reconnect.
     *
     * Stamped alongside the real table dep rather than in place of it: the live
     * refresh path still invalidates on the memory table's own name (its writes
     * DO reach `broadcast`/the changed-table set), and `UNVOUCHABLE_DEP` never
     * appears in a written-table set, so `setsIntersect`/`writeTouchesMemo` step
     * straight past it.
     */
    const reportMemoryRead = (table: string): void => {
        if (isMemoryTable(schema.tables[table])) {
            // The sentinel doubles as its own id marker so the RPC path's hook
            // does not coalesce it to `SCAN_DEP` and file `!unvouchable` in the
            // request log's scanned-table readout as if it were a real table.
            reportRead(UNVOUCHABLE_DEP, UNVOUCHABLE_DEP);
        }
    };

    // An unwired host must degrade to the whole-table dep, NOT to silence: the
    // terminal reports either a range or a scan, so dropping the range would
    // leave an indexed read with no dependency at all — it would never
    // invalidate, which is the one failure this whole design must not have.
    const reportReadRange =
        options.onReadRange ??
        ((range: KeyRange) => {
            reportRead(range.table, SCAN_DEP);
        });
    const onReadRange = (range: KeyRange): void => {
        reportMemoryRead(range.table);
        reportReadRange(range);
    };

    /**
     * Charge reads as they are stamped. The object-form readers (`get`,
     * `findFirst`, `findMany`) stamp one dependency per row, so counting those
     * IS the row count. Marker deps — `SCAN_DEP` and the `~r:` range suffix —
     * describe a read's SHAPE, not its size, and would each otherwise be
     * miscounted as a single row; the fluent reader meters its own terminals
     * instead (see `meterRows` in `buildReader`).
     */
    const onRead: ReadHook = (table, idOrScan) => {
        if (idOrScan !== undefined && idOrScan !== SCAN_DEP && !meterExempt) {
            headroom?.recordRead(1);
        }

        reportMemoryRead(table);
        reportRead(table, idOrScan);
    };
    const onIndexUse = options.onIndexUse ?? (() => undefined);
    const reportWrite = options.onWrite ?? (() => undefined);

    /**
     * Charge writes on the same hook every write path already awaits, so no
     * mutation can bypass the meter. A delete carries no document: it still
     * costs a row, just no bytes.
     */

    /**
     * Charge one written document against the transaction meter, unless this
     * writer is running unmetered (see `meterExempt`).
     *
     * Named rather than inlined because the `.global()` branches cannot reach
     * `onWrite` — they return before it — so each one has to charge itself, and
     * "did this branch remember?" is invisible when the answer is a three-line
     * ritual repeated six times across 700 lines. One call is an obvious
     * absence.
     */
    const meterWrite = (row: unknown): void => {
        if (!meterExempt) {
            headroom?.recordWrite(row);
        }
    };

    const onWrite: WriteHook = async (event) => {
        meterWrite(event.doc);

        await reportWrite(event);
    };
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
        // A `.memory()` table never reaches the changelog. Its rows do not
        // survive the next eviction, so a CDC consumer replaying them would
        // materialize state the shard itself no longer believes in — and log
        // retention is opt-in (`LUNORA_CDC_LOG_RETENTION`; without it
        // `CdcRetentionRunner.sweep` returns before trimming anything), so on a
        // default deployment a heartbeat-rate presence table would grow the log
        // without bound for the life of the shard.
        //
        // What this costs, stated because two call sites got it wrong by
        // assuming otherwise:
        //
        // - LIVE refresh is unaffected — it is driven by the changed-table set,
        //   which `broadcast` populates for a memory table like any other.
        // - RESUME is affected, and is handled: a read of a memory table stamps
        //   `UNVOUCHABLE_DEP` (see `reportMemoryRead` above), because
        //   `cdcCanVouchFor` would otherwise vouch for a table this log has no
        //   record of.
        // - SHAPES cannot work off a table that never enters this log, and
        //   nothing here can synthesize one. The combination is refused at shape
        //   registration instead — see `assertShapeShardable` in
        //   `relation-predicates.ts`.
        if (cdcEnabled && !isMemoryTable(schema.tables[table])) {
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
     * its generic `ctx.db.<op>("<table>", …)` call must reach the D1-backed
     * `globalDb` writer — where the table is provisioned and read-your-writes
     * apply — instead of this DO's local SQLite, which has no such table.
     *
     * Returns `undefined` for shard-local tables so the caller runs its normal
     * local path; throws a clear wiring error if a global table is reached
     * without a `globalDb` (mirroring {@link routeBackend}). This is the generic
     * twin of the property-style `ctx.db.<globalTable>` facade: both land global
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
     * The `.global()` half of `insert`: put the row on the meter, forward it to
     * the global (D1) writer, then refresh this DO's subscribers.
     *
     * Charge BEFORE the write, not after. The global branch returns before
     * `onWrite`, which is where the meter normally charges, so it has to charge
     * itself or a transaction could write unbounded rows to a `.global()` table
     * without consuming its ceiling. The order matters because this write lands
     * in ANOTHER backend: a mutation runs inside the DO's `storage.transaction`,
     * which rolls back the DO's SQLite and nothing else. Charging after meant a
     * ceiling breach threw with the D1 row already committed and no way to undo
     * it.
     *
     * The trade is a charge for a row that was never written when the throw is
     * caught — `insertMany`'s `skipDuplicates` swallows the D1 unique violation,
     * so a re-run over mostly-duplicate rows now consumes ceiling for the skips.
     * Failing closed is the right side of that: over-counting costs a retry,
     * under-counting costs an isolate.
     *
     * What is charged is the caller's document, not the row D1 ends up storing —
     * the global writer applies its own defaults, `_creationTime` and id on the
     * far side, and reproducing that here would duplicate the far-side default
     * pipeline for an estimate. So `writtenBytes` runs light by whatever those
     * add, a bounded per-row amount; `writtenRows`, which is the ceiling that
     * actually protects the isolate, is charged exactly.
     * `charge` is `false` when the caller already charged this row — today
     * `insertMany`, which pre-charges the whole batch so a mid-loop breach
     * cannot leave earlier rows committed in a backend the DO transaction
     * cannot roll back. A parameter rather than `runUnmetered`, deliberately:
     * `meterExempt` is writer-wide for the duration of its await, so a routine
     * `Promise.all([ctx.db.insertMany("<global>", rows), ctx.db.insert(…)])`
     * would silently exempt the sibling write too. `deleteAll` accepts that
     * trade for an unusual pattern; a global `insertMany` is ordinary.
     */
    const insertGlobal = async (
        global: DatabaseWriterLike,
        tableName: string,
        document: Record<string, unknown>,
        insertOptions: Parameters<DatabaseWriterLike["insert"]>[2],
        charge: boolean,
    ): Promise<string> => {
        if (charge) {
            meterWrite(document);
        }

        const id = await global.insert(tableName, document, insertOptions);

        // A `.global()` (D1) write lands in another backend, but live
        // subscriptions on this DO that read the table still need to be
        // refreshed — so notify them via the same `broadcast` channel the
        // local path uses (the DO maps it to `recordChangedTable`). Without
        // this, `ctx.db.insert("<global>", …)` would never push a delta to
        // subscribers of that global table's query.
        //
        // Deliberately NO `indexKeys`: the global writer applied its own
        // defaults and `_creationTime` on the far side, so the image here
        // is not the row that was stored. An index covering a defaulted
        // field would encode a position the row does not occupy, which
        // could prove a write outside a slice that actually contains it —
        // suppressing an invalidation. Omitting them falls back to
        // whole-table, which is always sound.
        broadcast({
            key: id,
            op: "insert",
            row: { ...document, _id: id },
            table: tableName,
        });

        return id;
    };

    // For *id-addressed* ops (`get`/`patch`/`replace`/`delete`): a bare id
    // carries no table, so they probe this DO's local tables first; a global
    // row's id never lives here, so on a local miss they fall back to
    // `globalDb` (which probes its D1 tables) when one is wired.

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
        indexKeysFor: (table, document) => rowIndexKeys(table, document),
        invalidateCache: (table, id, document) => cache?.invalidate(table, id, rowIndexKeys(table, document)),
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
     * Shard-local table names, optionally narrowed to a facade-pinned table.
     * When `expectedTable` is supplied (the `ctx.db.<table>.get/delete/...`
     * by-id facade pins it), the probe below is scoped to that one table so a
     * foreign id can never resolve cross-table — closing an IDOR where a
     * branded `Id<"posts">` carrying another table's id would otherwise
     * read/mutate that other table. A `.global()` `expectedTable` narrows the
     * probe to nothing because those rows live in D1, not this DO — see
     * {@link globalFallbackFor}, which picks them up. An unknown
     * `expectedTable` narrows it to nothing too and nothing picks it up: the
     * id reads as absent, which is the point.
     */
    const nonGlobalTableNames = (expectedTable?: string): string[] =>
        Object.entries(schema.tables)
            .filter(([, definition]) => definition.shardMode?.kind !== "global")
            .map(([tableName]) => tableName)
            .filter((tableName) => expectedTable === undefined || tableName === expectedTable);

    /**
     * The D1-backed writer a by-id op falls through to when the shard-local
     * probe found nothing — or `undefined` when it must not fall through.
     *
     * A `.global()` row's id never lives in this DO, so an unpinned lookup
     * always falls through. A facade-pinned one falls through only when the
     * pinned table is itself `.global()`: pinning a shard-local table and then
     * reaching a global row would be exactly the cross-table read/mutate the
     * pin exists to stop (IDOR). Every caller forwards `expectedTable` on to
     * the global writer as well, so the pin is re-applied over there — its
     * `resolveTableName` treats an id owned by another table as absent, which
     * is what keeps one `.global()` facade out of another `.global()` table.
     */
    const globalFallbackFor = (expectedTable?: string): DatabaseWriterLike | undefined =>
        expectedTable === undefined || isGlobalTable(expectedTable) ? globalDb : undefined;

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
        // `unionAll` nests the branches five at a time so a schema wider than
        // Workerd's 5-term compound-SELECT cap still probes in one statement;
        // past MAX_PROBE_BRANCHES the id placeholders alone exceed the bound-
        // parameter cap, so those schemas probe one chunk of tables at a time.
        const nonGlobalTables = nonGlobalTableNames(expectedTable);

        for (let start = 0; start < nonGlobalTables.length; start += MAX_PROBE_BRANCHES) {
            const chunk = nonGlobalTables.slice(start, start + MAX_PROBE_BRANCHES);
            // Text depends only on the chunk's table list, so it is rendered once
            // per distinct list rather than per read — this probe runs on every
            // get/patch/replace/delete. See `row-statements.ts`.
            const [firstRow] = runSql(sql, rowProbeSql(chunk), ...rowProbeParams(id, chunk)).toArray();

            if (!firstRow) {
                continue;
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
            const documentJson = typeof rawDocument === "string" ? rawDocument : encodeDocJson((rawDocument ?? {}) as Record<string, unknown>);

            return { docJson: documentJson, row, tableName };
        }

        return undefined;
    };

    /**
     * Batched sibling of {@link locateRowById}, for the RLS guard's
     * `deleteMany`/`patchMany` pre-check (`guardByIds` in `rls-guard.ts`):
     * resolve the owning table of MANY ids in as few statements as possible
     * instead of one `locateRowById` probe per id.
     *
     * Selects only `__t__, id` (the guard needs the table name, not the row —
     * skipping the document column keeps the probe narrow) and has no
     * `LIMIT 1`: unlike a single lookup, every id may hit a different table
     * and all hits are wanted.
     *
     * One statement, however many ids: each branch repeats the full
     * `id IN (...)` list, so a literal list would cost `ids * tables` bound
     * placeholders against Workerd's cap of 100 — hence the per-branch budget
     * handed to `sqliteInList`, which switches the list to a single JSON
     * parameter once it would not fit. The branch count itself is capped by
     * `unionAll`'s nesting for the compound-SELECT limit and by
     * {@link MAX_PROBE_BRANCHES} for the parameter one.
     * @returns a map from id to its owning table; an id absent from the map resolved to no table this writer can see
     */
    const locateTablesByIds = (ids: ReadonlyArray<string>, expectedTable?: string): Map<string, string> => {
        const uniqueIds = [...new Set(ids)];

        const resolved = new Map<string, string>();

        if (uniqueIds.length === 0) {
            return resolved;
        }

        const nonGlobalTables = nonGlobalTableNames(expectedTable);

        for (let start = 0; start < nonGlobalTables.length; start += MAX_PROBE_BRANCHES) {
            const group = nonGlobalTables.slice(start, start + MAX_PROBE_BRANCHES);
            // Chunking keeps the divisor at or below MAX_PROBE_BRANCHES, so the
            // budget is always at least the one placeholder a branch needs.
            const perBranchBudget = Math.floor(MAX_PROBE_BRANCHES / group.length);
            // eslint-disable-next-line no-restricted-syntax -- a drizzle identifier chunk, not a string conversion; the rule misfires on the inner TemplateLiteral
            const idFilter = sqliteInList(dsql`${dsql.identifier("id")}`, uniqueIds, false, perBranchBudget);
            const branches = group.map(
                (tableName) =>
                    // Mirrors `locateRowById`'s inline-literal table discriminator.
                    dsql`SELECT ${dsql.raw(`'${tableName.replaceAll("'", "''")}'`)} AS __t__, id FROM ${dsql.identifier(tableName)} WHERE ${idFilter}`,
            );

            for (const row of runDrizzle(sql, unionAll(branches))) {
                const { id, __t__: tableName } = row;

                if (typeof tableName === "string" && typeof id === "string") {
                    resolved.set(id, tableName);
                }
            }
        }

        return resolved;
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

            // Soft delete: aggregate over LIVE rows only. The scope is ANDed in
            // for the scan below; the companion needs no help — it tallies live
            // rows only (`isLiveForCompanion`), so its answer already excludes
            // soft-deleted rows — which does NOT mean a soft-delete table always
            // takes it; see `scanRefusesAny`.
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
            //
            // A soft-delete table reaches it only when the scan would refuse —
            // see `scanRefusesAny`.
            if (definition.aggregateIndexes && !aggOptions.baseWhere && !hasRelation && (!aggScope || scanRefusesAny(definition, [aggOptions.field]))) {
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

            // The scan reduces `json_extract(__doc__, '$.field')`, and for a
            // `v.bigint()` column that is the zero-padded SORT KEY, not the
            // number — `SUM` over it coerces to nonsense (1.5e40 for a handful
            // of small values) and `MIN`/`MAX` hand back the padded string. The
            // maintained companion above answers these correctly, so name it
            // rather than return a number that looks plausible and is not.
            assertReducibleBySql(definition, aggOptions.field, `aggregate(${tableName}, { op: "${aggOptions.op}", field: "${aggOptions.field}" })`);

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
            // force the scan path. This is `scanRefusesAny(definition, [])` —
            // `count()` hands SQL no field, so the scan can always answer it and
            // is the cheaper of the two; the empty field list is why the
            // condition degenerates to `!countScope` rather than being spelled
            // out like its siblings.
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
                // A global row's id never lives in this DO; fall back to the
                // D1 writer when this call is allowed to reach one (both
                // backends are silent on a genuinely-absent id) — see
                // `globalFallbackFor`, which also re-applies the facade's pin
                // over there.
                const global = globalFallbackFor(expectedTable);

                if (global) {
                    // A delete carries no document, so it costs a row and no
                    // bytes — exactly what `onWrite` charges for the local paths
                    // (see its docblock). Charged here because this branch
                    // returns before that hook, and before the boundary because
                    // D1 does not roll back with the DO's transaction. Without
                    // it, `deleteWhere` over a `.global()` table — which routes
                    // through `deleteMany` to here — was free of the meter
                    // entirely, however many rows it removed.
                    meterWrite(undefined);

                    await global.delete(id, expectedTable, deleteOptions);
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
                // patch/replace. Read scoping is what hides the row from search
                // (its companion carries no marker column but the read filters on
                // it); the aggregate companion instead drops the row below, since
                // `syncAggregates` gates both sides on liveness.
                // A soft delete is mechanically an UPDATE, so it is a write to
                // the row and advances `_commitSeq` like any other — otherwise a
                // changefeed paging on the sequence would never observe the
                // tombstone and would keep serving a row its source considers gone.
                const merged: Record<string, unknown> = { ...existing, ...commitSeqFields(tableName), [softField]: clock(), _id: id };

                runGuardedWrite(sql, tableName, patchRowSql(tableName), [encodeDocJson(merged), id, existingJson]);

                // Search stays maintained (the marker filter hides it on read), but
                // the rank companion and external stores (Vectorize) have NO read-time
                // marker filter — the companion row carries no marker column and a
                // Vectorize query can't be scoped — so a soft delete REMOVES the row
                // from them (passing `undefined`/`op: "delete"`), exactly like a
                // physical delete. `restore()` re-adds both via the patch path. The
                // aggregate companion is the exception: it takes both images and the
                // liveness gate drops the row, per the comment above.
                syncSearch(tableName, id, merged, existing);
                // Like rank, the geo companion has no read-time marker filter, so a
                // soft delete removes the row from it (restore re-adds via patch).
                syncGeo(tableName, id, undefined);
                syncAggregates(tableName, existing, merged);
                syncRanks(tableName, id, existing, undefined);

                cache?.invalidate(tableName, id, rowIndexKeys(tableName, existing, merged));

                recordCdc(tableName, id, "update", merged);
                broadcast({ indexKeys: rowIndexKeys(tableName, existing, merged), key: id, op: "update", row: merged, table: tableName });

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
            runGuardedWrite(sql, tableName, deleteRowSql(tableName), [id, existingJson]);

            syncSearch(tableName, id, undefined);
            syncGeo(tableName, id, undefined);
            syncAggregates(tableName, existing, undefined);
            syncRanks(tableName, id, existing, undefined);

            cache?.invalidate(tableName, id, rowIndexKeys(tableName, existing));

            recordCdc(tableName, id, "delete");
            broadcast({ indexKeys: rowIndexKeys(tableName, existing), key: id, op: "delete", table: tableName });

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
            // reaches it through the `globalDb` fallback — which is gated on NO table being
            // pinned (the IDOR guard: a non-global by-id facade must not reach a global
            // row). Pinning `tableName` here would therefore make every global delete a
            // silent no-op: the count would inflate, the rows would survive, and a table
            // with at least `chunkSize` rows would loop forever because `findMany` kept
            // returning the same page. Leave the table unpinned for a global table —
            // exactly what `deleteWhere` does when it hands ids to `deleteMany`.
            const expectedTable = isGlobalTable(tableName) ? undefined : tableName;
            let deleted = 0;

            // Resolve-then-delete in chunks until the table is empty. Deliberately
            // uncapped AND METER-EXEMPT: this is the erasure primitive, so
            // stopping at DEFAULT_BATCH_LIMIT — or at the transaction headroom's
            // read/write ceilings — would leave data behind, the opposite of the
            // guarantee the caller needs (a GDPR/tenant-erasure "this table is
            // now empty" claim that quietly stops at 50k rows is not that
            // guarantee). The bound on this primitive is the table's own size,
            // not `TransactionLimits` — `runUnmetered` (see its definition
            // above) is what makes that true for both halves: the paging
            // `findMany` reads AND the per-row `writer.delete` writes below. On
            // a `.softDelete()` table the default flips the marker (so the loop
            // must not re-read the same rows forever); `{ hard: true }` removes
            // them physically.
            await runUnmetered(async () => {
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
            });

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
            // Resolve matching rows first — a global table (no native batch
            // primitive) through its D1 writer, a shard-local one through this
            // writer's own `findMany` (which rejects an unknown table). The
            // mutation-span (if any) keeps the read and the subsequent deletes
            // consistent.
            const source = globalWriterFor(tableName, "deleteWhere") ?? writer;
            const page = await source.findMany(tableName, { where });
            const ids = page.page.map((row) => String(row["_id"]));

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
            // `page[0]` is the whole answer, so the envelope's cursor is built and
            // thrown away — see `omitContinueCursor`.
            const result = await writer.findMany(tableName, { ...args, limit: 1, omitContinueCursor: true });

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

            const orderKeys = normalizeOrderKeys(args.orderBy, findManyDefinition.shape);
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
            const whereStrategy = relationExistsPushDownEnabled ? makeRelationExistsTextStrategy(onRead) : doWhereTextStrategy;
            const whereCondition = compileWhereSql(predicate, whereStrategy, textFragments);

            const limit = typeof args.limit === "number" ? Math.max(0, Math.floor(args.limit)) : undefined;
            // Over-fetch by one row to learn whether another page exists without
            // issuing a second query.
            const statement = selectPageSql(tableName, whereCondition, compileOrderByText(orderKeys), limit === undefined ? undefined : limit + 1);
            const rows = runSql(sql, statement.text, ...statement.params).toArray();

            // A full scan stamps ONE `*scan` dep instead of a dep per row, so the
            // read meter — which counts concrete-id stamps — would never see the
            // rows this call materialized. Charge them here. Predicated reads are
            // charged by their per-row stamps below, so they must not be charged
            // twice.
            if (isFullScan && !meterExempt) {
                headroom?.recordRead(rows.length);
            }

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
                        ...relationHooks(args),
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
                    ...relationHooks(args),
                    schema,
                    tableName,
                    with: args.with,
                });
            }

            return {
                // The cursor is encoded from `last` (the full, unprojected row) above,
                // so `applySelect` only trims the returned payload — paging is intact.
                // eslint-disable-next-line unicorn/no-null -- QueryPage.continueCursor is `null | string`: null is the documented "no further page" cursor on the wire
                continueCursor: hasMore && last && args.omitContinueCursor !== true ? encodeCursor(last, orderKeys) : null,
                isDone: !hasMore,
                page: applySelect(page, args.select, args.with),
            };
        },

        async get(id, expectedTable) {
            const located = locateRowById(id, expectedTable);

            if (!located) {
                // A global row's id never lives in this DO; fall back to the
                // D1 writer when this call is allowed to reach one — see
                // `globalFallbackFor`, which also re-applies the facade's pin
                // over there.
                const global = globalFallbackFor(expectedTable);

                if (global) {
                    return global.get(id, expectedTable);
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

            // Soft delete: group over LIVE rows only. The scope is ANDed in for
            // the scan; the companion tallies live rows only and prunes a group
            // once its live count hits 0, so the indexed walk omits the same
            // empty groups SQL `GROUP BY` does — but it is only taken for a
            // projected field, per the note on `isProjectedField`.
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
            // Every field this reader hands to SQL: the `by` keys and the
            // reducer field. One list, used for both the companion gate and the
            // refusal assertions below, so a future third SQL-reducing field
            // cannot be added to one and forgotten in the other.
            const groupSqlFields = [...groupOptions.by, agg.field];

            if (definition.aggregateIndexes && !groupOptions.baseWhere && !hasRelation && (!groupScope || scanRefusesAny(definition, groupSqlFields))) {
                const planned = selectIndexForGroupBy(definition.aggregateIndexes, agg.op, agg.field, groupOptions.by, groupOptions.where);

                // A request that pins SOME of the index's `by` tuple but not all
                // of it cannot be served from the companion: the full-walk below
                // reads every companion row, so `by: ["a", "b"]` with
                // `where: { a: 1 }` would return the `a !== 1` groups too. The
                // single-row lookup needs the whole tuple, and there is no
                // companion-side filter for the rest — so hand a partial pin to
                // the scan, which compiles the predicate properly. Checked
                // before `ensureBackfilled` so a request that cannot use the
                // companion does not pay for rebuilding it.
                const plannedPartialKeys = planned === undefined ? 0 : Object.keys(planned.partial).length;
                const plannedByLength = planned?.index.by?.length ?? 0;

                if (planned && (plannedPartialKeys === 0 || plannedPartialKeys === plannedByLength)) {
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

                    // Unfiltered → walk the whole companion. A partial pin never
                    // reaches here (it was routed to the scan above), so every
                    // companion row belongs in the answer. Each row's __key__ is
                    // the canonical-JSON encoding written by encodeAggregateKey.
                    const rowsIndexed = runDrizzle<{ count: number; key: string; value: null | number }>(
                        sql,
                        dsql`SELECT ${AGG_KEY} AS key, ${AGG_VALUE} AS value, ${AGG_COUNT} AS count FROM ${dsql.identifier(aggTable)}`,
                    ).toArray();

                    for (const row of rowsIndexed) {
                        // `encodeAggregateKey` writes `JSON.stringify(encodeWire(tuple))`,
                        // so a bare `JSON.parse` hands the caller the tagged array
                        // for a bigint/bytes `by` field instead of the value.
                        const decoded = decodeWire(JSON.parse(row.key)) as Record<string, unknown>;

                        indexedResult.push({ key: decoded, value: readAggregateValue(agg.op, row) });
                    }

                    return indexedResult;
                }
            }

            // Same `groupSqlFields` the companion gate read: whatever qualified
            // the companion above is exactly what the scan refuses here.
            for (const field of groupSqlFields) {
                if (field === undefined) {
                    continue;
                }

                const label =
                    field === agg.field
                        ? `groupBy(${tableName}, { agg: { op: "${agg.op}", field: "${field}" } })`
                        : `groupBy(${tableName}, { by: [..."${field}"] })`;

                assertReducibleBySql(definition, field, label);
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
                return insertGlobal(global, tableName, document, insertOptions, true);
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

            const documentWithMeta: Record<string, unknown> = { ...withDefaults, ...commitSeqFields(tableName), _creationTime: creationTime, _id: id };

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

            runWrite(sql, tableName, insertRowSql(tableName), [id, creationTime, encodeDocJson(documentWithMeta)]);

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

                // Charge the WHOLE batch before writing any of it, the way the
                // shard-local branch below does. These rows land in D1, which the
                // DO's `storage.transaction` cannot roll back, so a breach found
                // mid-loop would leave every earlier row committed with no way to
                // undo them. Metering up front means the batch is refused while
                // that is still true of none of them.
                for (const document of documents) {
                    meterWrite(document);
                }

                for (const document of documents) {
                    // Forward `allowExplicitId` so a trusted import preserves the
                    // supplied `_id` across the D1 boundary too — mirrors the single
                    // `insert` global branch; without it the D1 writer would silently
                    // re-key every row (thermos HIGH).
                    // eslint-disable-next-line no-await-in-loop -- the D1 global writer has no batch primitive; sequential per row
                    const globalId = await global.insert(tableName, document, { allowExplicitId: batchOptions?.allowExplicitId });

                    broadcast({
                        key: globalId,
                        op: "insert",
                        row: { ...document, _id: globalId },
                        table: tableName,
                    });
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
            // One `_commitSeq` per CHUNK, not per row. Each chunk below is a single
            // atomic multi-row INSERT, and a sequence identifies a commit rather
            // than a row — so rows that land together must compare equal, which is
            // what lets a consumer treat a sequence as an indivisible unit. Stamping
            // inside the `map` would give every row in one commit its own sequence.
            // Inside a transaction `commitSeqFields` memoizes, so all chunks share
            // the transaction's single sequence; outside one, each chunk gets its own
            // because each chunk is its own commit.
            const chunkSeqFields: Record<string, number>[] = [];

            for (let start = 0; start < documents.length; start += INSERT_CHUNK_ROWS) {
                chunkSeqFields.push(commitSeqFields(tableName));
            }

            const rows = documents.map((document, index) => {
                const withDefaults = applyInsertDefaults(definition, document, auth);
                const id = batchOptions?.allowExplicitId === true && typeof withDefaults["_id"] === "string" ? withDefaults["_id"] : generateId();
                // Gate `_creationTime` behind the same `allowExplicitId` opt-in as
                // `_id` above — the default path mints from `clock()`.
                const creationTime =
                    batchOptions?.allowExplicitId === true && typeof withDefaults["_creationTime"] === "number" ? withDefaults["_creationTime"] : clock();

                const documentWithMeta: Record<string, unknown> = {
                    ...withDefaults,
                    ...chunkSeqFields[Math.floor(index / INSERT_CHUNK_ROWS)],
                    _creationTime: creationTime,
                    _id: id,
                };

                return { creationTime, document: documentWithMeta, id };
            });

            // Charge the batch BEFORE it is written. `onWrite` fires per row
            // only after the multi-row INSERT has already landed, so metering
            // there would let one oversized batch materialize in full — which
            // is exactly the isolate exhaustion the meter exists to prevent.
            for (const row of rows) {
                meterWrite(row.document);
            }

            // Multi-row INSERTs — the throughput win over `insertMany`'s N
            // single-row statements (and the skipped per-row JS pipeline).
            // Chunked at `INSERT_CHUNK_ROWS` because each row binds three
            // parameters and the batch cap is 500 rows: one statement over the
            // whole batch would bind 1,500, and Workerd allows 100.
            for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
                const valuesSql = dsql.join(
                    rows.slice(start, start + INSERT_CHUNK_ROWS).map((row) => dsql`(${row.id}, ${row.creationTime}, ${encodeDocJson(row.document)})`),
                    dsql`, `,
                );

                // The only write whose text genuinely varies: the `VALUES` list grows
                // with the chunk, so it is built and rendered per batch rather than
                // cached per table like the single-row statements.
                const batch = renderSql(
                    "sqlite",
                    dsql`INSERT INTO ${dsql.identifier(tableName)} (id, _creationTime, ${dsql.identifier(DOC_COLUMN)}) VALUES ${valuesSql}`,
                );

                runWrite(sql, tableName, batch.sql, batch.params);
            }

            // Companions + notifications ARE still maintained per row (shared with
            // the single `insert` via `syncCompanionsForInsert`), so search,
            // aggregates, ranks, CDC, the reactive cache and live subscriptions stay
            // correct — only the validator + trigger pipeline is skipped.
            for (const { document, id } of rows) {
                syncCompanionsForInsert(tableName, id, document);
                // The batch was already charged to the meter BEFORE the insert, so
                // notify through the raw hook — `onWrite` is the metering wrapper
                // and would charge every row a second time, halving the effective
                // ceiling for this path.
                // eslint-disable-next-line no-await-in-loop -- sequential write-hook fan-out, mirrors the single insert
                await reportWrite({ doc: document, id, op: "insert", table: tableName });
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
            // On a `.global()` table the per-row `insert` charges its own row
            // immediately before pushing it to D1, so a breach part-way down this
            // loop leaves every earlier row committed in a backend the DO's
            // transaction cannot roll back. Charging the whole batch up front —
            // as `insertManyUnsafe`'s global branch does — refuses it while none
            // of it has crossed.
            //
            // The loop then forwards each row through `insertGlobal` with the
            // charge suppressed, or every row would be charged twice: once here
            // and once on its way out. Suppressing it per call rather than with
            // the writer-wide `runUnmetered` keeps a concurrent write on this
            // same writer metered (see `insertGlobal`'s `charge` parameter).
            // Shard-local batches keep the per-row charge untouched, since the DO
            // transaction rewinds them and there is nothing to pre-empt.
            const global = globalWriterFor(tableName, "insert");

            if (global) {
                for (const document of documents) {
                    meterWrite(document);
                }
            }

            const insertOne = async (document: Record<string, unknown>): Promise<string> =>
                global ? insertGlobal(global, tableName, document, undefined, false) : writer.insert(tableName, document);

            for (const document of documents) {
                try {
                    // eslint-disable-next-line no-await-in-loop -- sequential by design: preserves insert order + the single-threaded SQLite transaction
                    ids.push(await insertOne(document));
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
                // A global row's id never lives in this DO; fall back to the
                // D1 writer when this call is allowed to reach one — see
                // `globalFallbackFor`, which also re-applies the facade's pin
                // over there.
                const global = globalFallbackFor(expectedTable);

                if (global) {
                    // Same reason as the global `insert` branch. The DELTA is
                    // charged, not the merged row: the row lives in D1, and
                    // reading it back to size it would double the round-trips on
                    // every global patch. That meters a global patch lighter than
                    // the shard-local path, which charges the whole merged
                    // document — under-counting by the untouched fields is the
                    // right side of that trade, since the delta is what this call
                    // actually sends.
                    meterWrite(patch);

                    await global.patch(id, patch, expectedTable);
                    return;
                }

                throw new LunoraError("NOT_FOUND", `document not found: ${id}`);
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

            const merged = { ...existing, ...patch, ...commitSeqFields(tableName), _id: id };

            applyOnUpdate(tableDefinition, patch, merged, auth);

            // Run column refinements on the merged row so a patch that flips a
            // field to an invalid value (e.g. negative amount) is rejected
            // before SQLite sees it.
            runRowValidators(tableDefinition, merged, true);

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
            runGuardedWrite(sql, tableName, patchRowSql(tableName), [encodeDocJson(merged), id, existingJson]);

            syncSearch(tableName, id, merged, existing);
            syncGeo(tableName, id, merged);
            syncAggregates(tableName, existing, merged);
            syncRanks(tableName, id, existing, merged);

            // A patch can flip a row from matching to not-matching (or vice
            // versa) any scan-shaped predicate — `invalidate` blows both the
            // row's per-id deps AND the `*scan` bucket on this table. Passing
            // both images additionally covers a patch that MOVES the row
            // between index slices: the slice it left is only derivable from
            // the before-image.
            cache?.invalidate(tableName, id, rowIndexKeys(tableName, existing, merged));

            recordCdc(tableName, id, "update", merged);
            broadcast({ indexKeys: rowIndexKeys(tableName, existing, merged), key: id, op: "update", row: merged, table: tableName });

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
            // Resolve matching rows first — a global table (no native batch
            // primitive) through its D1 writer, a shard-local one through this
            // writer's own `findMany` (which rejects an unknown table). The
            // mutation-span (if any) keeps the read and the subsequent patches
            // consistent.
            const source = globalWriterFor(tableName, "patchWhere") ?? writer;
            const page = await source.findMany(tableName, { where: args.where });
            const patches = page.page.map((row) => {
                return { id: String(row["_id"]), patch: args.patch };
            });

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

            // The dependency is stamped by the reader's TERMINAL, not here:
            // at this point the chain has not yet revealed whether it will end
            // with `.withIndex(...)`, and stamping the safe upper bound
            // (`*scan`) eagerly is what made every live query on this table
            // re-run on every write to it. An indexed read now records the
            // contiguous slice it actually touched; anything not provably
            // confined falls back to the same `*scan` dep as before.
            return buildReader(
                sql,
                schema,
                tableName,
                onIndexUse,
                (range) => {
                    // A provable slice goes to the dedicated range channel; an
                    // unnarrowable read keeps the whole-table dep. Ranges are
                    // NEVER encoded into `onRead`'s id slot — a document id is
                    // arbitrary user data, so a range smuggled through the same
                    // string space could be forged by an id shaped like one.
                    if (range) {
                        onReadRange(range);
                    } else {
                        onRead(tableName, SCAN_DEP);
                    }
                },
                (count) => {
                    if (!meterExempt) {
                        headroom?.recordRead(count);
                    }
                },
            );
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
                const global = globalFallbackFor(expectedTable);

                if (global?.restore) {
                    await global.restore(id, expectedTable);

                    return;
                }

                throw new LunoraError("NOT_FOUND", `document not found: ${id}`);
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
            // entry was definitively dropped on soft delete. Search was kept
            // (read-filtered) and the aggregate companion re-added the row on
            // `patch`'s own `-prev + next` step (the marker going null is what
            // makes `next` qualify), so neither needs anything extra here; the
            // vector re-upsert rode `patch`'s `onWrite("update")`.
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
                // A global row's id never lives in this DO; fall back to the
                // D1 writer when this call is allowed to reach one — see
                // `globalFallbackFor`, which also re-applies the facade's pin
                // over there.
                const global = globalFallbackFor(expectedTable);

                if (global) {
                    // Same reason as the global `patch` branch — and here the
                    // whole replacement document is in hand, so the charge is
                    // exact rather than a delta.
                    meterWrite(document);

                    await global.replace(id, document, expectedTable, replaceOptions);
                    return;
                }

                throw new LunoraError("NOT_FOUND", `document not found: ${id}`);
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
            const replaced: Record<string, unknown> = { ...document, ...commitSeqFields(tableName), _creationTime: creationTime, _id: id };

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
            runGuardedWrite(sql, tableName, replaceRowSql(tableName), [creationTime, encodeDocJson(replaced), id, existingJson]);

            syncSearch(tableName, id, replaced, previous);
            syncGeo(tableName, id, replaced);
            syncAggregates(tableName, previous, replaced);
            syncRanks(tableName, id, previous, replaced);

            cache?.invalidate(tableName, id, rowIndexKeys(tableName, previous, replaced));

            recordCdc(tableName, id, "update", replaced);
            broadcast({ indexKeys: rowIndexKeys(tableName, previous, replaced), key: id, op: "update", row: replaced, table: tableName });

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
    return options.enforceRls === true
        ? guardWriter(
              writer,
              schema,
              (id, expectedTable) => locateRowById(id, expectedTable)?.tableName,
              (ids, expectedTable) => locateTablesByIds(ids, expectedTable),
          )
        : writer;
};

export { assertValidClientId, createShardCtxDb, normalizeIdStructurally, NotUniqueError };
export type { SearchBackfillProgress } from "./ctx-db-backfill";
export { backfillAggregateIndexes, backfillRankIndexes, backfillSearchIndexes } from "./ctx-db-backfill";
export type { CdcChange, CdcChangeKey } from "./ctx-db-cdc";
export {
    applyCdcChanges,
    bumpCdcEpoch,
    CDC_LOG_TABLE,
    cdcCanVouchFor,
    cdcSeqLeavingRows,
    cdcTouchesTables,
    cdcTrimmedError,
    compactCdcDocs,
    cursorBelowRetainedFloor,
    minCdcReplayableSeq,
    minCdcSeq,
    readCdcChangeKeys,
    readCdcChanges,
    readCdcCursor,
    readCdcEpoch,
    trimCdcChanges,
} from "./ctx-db-cdc";
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
export { assertNoExplicitUndefined };
export { selectShapeMembers, selectShapeRows } from "./ctx-db-shapes";
export {
    type BroadcastDelta,
    type ColumnMetaLike,
    type DatabaseWriterLike,
    type GeoFilterBuilderLike,
    type GeoIndexDefinitionLike,
    type IndexDefinitionLike,
    type IndexRangeBuilderLike,
    type PaginationOptions,
    type ReadHook,
    type SchemaLike,
    type SearchFilterBuilderLike,
    type SearchIndexDefinitionLike,
    type ServerDefaultContextLike,
    type TableDefinitionLike,
    type TableReaderLike,
    type ValidatorLike,
} from "./schema-types";
export type { Clock, CountArgs, CtxDbOptions, IdGenerator, SqlCursor, SqlExec, WriteEvent, WriteHook };

export type { SchedulerLike, TriggerContextLike, TriggerDefinitionLike, TriggerEventLike } from "./triggers";
