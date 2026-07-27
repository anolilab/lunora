/**
 * The query surface of `.searchIndex()`: what a search accepts, how a match is
 * ranked, and how a page of results is addressed.
 *
 * The split from `search-text.ts` is *asked* vs *stored*. That module owns the
 * indexing side — what a token is, what text a companion holds, how far a
 * backfill has progressed — and its decisions are frozen into stored indexes.
 * This one owns the read side, whose decisions are re-made on every query and
 * can change without invalidating anything: the caps, the builder's guards, the
 * ranking, the paging algebra.
 *
 * Both halves are shared by every backend for the same reason. The two engines
 * execute a search very differently — JS scoring over a JSON blob in the DO, SQL
 * aggregation over a companion on `.global()` — so anything either one
 * reimplements is a parity bug waiting to happen, and the guards below are
 * exactly the places two implementations would drift in what they accept and in
 * what they say when they refuse.
 */

import { LunoraError } from "@lunora/errors";

import type { SearchAnalyzer } from "./analyzer";
import { splitSearchTokens } from "./text";

/**
 * One page of search results, structurally identical to the runtime's generic
 * `QueryPage`.
 *
 * Restated rather than imported because the direction of the dependency matters:
 * the engines depend on this package, not the other way round. The two shapes
 * are assignable, so a caller returning one where the other is expected still
 * type-checks.
 */
interface SearchPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Record<string, unknown>[];
}

/** Base64 for cursor text. Kept local so this package stays free of engine imports. */
const toBase64 = (text: string): string => {
    const bytes = new TextEncoder().encode(text);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary);
};

const fromBase64 = (encoded: string): string => {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);

    return new TextDecoder().decode(bytes);
};

/**
 * Cursors arrive from the client, so any decode failure is a bad request rather
 * than a server fault — a raw `TypeError` would surface as a 500.
 */
const invalidCursor = (): LunoraError => new LunoraError("BAD_REQUEST", "invalid cursor");

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
 * Split a search string into lowercased alphanumeric tokens. The Unicode
 * `\p{L}\p{N}` class guarantees tokens carry no SQL/FTS metacharacters, so they
 * need no escaping beyond the literal-phrase quoting {@link buildFtsMatch} adds.
 *
 * Repeated terms collapse to one — `.search("text", "cat cat")` is the same
 * query as `.search("text", "cat")` under the AND semantics every path
 * implements. De-duplication keeps the last occurrence so the caller's final
 * term stays final and still gets prefix matching.
 */
export const tokenizeSearch = (query: string, analyzer: SearchAnalyzer): string[] => analyzer.query(query);

/**
 * Render tokens as an FTS5 MATCH expression: each token is a quoted literal
 * phrase (neutralizes reserved words), the final token gains a trailing `*` for
 * prefix matching (asterisk outside the quotes), and they AND together so every
 * token must be present — mirroring the fallback scorer's conjunction semantics.
 */
export const buildFtsMatch = (tokens: ReadonlyArray<string>): string =>
    tokens.map((token, index) => (index === tokens.length - 1 ? `"${token}"*` : `"${token}"`)).join(" AND ");

/**
 * Score a document's indexed text against the query tokens with AND semantics:
 * every non-final token must appear exactly, the final token matches as a
 * prefix. Returns 0 (no match) unless all tokens are present; otherwise the sum
 * of occurrences, giving a coarse term-frequency relevance order — the ranking
 * the inverted index reproduces in SQL as `SUM(occurrences)`.
 */
export const scoreDocument = (text: string, tokens: ReadonlyArray<string>, analyzer: SearchAnalyzer): number => {
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
 * One candidate row an FTS5 shadow returned, decoded far enough to rank it.
 * `indexed` is the analyzed text the companion stored — what the scorer reads,
 * not the raw column.
 */
export interface SearchCandidate {
    creationTime: number;
    doc: Record<string, unknown>;
    id: string;
    indexed: string;
}

/**
 * How many rows an FTS5 candidate query must fetch to serve a read bounded by
 * `limit`.
 *
 * Never `limit` itself. bm25 decides which rows come back and
 * {@link scoreDocument} decides how they are ordered, so fetching only `limit`
 * of them would let bm25 pick a different subset than our scorer's true top-N —
 * a `.take(2)` would then disagree with the portable layout even though a
 * `.collect()` agrees.
 *
 * And never a bare {@link MAX_SEARCH_SCAN} either, which is the subtler half:
 * an unbounded read resolves to one row *past* the cap precisely so
 * {@link assertSearchWithinCap} can tell "exactly the cap" from "more than the
 * cap". Clamping the query to the cap makes that probe row unreachable and the
 * guard dead, and the caller silently receives 1024 rows as though they were
 * the whole result set — the one outcome the cap exists to prevent.
 */
export const ftsCandidateWindow = (limit: number): number => Math.max(limit, MAX_SEARCH_SCAN);

/**
 * Rank a fetched candidate window by the shared scorer and cut it to `limit`.
 *
 * Both engines run this identically — it *is* the cross-backend ordering
 * contract, down to the `_creationTime DESC` then `id ASC` tiebreak — so it
 * lives here rather than beside either of them. When each owned a copy, the
 * parity gate existed to catch them drifting apart; one implementation is
 * strictly better than a test that watches two.
 *
 * A candidate scoring zero is dropped rather than ranked last. FTS5 matched it
 * through its own tokenizer over the analyzed text we stored, so a zero here
 * means the two disagree about the document — and the portable layout, whose
 * `HAVING` requires every term, would not have returned it either.
 */
export const rankSearchRows = <Row>(
    rows: ReadonlyArray<Row>,
    toCandidate: (row: Row) => SearchCandidate | undefined,
    tokens: ReadonlyArray<string>,
    analyzer: SearchAnalyzer,
    limit: number,
): Record<string, unknown>[] => {
    const scored: { candidate: SearchCandidate; score: number }[] = [];

    for (const row of rows) {
        const candidate = toCandidate(row);

        if (!candidate) {
            continue;
        }

        const score = scoreDocument(candidate.indexed, tokens, analyzer);

        if (score > 0) {
            scored.push({ candidate, score });
        }
    }

    scored.sort(
        (left, right) =>
            right.score - left.score || right.candidate.creationTime - left.candidate.creationTime || left.candidate.id.localeCompare(right.candidate.id),
    );

    return scored.slice(0, limit).map((entry) => entry.candidate.doc);
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
 *
 * `analyzer` is required, not defaulted, because the term cap counts *analyzed*
 * terms: a backend that forgot to pass one would count under folding-only while
 * the other counted under the index's language, and the same query would be
 * accepted on one and rejected on the other. That is a compile error now.
 */
export const createSearchBuilder = (stage: SearchStageLike, tableName: string, analyzer: SearchAnalyzer): SearchBuilderLike => {
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
 * Refuse an unbounded read whose result set doesn't fit the cap.
 *
 * `.collect()` asks for one row past {@link MAX_SEARCH_SCAN} precisely so this
 * can tell "exactly the cap" from "more than the cap". Returning the prefix
 * would be the one outcome the docs promise against: a truncated result set
 * that looks complete.
 */
export const assertSearchWithinCap = (rows: ReadonlyArray<unknown>): void => {
    if (rows.length > MAX_SEARCH_SCAN) {
        throw new LunoraError(
            "BAD_REQUEST",
            `more than ${String(MAX_SEARCH_SCAN)} documents match this search — narrow it with filters or read it a page at a time with .paginate()`,
        );
    }
};

/**
 * The engine limit for one page: the window the page slices, never more than
 * the cap. `planSearchPage` has already refused anything that reaches past it,
 * so clamping here can only trim the extra probe row — which is exactly the
 * case where "is there another page?" is already answered by the cap.
 */
export const searchPageScan = (plan: SearchPagePlan): number => Math.min(plan.offset + plan.numItems + 1, MAX_SEARCH_SCAN);

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
export const finishSearchPage = (window: ReadonlyArray<Record<string, unknown>>, plan: SearchPagePlan): SearchPage => {
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
        // One past the cap, so an unbounded read can *detect* that it was
        // capped instead of silently returning a prefix — see
        // {@link assertSearchWithinCap}.
        return MAX_SEARCH_SCAN + 1;
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

export type { SearchPage };
