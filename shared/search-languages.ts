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

/** Membership test over {@link SEARCH_LANGUAGES}, narrowing as it goes. */
export const isSearchLanguage = (value: string): value is SearchLanguage => (SEARCH_LANGUAGES as ReadonlyArray<string>).includes(value);
