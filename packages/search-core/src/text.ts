/**
 * The indexing side of `.searchIndex()`: what a token is, what text a companion
 * stores, and how far a backfill has progressed.
 *
 * Everything here is *frozen into stored indexes* — the same analysis must run
 * over a document when it is indexed and over a query when it is searched, on
 * every backend, or the two stop meeting. That is why these decisions live in
 * one module rather than beside either engine, and why changing one is a
 * migration (the analyzer's profile exists to detect exactly that). The read
 * side, whose decisions are re-made per query and cost nothing to change, lives
 * in `query.ts`; how far a backfill has got lives in `backfill.ts`.
 *
 * Each backend indexes into a companion table — an FTS5 shadow where the engine
 * ships FTS5 (Cloudflare DO SQLite, D1), a portable `(token, id, occurrences)`
 * inverted table on engines that don't (Postgres and MySQL behind Hyperdrive),
 * or the engine's own index where a schema opts into `strategy: "native"` — and
 * all three store the *analyzed* token stream, so none of them gets to apply
 * its own tokenizer's rules on top.
 */

import { resolveDocumentPath } from "../../../shared/document-path";
import type { SearchAnalyzer } from "./analyzer";
import { createSearchAnalyzer } from "./analyzer";

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
 * escaping beyond the literal-phrase quoting `buildFtsMatch` adds — and no
 * `LIKE` escaping in the inverted index's prefix predicate.
 *
 * Analysis (folding, stopwords) belongs to the index's `language`; see
 * {@link SearchAnalyzer}.
 */
export const splitSearchTokens = (text: string, analyzer: SearchAnalyzer): string[] => analyzer.document(text);

/**
 * Read the value a search index covers out of a document. `field` is a
 * dot-separated path (`properties.name`), matching what `.searchIndex({ field })`
 * accepts and what the `.eq()` filter refs resolve — a missing or non-object
 * segment yields `undefined`, which {@link stringifySearchText} coerces to the
 * empty string (an unindexable document, not an error).
 */
export const resolveSearchField = (document: Record<string, unknown>, field: string): unknown => resolveDocumentPath(document, field);

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
 *
 * Capped at {@link MAX_INDEXED_TOKENS} like every other layout: an index whose
 * recall depended on which companion shape it happened to use would be the same
 * class of divergence this module exists to prevent.
 */
export const analyzedSearchText = (document: Record<string, unknown>, index: { field: string; language?: string }): string =>
    splitSearchTokens(stringifySearchText(resolveSearchField(document, index.field)), createSearchAnalyzer(index.language))
        .slice(0, MAX_INDEXED_TOKENS)
        .join(" ");

/**
 * Tally a document's indexed text into the `(token, occurrences)` rows the
 * portable inverted index stores — one row per distinct token, the count being
 * exactly what `scoreDocument` (see `search-query.ts`) would add for that token. Empty text
 * yields an empty map (nothing to index, and nothing to delete beyond the
 * unconditional by-id purge the write path already issues).
 */
export const countSearchTokens = (text: string, analyzer: SearchAnalyzer): Map<string, number> => {
    const counts = new Map<string, number>();

    for (const token of splitSearchTokens(text, analyzer)) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    return counts;
};
