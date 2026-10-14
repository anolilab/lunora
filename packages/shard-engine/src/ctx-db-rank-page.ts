/**
 * Cross-shard rank-page read machinery, extracted from `ctx-db.ts`.
 *
 * This module owns the cohesive unit behind the DO writer's `rankPage()` /
 * `rankPageRows()` surfaces: encode/decode of the rank cursor, the
 * lexicographic seek-WHERE that resumes a page strictly-after a keyset row, the
 * single `IN (...)` doc hydration, and the `{ doc, key }` projection whose key
 * tuple the cross-shard query coordinator's k-way merge orders on.
 *
 * Behavior is byte-identical to the in-`ctx-db` original — the SQL text, the
 * `ORDER BY`, the cursor encoding, the echoed `directions` array, and the
 * hydration order all feed the coordinator merge and the codegen golden
 * fixture, so nothing here may shift.
 *
 * The compute and hydrate functions need the DO writer's locals (`sql`,
 * `schema`, the read hook, the rank backfill/partition guards, etc.). Those are
 * threaded explicitly through {@link RankPageDeps} rather than captured from a
 * factory closure, so the unit reads as a pure function of its dependencies.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-rank-page" mirrors its parent "ctx-db.ts" (the established public module name); `doc`/`docs` is the domain term for a stored document throughout the DO/D1 ORM. */

import { LunoraError } from "@lunora/errors";
import type { SQL } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";

import { mergeWhere } from "./aggregates";
// Type-only imports for the structural surfaces the DO writer threads in — value
// imports would create a runtime cycle with `ctx-db.ts` (which imports this module).
import type { SchemaLike, SqlExec, TableDefinitionLike } from "./ctx-db";
import { SCAN_DEP } from "./dependency-tracker";
import { runDrizzle } from "./do-exec";
import { sqliteInList } from "./drizzle";
import { CURSOR_PREFIX, decodeCursor, toBase64 } from "./query-args";
import { encodePartitionKey, RANK_TIEBREAK, rankPivotConditionSql, rankTableName, resolveRankPartition, sortColumnName } from "./rank";
import type { RankDirection, RankIndexDefinitionLike, RankPageOptions, RankPageRowKey } from "./schema-types";

const DOC_COLUMN = "__doc__";

/**
 * Encode an array of cursor values as a base64 JSON string. Matches the
 * format `decodeCursor` (`query-args.ts`) round-trips, so rank-page cursors
 * decode through the same helper as the keyset cursors that drive
 * `findMany`/`paginate`. Not `encodeCursor` (which is row-shaped) — rank
 * cursors are N-tuples.
 */
const encodeRankCursor = (values: ReadonlyArray<unknown>): string => CURSOR_PREFIX + toBase64(JSON.stringify(values));

/**
 * Resolve a `rankPage` keyset resume point to the flat `[partitionKey,
 * ...sortValues, id]` tuple the seek-WHERE consumes. Prefers the structured
 * cross-shard `after` key (the coordinator forwards `{ partitionKey, sortValues,
 * rowId }`) over the opaque shard-local `cursor`; returns `undefined` for the
 * first page (neither set).
 * @returns the decoded seek tuple, or `undefined` for a first-page (no cursor) request
 */
const resolveRankSeekTuple = (options: { after?: RankPageRowKey; cursor?: null | string }): unknown[] | undefined => {
    if (options.after) {
        return [options.after.partitionKey, ...options.after.sortValues, options.after.rowId];
    }

    return options.cursor ? decodeCursor(options.cursor) : undefined;
};

/**
 * Build the lexicographic strict-after seek branch + its bound params from a
 * decoded `[partitionKey, ...sortValues, id]` tuple, honoring each sort key's
 * direction (`<` for desc, `>` for asc; `__partition__` and the `__id__`
 * tiebreak are always ascending). Returns `undefined` when there's no cursor or
 * the tuple's arity doesn't match the index (a malformed cursor pages from the
 * start, matching the shard-local reader).
 * @returns the seek clause and its bound params, or `undefined` when there is no cursor or it is malformed
 */
const buildRankSeekClause = (
    decoded: unknown[] | undefined,
    sortColumns: ReadonlyArray<string>,
    sortBy: ReadonlyArray<{ direction?: "asc" | "desc" }>,
): SQL | undefined => {
    // Shape: [partitionKey, ...sortValues, id].
    if (decoded?.length !== 1 + sortColumns.length + 1) {
        return undefined;
    }

    const cols: { column: string; direction: "asc" | "desc" }[] = [{ column: "__partition__", direction: "asc" }];

    for (const [i, column] of sortColumns.entries()) {
        cols.push({ column, direction: sortBy[i]?.direction ?? "asc" });
    }

    cols.push({ column: RANK_TIEBREAK, direction: "asc" });

    const branches: SQL[] = [];

    for (const [pivot, col] of cols.entries()) {
        // A NULL pivot with nothing on the wanted side makes the whole branch
        // unsatisfiable — drop it rather than emit an always-false disjunct.
        const pivotCondition = rankPivotConditionSql(col.column, decoded[pivot], col.direction, true);

        if (pivotCondition === undefined) {
            continue;
        }

        const conditions: SQL[] = [];

        for (const [prefix, prefixCol] of cols.slice(0, pivot).entries()) {
            conditions.push(dsql`${dsql.identifier(prefixCol.column)} IS ${decoded[prefix]}`);
        }

        conditions.push(pivotCondition);

        const [firstCondition] = conditions;

        branches.push(conditions.length === 1 && firstCondition !== undefined ? firstCondition : dsql`(${dsql.join(conditions, dsql` AND `)})`);
    }

    if (branches.length === 0) {
        // Every pivot was a NULL at the end of its ordering: the cursor is the
        // last row there is, so no row resumes after it.
        return dsql`(1 = 0)`;
    }

    return dsql`(${dsql.join(branches, dsql` OR `)})`;
};

/** The documented "no further page" rank cursor value (`null` on the wire). */
// eslint-disable-next-line unicorn/no-null -- RankPage.continueCursor is `null | string`: null is the documented "no further page" cursor
const NO_RANK_CURSOR: null | string = null;

/**
 * Encode the next-page cursor from the last companion row of a full page —
 * `[__partition__, ...sortColumns, __id__]`, the same tuple shape
 * `decodeCursor`/`buildRankSeekClause` round-trip. Returns the "no further page"
 * sentinel when the page wasn't full (no last row).
 * @returns the base64-encoded cursor string for the next page, or `null` when the page was not full
 */
const buildRankContinueCursor = (last: Record<string, unknown> | undefined, sortColumns: ReadonlyArray<string>): null | string => {
    if (last === undefined) {
        return NO_RANK_CURSOR;
    }

    const cursorValues: unknown[] = [last["__partition__"], ...sortColumns.map((column) => last[column]), last[RANK_TIEBREAK]];

    return encodeRankCursor(cursorValues);
};

/**
 * Project a shard-local rank-companion slice into `{ doc, key }` rows. Each
 * key forwards the stored `__partition__` / `__sort_k<i>__` columns verbatim
 * (byte-identical to what the cross-shard coordinator's comparator orders on),
 * with the hydrated doc looked up from `byId`. Rows whose doc didn't hydrate
 * (a torn read) are skipped.
 */
const buildRankPageRows = (
    rankRows: ReadonlyArray<Record<string, unknown>>,
    byId: Map<string, Record<string, unknown>>,
    sortColumns: ReadonlyArray<string>,
): { doc: Record<string, unknown>; key: RankPageRowKey }[] => {
    const rows: { doc: Record<string, unknown>; key: RankPageRowKey }[] = [];

    for (const rankRow of rankRows) {
        const rowId = rankRow[RANK_TIEBREAK];

        if (typeof rowId !== "string") {
            continue;
        }

        const doc = byId.get(rowId);

        if (!doc) {
            continue;
        }

        const partitionKey = typeof rankRow["__partition__"] === "string" ? rankRow["__partition__"] : "";
        // eslint-disable-next-line unicorn/no-null -- a missing sort column is the JSON-safe `null` the coordinator's comparator orders on, not undefined (which JSON drops)
        const sortValues = sortColumns.map((column) => rankRow[column] ?? null);

        rows.push({ doc, key: { partitionKey, rowId, sortValues } });
    }

    return rows;
};

/**
 * The DO-writer locals the rank-page read unit needs. The factory
 * (`createShardCtxDb`) builds one of these and threads it into
 * `computeRankPage`, replacing what was previously closure capture so the unit
 * is a pure function of its dependencies.
 */
interface RankPageDeps {
    /** Refuse a shard-local page when the rank partition spans shards. */
    assertRankPartitionLocal: (tableName: string, definition: TableDefinitionLike, index: RankIndexDefinitionLike) => void;
    /** Lazily (re)build the rank companion the first time this ctx-db touches it. */
    ensureRankBackfilled: (tableName: string, index: RankIndexDefinitionLike) => void;
    /** Read-dependency hook — registered with `SCAN_DEP` for reactive-cache invalidation. */
    onRead: (table: string, idOrScan?: string) => void;
    /** Decode a stored SQLite row into a plain document (resolving `_id`/`_creationTime`). */
    rowToDocument: (row: Record<string, unknown> | undefined) => Record<string, unknown> | undefined;
    /** The DO writer's schema view. */
    schema: SchemaLike;
    /** Project of `state.storage.sql` — the DO's SQLite handle. */
    sql: SqlExec;
}

/** Result of {@link computeRankPage}; `directions` is shard-echoed for the cross-shard merge. */
interface RankPageComputation {
    continueCursor: null | string;
    directions: ReadonlyArray<RankDirection>;
    hasMore: boolean;
    rows: { doc: Record<string, unknown>; key: RankPageRowKey }[];
}

/** The `id` column as a drizzle chunk — the hydration membership test's left-hand side, built once. */
// eslint-disable-next-line no-restricted-syntax -- a drizzle identifier chunk, not a string conversion; the rule misfires on the inner TemplateLiteral
const hydrateIdColumn: SQL = dsql`${dsql.identifier("id")}`;

/**
 * Hydrate a page's docs by id in one `IN (...)` query (avoids an N+1 over
 * the rank companion), returning an id->doc map the caller re-projects in
 * rank order. Empty in → empty map (no SQL).
 */
const hydrateDocsById = (deps: RankPageDeps, tableName: string, ids: ReadonlyArray<string>): Map<string, Record<string, unknown>> => {
    const { rowToDocument } = deps;
    const byId = new Map<string, Record<string, unknown>>();

    if (ids.length === 0) {
        return byId;
    }

    const documentRows = runDrizzle(
        deps.sql,
        dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)} WHERE ${sqliteInList(hydrateIdColumn, ids, false)}`,
    ).toArray();

    for (const documentRow of documentRows) {
        const record = rowToDocument(documentRow);
        const recordId = documentRow["id"];

        if (record && typeof recordId === "string") {
            byId.set(recordId, record);
        }
    }

    return byId;
};

/**
 * Shared shard-local ranked-page reader behind both the user-facing
 * `rankPage()` (which projects only `{ page, continueCursor, isDone }`) and
 * the cross-shard `rankPageRows()` (which additionally attaches each row's
 * rank-key tuple). Walks the rank companion in `(__partition__, __sort_k<i>__,
 * __id__)` order, keyset-paginates with the opaque `cursor`, hydrates the
 * page's docs in one `IN (...)` query, and returns the keyed rows so the
 * query coordinator's k-way merge can order rows across shards without
 * re-deriving the key from each doc. Factored out so the two surfaces share
 * one SQL/order/hydration path — see PLAN5 §7.1 / PLAN2 #3.
 */
const computeRankPage = (deps: RankPageDeps, tableName: string, indexName: string, rankPageOptions: RankPageOptions): RankPageComputation => {
    const { assertRankPartitionLocal, ensureRankBackfilled, onRead, schema } = deps;
    const definition = schema.tables[tableName];

    if (!definition) {
        throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
    }

    const index = definition.rankIndexes?.find((i) => i.name === indexName);

    if (!index) {
        throw new LunoraError("INTERNAL", `unknown rankIndex "${indexName}" on table "${tableName}"`);
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

    const orderClauses: SQL[] = [dsql`${dsql.identifier("__partition__")} ASC`];

    for (const [i, column] of sortColumns.entries()) {
        const direction = index.sortBy[i]?.direction;

        orderClauses.push(dsql`${dsql.identifier(column)} ${dsql.raw(direction === "desc" ? "DESC" : "ASC")}`);
    }

    orderClauses.push(dsql`${dsql.identifier(RANK_TIEBREAK)} ASC`);

    const whereClauses: SQL[] = [];

    // The cross-shard coordinator forwards a pre-encoded `partitionKey`
    // (`encodePartitionKey(index.partitionBy, where)`); when present it pins
    // the partition directly. Shard-local callers omit it, so the partition
    // resolves from `where` via `resolveRankPartition`/`encodePartitionKey`.
    if (typeof rankPageOptions.partitionKey === "string") {
        whereClauses.push(dsql`${dsql.identifier("__partition__")} = ${rankPageOptions.partitionKey}`);
    } else if (partitionFromWhere) {
        whereClauses.push(dsql`${dsql.identifier("__partition__")} = ${encodePartitionKey(index.partitionBy ?? [], partitionFromWhere)}`);
    }

    // The keyset resume point comes from either the structured cross-shard
    // `after` key (the coordinator forwards `{ partitionKey, sortValues,
    // rowId }`) or the opaque shard-local `cursor`; `after` wins. Both decode
    // to the same `[partitionKey, ...sortValues, id]` tuple. The seek branch is
    // built by the module-level `buildRankSeekClause`.
    const decoded = resolveRankSeekTuple(rankPageOptions);
    const seek = buildRankSeekClause(decoded, sortColumns, index.sortBy);

    if (seek) {
        whereClauses.push(seek);
    }

    const idColumn = dsql.identifier(RANK_TIEBREAK);
    const partitionColumn = dsql.identifier("__partition__");
    const innerWhere = whereClauses.length > 0 ? dsql` WHERE ${dsql.join(whereClauses, dsql` AND `)}` : dsql``;
    const selectColumns =
        sortColumns.length > 0
            ? dsql`${idColumn}, ${partitionColumn}, ${dsql.join(
                  sortColumns.map((column) => dsql.identifier(column)),
                  dsql`, `,
              )}`
            : dsql`${idColumn}, ${partitionColumn}`;
    const query = dsql`SELECT ${selectColumns} FROM ${dsql.identifier(rankTable)}${innerWhere} ORDER BY ${dsql.join(orderClauses, dsql`, `)} LIMIT ${dsql.raw(String(take + 1))}`;
    const rankRows = runDrizzle(deps.sql, query).toArray();
    const hasMore = rankRows.length > take;
    const usable = hasMore ? rankRows.slice(0, take) : rankRows;

    // Hydrate the whole page in one `IN (...)` query (avoids an N+1), then
    // project each companion row into `{ doc, key }`, forwarding the stored
    // `__partition__` / `__sort_k<i>__` columns verbatim as the coordinator's
    // comparator key (no re-derivation from the hydrated doc).
    const pageIds = usable.map((rankRow) => rankRow[RANK_TIEBREAK] as string);
    const rows = buildRankPageRows(usable, hydrateDocsById(deps, tableName, pageIds), sortColumns);
    const continueCursor = hasMore ? buildRankContinueCursor(usable.at(-1), sortColumns) : NO_RANK_CURSOR;
    const directions: RankDirection[] = index.sortBy.map((key) => (key.direction === "desc" ? "desc" : "asc"));

    return { continueCursor, directions, hasMore, rows };
};

export { computeRankPage, resolveRankSeekTuple };
export type { RankPageComputation, RankPageDeps };
