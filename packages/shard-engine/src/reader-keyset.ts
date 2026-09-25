/**
 * The fluent reader's one keyset scanner, and the pieces every plain
 * (non-search, non-geo) terminal shares with it.
 *
 * `take` / `first` / `unique` / `collect` / `paginate` and the `for await`
 * iterator all read through {@link scanKeyset}. One path means one ordering, one
 * range predicate and one NULL rule: `withIndex(q => q.eq(f, null))` compiles to
 * `IS NULL` here for every terminal, as it does for `findMany({ where: { f: null } })`.
 */
import type { SqlExec } from "./ctx-db";
import { runSql } from "./do-exec";
import { DOC_COLUMN, jsonPath, quoteIdentifier, rowToDocument, serializeSqlValue } from "./do-sql";
import { buildSeekBeforeWhere, buildSeekWhere, decodeCursor, encodeCursor, normalizeOrderKeys, tiebreakDirectionFor, uniqueIndexFields } from "./query-args";
import type { OrderKey, PaginationOptions, QueryPage, TableDefinitionLike } from "./schema-types";
import type { TextFragment } from "./where-fragments";
import { joinText, rawText, textFragments } from "./where-fragments";
import type { WhereSqlStrategy } from "./where-sql";
import { compileWhereSql } from "./where-sql";
import type { WhereInput } from "./where-types";

/** A row predicate a reader applies in memory. */
type RowFilter = (record: Record<string, unknown>) => boolean;

/** The part of a staged reader the keyset scan reads: the index range and its direction. */
interface KeysetStage {
    indexFields: ReadonlyArray<string>;
    /** Result order set by `.order()`; defaults to ascending. */
    order: "asc" | "desc";
    sqlConditions: { comparator: string; field: string; value: unknown }[];
}

/**
 * Smallest first batch when an in-memory predicate may reject rows. Starting at
 * exactly the rows wanted would make `first()` under a selective `.filter()`
 * climb 1, 2, 4, … — about eleven statements to reach {@link MAX_FILTER_BATCH}.
 */
const MIN_FILTER_BATCH = 32;

/**
 * Largest keyset batch a filtered read pulls at once. Each batch after the first
 * doubles up to this, so a predicate that rejects most of the range costs a
 * logarithmic number of statements rather than one per row.
 */
const MAX_FILTER_BATCH = 1024;

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

/**
 * The flat `where` strategy in TEXT form — the twin of `ctx-db.ts`'s drizzle
 * `doWhereSqlStrategy`.
 *
 * Reads compile through this instead of the drizzle one: same traversal, same
 * SQL, assembled directly. See `where-fragments.ts` for why.
 */
const doWhereTextStrategy: WhereSqlStrategy<TextFragment> = {
    fieldRef: (field) => rawText(jsonPath(field)),
    serialize: serializeSqlValue,
};

/** An ORDER BY for `keys`, with an `id` tiebreak in the last key's direction unless an id field is already ordered. */
const compileOrderByText = (keys: OrderKey[]): string => {
    const parts = keys.map((key) => `${jsonPath(key.field)} ${key.direction === "desc" ? "DESC" : "ASC"}`);

    if (!keys.some((key) => key.field === "_id" || key.field === "id")) {
        parts.push(`${jsonPath("id")} ${tiebreakDirectionFor(keys) === "desc" ? "DESC" : "ASC"}`);
    }

    return parts.join(", ");
};

/** Invert the reader's staged SQL comparators back into `where`-tree operators. */
const COMPARATOR_TO_OPERATOR: Record<string, string> = { "<": "lt", "<=": "lte", "=": "eq", ">": "gt", ">=": "gte" };

/** The staged index fields an `.eq()` fixes to one value — a range (`.gt()`/`.lte()`) pins nothing. */
const pinnedIndexFields = (stage: KeysetStage): ReadonlySet<string> =>
    new Set(stage.sqlConditions.filter((condition) => condition.comparator === "=").map((condition) => condition.field));

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
const unpinnedIndexFields = (stage: KeysetStage): ReadonlyArray<string> => {
    const pinned = pinnedIndexFields(stage);
    let start = 0;

    while (start < stage.indexFields.length && pinned.has(stage.indexFields[start] ?? "")) {
        start += 1;
    }

    return stage.indexFields.slice(start);
};

/**
 * Order keys for a staged read: the staged index, else creation order, in the
 * staged direction.
 *
 * `shape` is the table's declared columns; it decides each key's `nullable`, which
 * is what gates the seek's `OR col IS NULL` arm (see `pivotCondition`). Routed
 * through `normalizeOrderKeys` so the fluent reader and the object-form `findMany`
 * answer that question the same way.
 */
const paginateOrderKeys = (stage: KeysetStage, definition: TableDefinitionLike): OrderKey[] => {
    const direction = stage.order;
    const orderFields = unpinnedIndexFields(stage);
    const { shape } = definition;

    if (orderFields.length > 0) {
        // The `.eq()`-pinned leading run is already gone from `orderFields`, so
        // `pinned` is handed over purely to complete the unique-index cover test:
        // a `.withIndex("by_a_b", (q) => q.eq("a", …))` over a UNIQUE `(a, b)`
        // index still orders its rows totally on `b` alone, so that read needs no
        // `_creationTime` tiebreak either.
        return normalizeOrderKeys(
            orderFields.map((field) => {
                return { [field]: direction };
            }),
            shape,
            { pinned: pinnedIndexFields(stage), uniqueBy: uniqueIndexFields(definition.indexes, shape) },
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
const paginateWhere = (stage: KeysetStage, orderKeys: OrderKey[], cursor: null | string | undefined, endCursor?: null | string): undefined | WhereInput => {
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

/** What one {@link scanKeyset} call reads. */
interface KeysetScan {
    /** Exclusive lower bound. */
    cursor?: null | string;
    /** Inclusive upper bound — a reactive page's fixed end. */
    endCursor?: null | string;
    /** Applied to every row read; only rows passing all of them are returned. */
    filters: ReadonlyArray<RowFilter>;
    /** Whether a filter may reject rows the SQL admitted, so the first batch should over-read. */
    selective: boolean;
    /** Rows to return; `undefined` reads the whole range in one statement. */
    want: number | undefined;
}

/**
 * Read up to `want` rows of the staged range that pass `filters`, in
 * {@link paginateOrderKeys} order, starting after `cursor`.
 *
 * A bounded read runs LIMIT-ed statements: the first asks for exactly `want`
 * rows (or {@link MIN_FILTER_BATCH} when a filter is selective), each later one
 * seeks past the last row READ and doubles, and the scan stops as soon as `want`
 * rows passed or a short batch shows the range is spent. So a read whose
 * filters pass every row costs `want` rows and one statement, and one whose
 * filters reject most of the range never reads it all up front.
 * @returns the rows, and the order keys their cursors encode with
 */
/** The first statement's LIMIT: the rows wanted, over-read when a filter is selective; none for a whole-range read. */
const firstBatch = (scan: KeysetScan): number | undefined => {
    if (scan.want === undefined) {
        return undefined;
    }

    return scan.selective ? Math.max(scan.want, MIN_FILTER_BATCH) : scan.want;
};

const scanKeyset = (
    sql: SqlExec,
    tableName: string,
    definition: TableDefinitionLike,
    stage: KeysetStage,
    scope: TextFragment | undefined,
    scan: KeysetScan,
    onScanned: (count: number) => void,
): { documents: Record<string, unknown>[]; orderKeys: OrderKey[] } => {
    const orderKeys = paginateOrderKeys(stage, definition);
    const order = compileOrderByText(orderKeys);
    const documents: Record<string, unknown>[] = [];
    const { filters, want } = scan;
    let seek = scan.cursor ?? undefined;
    let limit = firstBatch(scan);

    if (want === 0) {
        return { documents, orderKeys };
    }

    for (;;) {
        const range = compileWhereSql(paginateWhere(stage, orderKeys, seek, scan.endCursor), doWhereTextStrategy, textFragments);
        const statement = selectPageSql(tableName, scope && range ? joinText(range, " AND ", scope) : (scope ?? range), order, limit);
        const rows = runSql(sql, statement.text, ...statement.params).toArray();
        let last: Record<string, unknown> = {};

        onScanned(rows.length);

        for (const row of rows) {
            // A defined row always decodes; `rowToDocument` only answers `undefined` for no row.
            last = rowToDocument(row) as Record<string, unknown>;

            if (filters.every((predicate) => predicate(last)) && documents.push(last) === want) {
                return { documents, orderKeys };
            }
        }

        if (limit === undefined || rows.length < limit) {
            return { documents, orderKeys };
        }

        seek = encodeCursor(last, orderKeys);
        limit = Math.max(limit, Math.min(limit * 2, MAX_FILTER_BATCH));
    }
};

/**
 * Keyset-paginate a staged reader: order by the staged index (creation order by
 * default), seek past `cursor`, and read one row past the page to learn `isDone`.
 * The page is the first rows of {@link scanKeyset} that pass `filters`, and the
 * next cursor is the last row RETURNED, so the next page re-reads (and
 * re-rejects) whatever this one read past it — no row is skipped or repeated.
 *
 * Reactive pagination (`options.endCursor` set) instead selects the whole fixed
 * range `(cursor, endCursor]`: no `LIMIT`, `isDone` always `true` (the page's
 * end is pinned), and `continueCursor` echoed as the unchanged `endCursor` so
 * the next page keeps starting exactly where this one ends. The range stays
 * stable under inserts/deletes inside it — the page simply grows or shrinks
 * while its boundaries hold.
 */
const paginateStage = (
    sql: SqlExec,
    tableName: string,
    /** The paged table — its shape decides which ordered keys are nullable, its indexes which sorts need no `_creationTime` tiebreak. */
    definition: TableDefinitionLike,
    stage: KeysetStage,
    options: PaginationOptions,
    scope: TextFragment | undefined,
    filters: { all: ReadonlyArray<RowFilter>; selective: boolean },
    onScanned: (count: number) => void,
): QueryPage => {
    const numberItems = Math.max(0, Math.floor(options.numItems));

    // A cursor is always a non-empty base64 string, so a string distinguishes a
    // bounded page from the open-ended one (null/omitted).
    if (typeof options.endCursor === "string") {
        const { documents, orderKeys } = scanKeyset(
            sql,
            tableName,
            definition,
            stage,
            scope,
            { cursor: options.cursor, endCursor: options.endCursor, filters: filters.all, selective: filters.selective, want: undefined },
            onScanned,
        );
        // Surface the middle row's cursor so a client whose page has grown past
        // its target size can split this range in two at a stable midpoint.
        const middle = documents.length >= 2 ? documents[Math.floor(documents.length / 2) - 1] : undefined;

        return {
            continueCursor: options.endCursor,
            isDone: true,
            page: documents,
            // eslint-disable-next-line unicorn/no-null -- splitCursor is `null | string`; null marks "too small to split" so the client can read the field unconditionally
            splitCursor: middle ? encodeCursor(middle, orderKeys) : null,
        };
    }

    const { documents, orderKeys } = scanKeyset(
        sql,
        tableName,
        definition,
        stage,
        scope,
        { cursor: options.cursor, filters: filters.all, selective: filters.selective, want: numberItems + 1 },
        onScanned,
    );
    const hasMore = documents.length > numberItems;
    const page = hasMore ? documents.slice(0, numberItems) : documents;
    const last = page.at(-1);

    return {
        // eslint-disable-next-line unicorn/no-null -- QueryPage.continueCursor is `null | string`: null is the documented "no further page" cursor on the wire
        continueCursor: hasMore && last ? encodeCursor(last, orderKeys) : null,
        isDone: !hasMore,
        page,
    };
};

export type { KeysetStage, RowFilter };
export { compileOrderByText, doWhereTextStrategy, paginateOrderKeys, paginateStage, scanKeyset, selectPageSql };
