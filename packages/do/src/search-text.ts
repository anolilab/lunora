/**
 * Shared FTS / text-search primitives for the DO and D1 ctx-db dialects.
 *
 * Both backends index `.searchIndex()` columns into a companion table — an FTS5
 * shadow where the engine ships FTS5 (Cloudflare DO SQLite, D1), a portable
 * `(token, id, occurrences)` inverted table on engines that don't (Postgres and
 * MySQL behind Hyperdrive) — and share this module's tokenizer, MATCH-expression
 * builder, text coercion, field resolution, limits, and scorer. Keeping every
 * dialect on these primitives is what guarantees the engines tokenize and rank
 * identically: a search that matches on a sharded DO matches the same rows, in
 * the same order, on D1 and on PlanetScale.
 */

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

/** Most `filterFields` one `.searchIndex()` may declare. Matches Convex. */
export const MAX_SEARCH_FILTER_FIELDS = 16;

/**
 * Most documents one search query reads from the engine. Matches Convex's
 * 1024-document scan limit: relevance ordering means the interesting rows are
 * the first ones, and an unbounded `.collect()` over a large corpus is never
 * what the caller wants. Applies to the pre-filter fetch, so a `.filter()`
 * applied on top narrows within this window rather than widening the read.
 */
export const MAX_SEARCH_SCAN = 1024;

/**
 * Split text into lowercased alphanumeric tokens, in order and with repeats
 * intact. The Unicode `\p{L}\p{N}` class guarantees tokens carry no SQL/FTS
 * metacharacters, so they need no escaping beyond the literal-phrase quoting
 * {@link buildFtsMatch} adds — and no `LIKE` escaping in the inverted index's
 * prefix predicate.
 *
 * This is the *document* side of the tokenizer: occurrence counts drive
 * relevance, so repeats must survive. Query strings go through
 * {@link tokenizeSearch}, which folds them.
 */
export const splitSearchTokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Split a search string into lowercased alphanumeric tokens. The Unicode
 * `\p{L}\p{N}` class guarantees tokens carry no SQL/FTS metacharacters, so they
 * need no escaping beyond the literal-phrase quoting {@link buildFtsMatch} adds.
 *
 * Repeated terms collapse to one — `.search("text", "cat cat")` is the same
 * query as `.search("text", "cat")` under the AND semantics every path
 * implements, and a duplicate would otherwise make the inverted index's
 * "matched every distinct term" test unsatisfiable. De-duplication keeps the
 * last* occurrence of a repeat so the caller's final term stays final and
 * still gets prefix matching.
 */
export const tokenizeSearch = (query: string): string[] => {
    const raw = splitSearchTokens(query);
    const seen = new Set<string>();
    const tokens: string[] = [];

    for (let index = raw.length - 1; index >= 0; index -= 1) {
        const token = raw[index] as string;

        if (!seen.has(token)) {
            seen.add(token);
            tokens.unshift(token);
        }
    }

    return tokens;
};

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
export const scoreDocument = (text: string, tokens: ReadonlyArray<string>): number => {
    // The document side keeps repeats: occurrences are the score.
    const documentTokens = splitSearchTokens(text);

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
 * Tally a document's indexed text into the `(token, occurrences)` rows the
 * portable inverted index stores — one row per distinct token, the count being
 * exactly what {@link scoreDocument} would add for that token. Empty text
 * yields an empty map (nothing to index, and nothing to delete beyond the
 * unconditional by-id purge the write path already issues).
 */
export const countSearchTokens = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();

    for (const token of splitSearchTokens(text)) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    return counts;
};

/**
 * Encode a search page cursor. Relevance order can't be keyset-seeked — the
 * sort key is a score computed per query, not a stored column — so a search
 * page is addressed by its offset into the (capped, deterministic) result
 * window. Base64 keeps it opaque, matching the keyset cursors elsewhere so
 * callers never learn to parse one.
 */
export const encodeSearchCursor = (offset: number): string => btoa(`search:${String(offset)}`);

/**
 * Decode a search page cursor back to its offset. Returns `undefined` for
 * anything that isn't one of ours — the caller turns that into a
 * `BAD_REQUEST`, since cursors arrive from the client.
 */
export const parseSearchCursor = (cursor: string): number | undefined => {
    let decoded: string;

    try {
        decoded = atob(cursor);
    } catch {
        return undefined;
    }

    if (!decoded.startsWith("search:")) {
        return undefined;
    }

    const offset = Number(decoded.slice("search:".length));

    return Number.isInteger(offset) && offset >= 0 ? offset : undefined;
};

/**
 * Clamp a caller's row limit to {@link MAX_SEARCH_SCAN}. An absent limit
 * (`.collect()`) still reads at most the cap, so a search over a large corpus
 * can never turn into a full-table read.
 */
export const clampSearchScan = (limit: number | undefined): number => {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return MAX_SEARCH_SCAN;
    }

    return Math.min(MAX_SEARCH_SCAN, Math.max(0, Math.floor(limit)));
};
