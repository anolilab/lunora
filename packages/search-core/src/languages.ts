/**
 * The set of languages a `.searchIndex()` can declare, in one place.
 *
 * Three layers need it and none of them can import the others: `@lunora/server`
 * types the option and validates it at schema-build time, and `@lunora/do` maps
 * it onto a stopword list at analysis time — with no dependency edge between
 * them (nor should there be: the schema builder must stay usable without the DO
 * runtime). So it lived in three hand-maintained copies, where adding a
 * language silently produced a schema the builder accepts and the analyzer
 * treats as `"none"` — an index that quietly stops dropping stopwords.
 *
 * The list is the single source: the type is derived from it, so the two cannot
 * drift. `@lunora/do` still owns the stopword *lists*; it keys them by these
 * names, and its own tests assert the two agree.
 *
 * Inlined by the bundler into each `dist` rather than published, so this stays
 * a shared *constant*, not a dependency edge. See the `shared/` section of
 * AGENTS.md.
 */

/**
 * Every accepted value, sorted, so an error message can list what *is*
 * accepted without re-sorting. `"none"` is explicit rather than absent: it
 * means "fold, but drop nothing", which is also what an index with no declared
 * language gets.
 */
export const SEARCH_LANGUAGES = ["de", "en", "es", "fr", "it", "nl", "none", "pt"] as const;

/** A declared analysis language, derived from the list above. */
export type SearchLanguage = (typeof SEARCH_LANGUAGES)[number];

/**
 * How a search index is stored. `"portable"` promises identical behaviour on
 * every backend; `"native"` opts into the engine's own full-text index where it
 * has one, trading that promise for its speed.
 *
 * Lives beside the languages for the same reason they do: it is declared in
 * `@lunora/server`, acted on in the storage layer, and there is no dependency
 * edge between them — so a third hand-maintained copy is how a typo turns into
 * a silently different *physical layout*.
 */
export const SEARCH_STRATEGIES = ["native", "portable"] as const;

/** A declared storage strategy, derived from the list above. */
export type SearchStrategy = (typeof SEARCH_STRATEGIES)[number];

/** Membership test over {@link SEARCH_STRATEGIES}, narrowing as it goes. */
export const isSearchStrategy = (value: string): value is SearchStrategy => (SEARCH_STRATEGIES as ReadonlyArray<string>).includes(value);

/** Membership test over {@link SEARCH_LANGUAGES}, narrowing as it goes. */
export const isSearchLanguage = (value: string): value is SearchLanguage => (SEARCH_LANGUAGES as ReadonlyArray<string>).includes(value);
