/**
 * Everything the storage backends must agree on byte-for-byte to make
 * `.searchIndex()` behave the same everywhere.
 *
 * Each backend indexes into a companion table — an FTS5 shadow where the engine
 * ships FTS5 (Cloudflare DO SQLite, D1), a portable `(token, id, occurrences)`
 * inverted table on engines that don't (Postgres and MySQL behind Hyperdrive) —
 * but the *decisions* live here: what a token is, how a document scores, what
 * the query surface accepts, and how a page of results is addressed. A backend
 * that reimplements any of these is a parity bug.
 *
 * The one thing this module cannot make identical is **collation**. Token
 * comparison happens inside the engine: MySQL's default `utf8mb4_0900_ai_ci`
 * folds case and accents, Postgres under `text_pattern_ops` compares bytes, and
 * FTS5's `unicode61` tokenizer strips diacritics. So `café` and `cafe` match
 * each other on D1 and MySQL but not on Postgres.
 */

import { LunoraError } from "@lunora/errors";

import type { QueryPage } from "./query-args";
import { fromBase64, invalidCursor, toBase64 } from "./query-args";
import type { SearchAnalyzer } from "./search-analyzer";
import { createSearchAnalyzer, defaultSearchAnalyzer } from "./search-analyzer";

/**
 * Name of the companion table backing a search index — the FTS5 shadow on
 * engines with FTS5, the inverted `(token, id, occurrences)` table elsewhere.
 * Kept distinct from any user table (the `__fts_` infix is reserved) so
 * `runShardMigrations` can create it alongside the document table without
 * collision.
 */
export const ftsTableName = (table: string, indexName: string): string => `${table}__fts_${indexName}`;

/** Column holding the indexed text in the FTS5 shadow table. */
export const FTS_TEXT_COLUMN = "__text__";

/** Column joining a companion row back to its source row, in both companion shapes. */
export const FTS_ID_COLUMN = "__id__";

/** Column holding one token of the indexed text in the portable inverted table. */
export const FTS_TOKEN_COLUMN = "__token__";

/** Column holding a token's occurrence count within one document, in the portable inverted table. */
export const FTS_COUNT_COLUMN = "__n__";

/**
 * Most terms one `.search(field, query)` may carry, after de-duplication.
 * Matches Convex; a query past this is a mistake (a whole paragraph pasted into
 * the search box) that would otherwise turn into a many-way index intersection.
 */
export const MAX_SEARCH_TERMS = 16;

/** Most `.eq()` filters one search query may chain. Matches Convex. */
export const MAX_SEARCH_FILTERS = 8;

/**
 * Most documents one search query returns from the engine. Matches Convex's
 * 1024-document limit: relevance ordering means the interesting rows are the
 * first ones, and an unbounded `.collect()` over a large corpus is never what
 * the caller wants.
 *
 * This bounds rows *returned*, not rows the engine touches — ranking is a
 * whole-index aggregate on the inverted path. It also applies to the pre-filter
 * fetch: an in-memory `.filter()` (including the one RLS installs) narrows
 * within this window rather than widening the read, so a read policy that
 * excludes most matches can leave fewer than the caller asked for.
 */
export const MAX_SEARCH_SCAN = 1024;

/**
 * Most distinct tokens one document contributes to a portable inverted index.
 * The write path issues one statement per chunk of tokens, so an unbounded
 * text column would turn a single row write into hundreds of sequential round
 * trips over Hyperdrive. Tokens past the cap are not indexed; a document that
 * large is prose, and its first thousand distinct words carry the search.
 */
export const MAX_INDEXED_TOKENS = 1000;

/**
 * The document side of tokenization: folded, alphanumeric tokens in order, with
 * repeats intact (occurrence counts are the relevance score). The `\p{L}\p{N}`
 * token shape guarantees no SQL/FTS metacharacters survive, so tokens need no
 * escaping beyond the literal-phrase quoting {@link buildFtsMatch} adds — and no
 * `LIKE` escaping in the inverted index's prefix predicate.
 *
 * Analysis (folding, stopwords) belongs to the index's `language`; see
 * {@link SearchAnalyzer}.
 */
export const splitSearchTokens = (text: string, analyzer: SearchAnalyzer = defaultSearchAnalyzer): string[] => analyzer.document(text);

/**
 * Split a search string into lowercased alphanumeric tokens. The Unicode
 * `\p{L}\p{N}` class guarantees tokens carry no SQL/FTS metacharacters, so they
 * need no escaping beyond the literal-phrase quoting {@link buildFtsMatch} adds.
 *
 * Repeated terms collapse to one — `.search("text", "cat cat")` is the same
 * query as `.search("text", "cat")` under the AND semantics every path
 * implements. De-duplication keeps the last occurrence so the caller's final
 * term stays final and still gets prefix matching.
 */
export const tokenizeSearch = (query: string, analyzer: SearchAnalyzer = defaultSearchAnalyzer): string[] => analyzer.query(query);

/**
 * Read the value a search index covers out of a document. `field` is a
 * dot-separated path (`properties.name`), matching what `.searchIndex({ field })`
 * accepts and what the `.eq()` filter refs resolve — a missing or non-object
 * segment yields `undefined`, which {@link stringifySearchText} coerces to the
 * empty string (an unindexable document, not an error).
 */
export const resolveSearchField = (document: Record<string, unknown>, field: string): unknown => {
    if (!field.includes(".")) {
        return document[field];
    }

    let current: unknown = document;

    for (const segment of field.split(".")) {
        if (current === null || typeof current !== "object" || Array.isArray(current)) {
            return undefined;
        }

        current = (current as Record<string, unknown>)[segment];
    }

    return current;
};

/**
 * Render tokens as an FTS5 MATCH expression: each token is a quoted literal
 * phrase (neutralizes reserved words), the final token gains a trailing `*` for
 * prefix matching (asterisk outside the quotes), and they AND together so every
 * token must be present — mirroring the fallback scorer's conjunction semantics.
 */
export const buildFtsMatch = (tokens: ReadonlyArray<string>): string =>
    tokens.map((token, index) => (index === tokens.length - 1 ? `"${token}"*` : `"${token}"`)).join(" AND ");

/** Coerce a search/filter field value to the text FTS indexes and the scorer scans. */
export const stringifySearchText = (value: unknown): string => {
    if (typeof value === "string") {
        return value;
    }

    if (value === null || value === undefined) {
        return "";
    }

    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
        return String(value);
    }

    // Objects/arrays (and any other non-primitive) are serialized as JSON so
    // they contribute real text to the scan instead of `[object Object]`.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify is typed `=> string` but returns undefined for a function/symbol value; the ?? keeps the scan text a string at runtime
    return JSON.stringify(value) ?? "";
};

/**
 * Score a document's indexed text against the query tokens with AND semantics:
 * every non-final token must appear exactly, the final token matches as a
 * prefix. Returns 0 (no match) unless all tokens are present; otherwise the sum
 * of occurrences, giving a coarse term-frequency relevance order — the ranking
 * the inverted index reproduces in SQL as `SUM(occurrences)`.
 */
export const scoreDocument = (text: string, tokens: ReadonlyArray<string>, analyzer: SearchAnalyzer = defaultSearchAnalyzer): number => {
    // The document side keeps repeats: occurrences are the score.
    const documentTokens = splitSearchTokens(text, analyzer);

    if (documentTokens.length === 0) {
        return 0;
    }

    let score = 0;

    for (const [index, token] of tokens.entries()) {
        const isLast = index === tokens.length - 1;
        let occurrences = 0;

        for (const documentToken of documentTokens) {
            if (isLast ? documentToken.startsWith(token) : documentToken === token) {
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
 * Whether a write leaves an index's text untouched, so its companion rows can
 * be left alone.
 *
 * Most writes touch a column the index doesn't cover — a status flip, a counter,
 * an `$onUpdateFn` timestamp — and re-tokenizing the document for those is pure
 * waste: on the inverted layout it is a DELETE plus one INSERT per 50 tokens,
 * every time, over a Hyperdrive connection. Analysis is deterministic, so an
 * unchanged source value guarantees unchanged tokens; a re-created object
 * compares unequal and simply re-indexes, which is the safe direction to be
 * wrong in.
 */
export const searchTextUnchanged = (
    previous: Record<string, unknown> | undefined,
    next: Record<string, unknown> | undefined,
    index: { field: string },
): boolean => previous !== undefined && next !== undefined && resolveSearchField(previous, index.field) === resolveSearchField(next, index.field);

/**
 * The text an FTS5 shadow row stores: the document's analyzed token stream,
 * space-joined.
 *
 * Storing analyzed tokens rather than the raw field is what puts the FTS5 path
 * under the same analysis as every other path. FTS5 tokenizes `__text__`
 * itself, with its own rules — feed it raw text and an index declaring
 * `language: "en"` would still match stopwords there, and `café` would fold on
 * one backend but not another. Feeding it tokens we already folded (and
 * stopword-filtered) leaves it nothing to disagree about: they contain no
 * punctuation or case for its tokenizer to act on.
 */
export const analyzedSearchText = (document: Record<string, unknown>, index: { field: string; language?: string }): string =>
    splitSearchTokens(stringifySearchText(resolveSearchField(document, index.field)), createSearchAnalyzer(index.language)).join(" ");

/**
 * Tally a document's indexed text into the `(token, occurrences)` rows the
 * portable inverted index stores — one row per distinct token, the count being
 * exactly what {@link scoreDocument} would add for that token. Empty text
 * yields an empty map (nothing to index, and nothing to delete beyond the
 * unconditional by-id purge the write path already issues).
 */
export const countSearchTokens = (text: string, analyzer: SearchAnalyzer = defaultSearchAnalyzer): Map<string, number> => {
    const counts = new Map<string, number>();

    for (const token of splitSearchTokens(text, analyzer)) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    return counts;
};

/**
 * The staged `.withSearchIndex(name, q => …)` query, in the shape every backend
 * fills in. The two engines execute it very differently — JSON-blob vs
 * column-per-field, sync vs async — but they stage it identically, which is
 * what lets the builder and the paging algebra below be written once.
 */
export interface SearchStageLike {
    definition: { field: string; filterFields?: ReadonlyArray<string>; language?: string };
    field: string;
    filters: { field: string; value: unknown }[];
    hasQuery: boolean;
    indexName: string;
    query: string;
}

/** The `q` handed to `.withSearchIndex(name, q => …)`. */
export interface SearchBuilderLike {
    eq: (field: string, value: unknown) => SearchBuilderLike;
    search: (field: string, query: string) => SearchBuilderLike;
}

/**
 * Build the `q` for `.withSearchIndex()`, staging the match and its `.eq()`
 * filters into `stage`. Every guard is a property of the query surface rather
 * than of any engine — an unknown filter field, a `.search()` against the wrong
 * column, too many terms, too many filters — so both backends share this one
 * implementation and can never drift in what they accept or in what they say
 * when they refuse.
 */
export const createSearchBuilder = (stage: SearchStageLike, tableName: string, analyzer: SearchAnalyzer = defaultSearchAnalyzer): SearchBuilderLike => {
    const builder: SearchBuilderLike = {
        eq: (field, value) => {
            if (!stage.definition.filterFields?.includes(field)) {
                throw new LunoraError("INTERNAL", `field "${field}" is not a filter field of search index "${stage.indexName}" on table "${tableName}"`);
            }

            if (stage.filters.length >= MAX_SEARCH_FILTERS) {
                throw new LunoraError(
                    "BAD_REQUEST",
                    `search index "${stage.indexName}" on table "${tableName}": at most ${String(MAX_SEARCH_FILTERS)} .eq() filters are supported per search query`,
                );
            }

            stage.filters.push({ field, value });

            return builder;
        },
        search: (field, query) => {
            // Alias so the mutation reads as a write to the staged query object
            // rather than to the parameter binding itself.
            const staged = stage;

            if (field !== staged.definition.field) {
                throw new LunoraError(
                    "INTERNAL",
                    `search index "${staged.indexName}" on table "${tableName}" indexes "${staged.definition.field}", not "${field}"`,
                );
            }

            const terms = tokenizeSearch(query, analyzer).length;

            if (terms > MAX_SEARCH_TERMS) {
                throw new LunoraError(
                    "BAD_REQUEST",
                    `search index "${staged.indexName}" on table "${tableName}": at most ${String(MAX_SEARCH_TERMS)} search terms are supported (got ${String(terms)})`,
                );
            }

            staged.field = field;
            staged.query = query;
            staged.hasQuery = true;

            return builder;
        },
    };

    return builder;
};

/**
 * Encode a search page cursor. Relevance order can't be keyset-seeked — the
 * sort key is a score computed per query, not a stored column — so a search
 * page is addressed by its offset into the capped result window. Base64 keeps
 * it opaque, matching the keyset cursors elsewhere so callers never learn to
 * parse one.
 */
export const encodeSearchCursor = (offset: number): string => toBase64(`search:${String(offset)}`);

/**
 * Decode a search page cursor back to its offset. Returns `undefined` for
 * anything that isn't one of ours — the caller turns that into a
 * `BAD_REQUEST`, since cursors arrive from the client.
 */
export const parseSearchCursor = (cursor: string): number | undefined => {
    let decoded: string;

    try {
        decoded = fromBase64(cursor);
    } catch {
        return undefined;
    }

    if (!decoded.startsWith("search:")) {
        return undefined;
    }

    const offset = Number(decoded.slice("search:".length));

    return Number.isInteger(offset) && offset >= 0 ? offset : undefined;
};

/** Where one search page starts and how many rows it wants. */
export interface SearchPagePlan {
    numItems: number;
    offset: number;
}

/**
 * Validate a `.paginate()` call against a search query and resolve it to an
 * offset window. Rejects the bounded (`endCursor`) form — relevance order has
 * no stable range boundary to pin — and refuses to page past
 * {@link MAX_SEARCH_SCAN} rather than quietly reporting `isDone` at the cap,
 * which would read as "no more matches" when the truth is "no more reachable".
 */
export const planSearchPage = (options: { cursor?: null | string; endCursor?: null | string; numItems: number }): SearchPagePlan => {
    if (typeof options.endCursor === "string") {
        throw new LunoraError(
            "BAD_REQUEST",
            "bounded (endCursor) pagination is not supported on search queries — relevance order has no stable range boundary",
        );
    }

    const numberItems = Math.max(0, Math.floor(options.numItems));
    const offset = options.cursor ? parseSearchCursor(options.cursor) : 0;

    if (offset === undefined) {
        throw invalidCursor();
    }

    if (offset + numberItems > MAX_SEARCH_SCAN) {
        throw new LunoraError(
            "BAD_REQUEST",
            `search pagination reaches past the ${String(MAX_SEARCH_SCAN)}-document limit (offset ${String(offset)} + ${String(numberItems)} requested) — narrow the query or the filters instead`,
        );
    }

    return { numItems: numberItems, offset };
};

/**
 * Slice a fetched window into the page the plan asked for. The caller fetches
 * one row past the page so `hasMore` is an observation, not a guess. A
 * zero-length page is terminal: without that, `continueCursor` would echo the
 * incoming cursor unchanged and a client loop would never advance.
 */
export const finishSearchPage = (window: ReadonlyArray<Record<string, unknown>>, plan: SearchPagePlan): QueryPage => {
    const end = plan.offset + plan.numItems;
    const hasMore = plan.numItems > 0 && window.length > end;

    return {
        // eslint-disable-next-line unicorn/no-null -- QueryPage.continueCursor is `null | string`: null is the documented "no further page" cursor on the wire
        continueCursor: hasMore ? encodeSearchCursor(end) : null,
        isDone: !hasMore,
        page: window.slice(plan.offset, end),
    };
};

/**
 * Resolve a caller's row limit against {@link MAX_SEARCH_SCAN}. An absent limit
 * (`.collect()`) reads the cap, so a search over a large corpus can never turn
 * into an unbounded read; an explicit limit past the cap is an error rather
 * than a silent truncation, so a caller asking for 5000 rows learns that only
 * 1024 are reachable instead of quietly acting on a prefix.
 */
export const resolveSearchScan = (limit: number | undefined): number => {
    if (limit === undefined) {
        return MAX_SEARCH_SCAN;
    }

    if (!Number.isFinite(limit)) {
        return MAX_SEARCH_SCAN;
    }

    const requested = Math.max(0, Math.floor(limit));

    if (requested > MAX_SEARCH_SCAN) {
        throw new LunoraError(
            "BAD_REQUEST",
            `search returns at most ${String(MAX_SEARCH_SCAN)} documents (asked for ${String(requested)}) — narrow the query or paginate instead`,
        );
    }

    return requested;
};
