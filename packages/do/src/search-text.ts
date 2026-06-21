/**
 * Shared FTS / text-search primitives for the DO and D1 ctx-db dialects.
 *
 * Both backends index `.searchIndex()` columns into an FTS5 shadow table and
 * fall back to a JS scan-and-score path when FTS5 is unavailable. The
 * tokenizer, MATCH-expression builder, text coercion, and fallback scorer are
 * dialect-agnostic, so they live here and are imported by both
 * `ctx-db.ts` (`@lunora/do`) and `d1-ctx-db.ts` (`@lunora/d1`) — guaranteeing the
 * two engines tokenize and rank byte-for-byte identically.
 */

/**
 * Name of the FTS5 shadow table backing a search index. Kept distinct from any
 * user table (the `__fts_` infix is reserved) so `runShardMigrations` can create
 * it alongside the document table without collision.
 */
export const ftsTableName = (table: string, indexName: string): string => `${table}__fts_${indexName}`;

/**
 * Split a search string into lowercased alphanumeric tokens. The Unicode
 * `\p{L}\p{N}` class guarantees tokens carry no SQL/FTS metacharacters, so they
 * need no escaping beyond the literal-phrase quoting {@link buildFtsMatch} adds.
 */
export const tokenizeSearch = (query: string): string[] => query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

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
 * of occurrences, giving a coarse term-frequency relevance order for the
 * LIKE-scan fallback used when FTS5 is unavailable.
 */
export const scoreDocument = (text: string, tokens: ReadonlyArray<string>): number => {
    const documentTokens = tokenizeSearch(text);

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
