/**
 * Text analysis for `.searchIndex()` — the step that turns a string into the
 * tokens an index stores and a query looks up.
 *
 * The analyzer is the single most load-bearing piece of the search stack,
 * because **whatever it does is baked into stored indexes**: the same analysis
 * must run over a document when it is indexed and over the query when it is
 * searched, forever, or the two stop meeting. That constraint drives two
 * decisions here.
 *
 * First, everything is deterministic and dependency-free. A stemming library
 * bumping a patch version and changing one suffix rule would silently
 * invalidate every index built before it, with no error and no obvious symptom
 * — just results quietly going missing.
 *
 * Second, an analyzer carries a {@link SearchAnalyzer.profile} string. It is
 * recorded alongside a companion's backfill progress, so changing a table's
 * `language` (or shipping a new analyzer version) is detected and rebuilds the
 * index instead of leaving half of it analyzed the old way.
 *
 * ## What analysis does today
 *
 * **Folding** (always, every language): Unicode NFD decomposition with combining
 * marks stripped, then lowercased. This is what makes `café` and `cafe` the same
 * token on every backend — without it the engines disagree, since MySQL's
 * default collation folds accents, Postgres compares bytes, and FTS5's tokenizer
 * strips them.
 *
 * **Stopwords** (when a `language` is declared): the language's function words
 * are dropped from both documents and queries, so `"the who"` neither indexes
 * nor searches on `the`.
 *
 * Stemming is deliberately **not** implemented yet. A correct Porter2 is ~250
 * lines of fiddly suffix rules, and a subtly wrong one is worse than none: it
 * would be frozen into every index built while it was wrong. The profile
 * mechanism exists so it can land later and rebuild indexes automatically.
 */

/**
 * A language whose analysis profile this runtime knows. `"none"` (the default
 * when a search index declares no language) folds text but keeps every word.
 */
type SearchLanguage = "de" | "en" | "es" | "fr" | "it" | "nl" | "none" | "pt";

/**
 * English function words. Deliberately short — an aggressive list makes
 * phrase-ish queries fail in ways users can't diagnose ("the who", "let it be"),
 * and the cost of keeping a common word is a bigger index, not a wrong answer.
 */
const EN_STOPWORDS = "a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with";

const DE_STOPWORDS =
    "aber als am an auch auf aus bei bin bis bist da dass der den des dem die das denn dir du ein eine für hat ich im in ist mit nicht noch nur oder sich sie sind über und von vor war wie wir zu zum zur";

const ES_STOPWORDS = "a al como con de del el en es la las lo los mas no o para pero por que se su sus un una uno y ya";

const FR_STOPWORDS =
    "au aux avec ce ces dans de des du elle en et eux il je la le les leur lui ma mais me même mes moi mon ne nos notre nous on ou par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous y";

const IT_STOPWORDS =
    "a ai al alla anche che chi ci coi col come con da dal degli dei del della di do e ed gli ha hai hanno i il in la le lo ma mi ne nei nel non o per più quale quanto se si sono su sul tra un una uno vi";

const NL_STOPWORDS =
    "aan al als bij dan dat de der deze die dit door een en er het hij ij in is je kan me men met mij na naar niet nog nu of om ons ook op over te tot uit van voor was wat we wij zij zijn zo";

const PT_STOPWORDS =
    "a ao aos as até com como da das de do dos e em entre era essa esse esta este eu foi há isso já mais mas me mesmo meu na nas no nos num numa o os ou para pela pelo por qual que quem se sem seu só sua também te tem um uma você";

/**
 * Combining Diacritical Marks (U+0300–U+036F) — the accents that sit on Latin,
 * Greek and Cyrillic letters.
 *
 * Deliberately narrower than `\p{M}`: that class also covers the Japanese
 * voiced sound marks (U+3099/U+309A), so stripping every mark turns `が` into
 * `か` and `パ` into `ハ`, silently merging distinct words. Korean jamo
 * decompose outside this range and are likewise left alone.
 */
const LATIN_DIACRITICS = /[\u0300-\u036F]/gu;

/**
 * Fold text to its comparison form: decompose, drop Latin diacritics,
 * recompose, lowercase.
 *
 * The trailing NFC matters — it restores the precomposed form of everything the
 * strip left alone, so scripts that decompose (Hangul syllables, kana with
 * voiced marks) come out exactly as they went in rather than as loose jamo.
 *
 * `café` folds to `cafe`. `ß` does not fold to `ss`: it has no combining
 * decomposition and would need a case-folding table this deliberately doesn't
 * carry.
 */
const foldText = (text: string): string => text.normalize("NFD").replaceAll(LATIN_DIACRITICS, "").normalize("NFC").toLowerCase();

/**
 * Stopword lists are written in their natural spelling (`für`, `même`, `até`),
 * but they are matched against *folded* tokens — so they have to go through the
 * same folding, or every accented function word would silently fail to match
 * and stay in the index.
 */
const stopwordSet = (words: string): ReadonlySet<string> => new Set(foldText(words).split(" "));

const STOPWORDS: Record<string, ReadonlySet<string>> = {
    de: stopwordSet(DE_STOPWORDS),
    en: stopwordSet(EN_STOPWORDS),
    es: stopwordSet(ES_STOPWORDS),
    fr: stopwordSet(FR_STOPWORDS),
    it: stopwordSet(IT_STOPWORDS),
    nl: stopwordSet(NL_STOPWORDS),
    none: new Set<string>(),
    pt: stopwordSet(PT_STOPWORDS),
};

/** Every language `.searchIndex({ language })` accepts. */
const SEARCH_LANGUAGES: ReadonlySet<string> = new Set(Object.keys(STOPWORDS));

/**
 * Analysis version. Bumped whenever folding, stopwords or (eventually)
 * stemming change, so every existing index is detected as stale and rebuilt
 * rather than serving half-old analysis.
 */
const ANALYZER_VERSION = 1;

/**
 * Analysis bound to one search index. `document` keeps repeats (occurrence
 * counts are the relevance score); `query` folds repeats to one, keeping the
 * caller's final term final so it still prefix-matches.
 */
interface SearchAnalyzer {
    /** Tokens for an indexed document, in order, repeats intact. */
    document: (text: string) => string[];
    /** Identity of this analysis, recorded with a companion's backfill progress. */
    profile: string;
    /** Tokens for a search query: de-duplicated, last occurrence kept last. */
    query: (query: string) => string[];
}

const analyzerCache = new Map<string, SearchAnalyzer>();

/**
 * The analyzer for a declared `language`, memoized. An unknown language folds
 * only — the schema builder rejects those up front, so reaching this path means
 * a hand-built schema, and folding-only is the safe reading of "I don't know
 * this language" rather than an error on the read path.
 */
const createSearchAnalyzer = (language: string | undefined): SearchAnalyzer => {
    const resolved = language !== undefined && SEARCH_LANGUAGES.has(language) ? language : "none";
    const cached = analyzerCache.get(resolved);

    if (cached) {
        return cached;
    }

    const stopwords = STOPWORDS[resolved] ?? new Set<string>();

    const split = (text: string): string[] => {
        const tokens = foldText(text).match(/[\p{L}\p{N}]+/gu) ?? [];

        return stopwords.size === 0 ? tokens : tokens.filter((token) => !stopwords.has(token));
    };

    const analyzer: SearchAnalyzer = {
        document: split,
        profile: `${resolved}-v${String(ANALYZER_VERSION)}`,
        query: (query) => {
            const raw = split(query);
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
        },
    };

    analyzerCache.set(resolved, analyzer);

    return analyzer;
};

/** The analyzer used when a search index declares no language: folding only. */
const defaultSearchAnalyzer: SearchAnalyzer = createSearchAnalyzer(undefined);

export type { SearchAnalyzer, SearchLanguage };
export { createSearchAnalyzer, defaultSearchAnalyzer, SEARCH_LANGUAGES };
