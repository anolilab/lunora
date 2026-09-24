/**
 * The full-text search core every Lunora storage backend shares.
 *
 * **Internal, not published** — bundled into its consumers, the way
 * `@lunora/dispatch` is. It is a package rather than a folder under `shared/`
 * so that it gets ESLint, its own test suite and its own coverage gate; it is
 * private so that being a package costs nothing on npm.
 *
 * Search is implemented twice — synchronously over JSON blobs inside a Durable
 * Object, asynchronously over columns on a `.global()` backend — and the two
 * must return the same documents in the same order. Everything that decides
 * which* documents and *what order* lives here, so neither engine can drift
 * from the other by reimplementing it.
 *
 * It lives outside both engines because both need it and neither may depend on
 * the other: the schema builder has to stay usable without the DO runtime, and
 * the `.global()` store must not import a Durable Object. Reaching across from
 * `@lunora/do` instead — the shape this replaced — turned two dozen internal
 * contracts into permanent public API of that package purely so the second
 * engine could reuse them.
 *
 * Zero-dependency apart from the (also zero-dependency) error layer, which the
 * query surface needs so its refusals carry a code the runtime renders as a
 * 400 rather than a 500. Analysis is baked into stored indexes, so a transitive
 * dependency changing one suffix rule would silently invalidate every index
 * built before it.
 *
 * ## The modules, in dependency order
 *
 * `languages` holds the declared analysis languages and storage strategies —
 * the single source both the schema builder and the engines validate against.
 * `analyzer` decides what a token *is*: folding, stopwords, and the versioned
 * profile that makes a change to either detectable. `text` is the indexing
 * side, holding what a companion stores and the caps on it. `query` is the read
 * side: the query surface's guards, the scorer, the ranking and the paging
 * algebra. `backfill` records how far an index has got and decides what the
 * next pass should do.
 *
 * ## Before changing anything here
 *
 * **Analysis is stored.** The same analysis must run over a document when it is
 * indexed and over the query when it is searched, forever, or the two stop
 * meeting. If you change folding, stopwords, the token-length cap or (one day)
 * stemming, bump `ANALYZER_VERSION` — the profile recorded with each
 * companion's progress is what turns that into a rebuild instead of an index
 * that half-matches, silently, for the rest of its life.
 */

export type { SearchAnalyzer } from "./analyzer";
export { createSearchAnalyzer, MAX_TOKEN_LENGTH } from "./analyzer";
export type { SearchBackfillPass, SearchBackfillState } from "./backfill";
export { planSearchBackfillPass, searchCoverageSurvives, searchIndexProfile } from "./backfill";
export type { SearchLanguage, SearchStrategy } from "./languages";
export { isSearchLanguage, isSearchStrategy, SEARCH_LANGUAGES, SEARCH_STRATEGIES } from "./languages";
export type { SearchBuilderLike, SearchPage, SearchPagePlan, SearchStageLike } from "./query";
export {
    assertSearchWithinCap,
    buildFtsMatch,
    createSearchBuilder,
    encodeSearchCursor,
    finishSearchPage,
    MAX_SEARCH_FILTERS,
    MAX_SEARCH_SCAN,
    MAX_SEARCH_TERMS,
    parseSearchCursor,
    planSearchPage,
    resolveSearchScan,
    scoreTokens,
    searchPageScan,
    searchTermRange,
    tokenizeSearch,
} from "./query";
export {
    analyzedSearchText,
    analyzedSearchTokens,
    countSearchTokens,
    FTS_COUNT_COLUMN,
    FTS_ID_COLUMN,
    FTS_TEXT_COLUMN,
    FTS_TOKEN_COLUMN,
    ftsTableName,
    MAX_INDEXED_TOKENS,
    resolveSearchField,
    searchTextUnchanged,
    splitSearchTokens,
    stringifySearchText,
} from "./text";
