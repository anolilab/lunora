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

import type { SearchLanguage } from "./languages";
import { isSearchLanguage } from "./languages";

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
 * Combining Diacritical Marks (U+0300–U+036F) — the accents that sit on Latin
 * and Greek letters — EXCEPT a breve or diaeresis on a Cyrillic base.
 *
 * Deliberately narrower than `\p{M}`: that class also covers the Japanese
 * voiced sound marks (U+3099/U+309A), so stripping every mark turns `が` into
 * `か` and `パ` into `ハ`, silently merging distinct words. Korean jamo
 * decompose outside this range and are likewise left alone.
 *
 * The Cyrillic carve-out is the same argument. `й` decomposes to `и` + U+0306
 * and `ё` to `е` + U+0308, but these are separate LETTERS of the alphabet, not
 * accented spellings of the base — stripping them merged `бой`/`бои` and
 * `ёж`/`еж` into one token each. Every other mark on a Cyrillic base (the
 * dialectal/archaic accents) still folds, and the same marks on a Latin base
 * (`ă`, `ë`) still fold, because there they really are accents.
 */
const LATIN_DIACRITICS = /(?<=\p{Script=Cyrillic})[\u0300-\u0305\u0307\u0309-\u036F]|(?<!\p{Script=Cyrillic})[\u0300-\u036F]/gu;

/**
 * Any code point outside ASCII — the test gating {@link foldText}'s fast path.
 *
 * Written as a positive match on U+0080 and up rather than a negated ASCII range:
 * the negated form has to spell out the C0 controls, which `no-control-regex`
 * (rightly) bans. The ceiling is the full code-point maximum, not U+FFFF — under
 * `u` an astral character is a single code point and a BMP-only range would call
 * it ASCII and take the fast path with it.
 */
const NON_ASCII = /[\u0080-\u{10FFFF}]/u;

/**
 * One run of token characters. Hoisted out of the analyzer closure: a regex
 * literal allocates a fresh `RegExp` every time it is evaluated, and this one
 * sits in a function called once per indexed write and once per query. Sharing
 * it is safe because `String.prototype.match` on a `g`-flagged regex zeroes
 * `lastIndex` before scanning and leaves it at 0 after — unlike `test`/`exec`,
 * which resume from it and would make a shared instance order-dependent.
 */
const TOKEN_RUN = /[\p{L}\p{N}]+/gu;

/**
 * The scripts written without spaces between words. A token run in these is a
 * whole clause, not a word.
 *
 * `Script_Extensions`, not `Script`: the prolonged sound mark `ー` (U+30FC) is
 * `Script=Common`, so under the plain property `タワー` split into a katakana run
 * plus a stray mark instead of one word.
 */
const CJK_RUN = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]+/gu;

/** Non-global twin of {@link CJK_RUN}, for the one-per-call presence test (`test` on a `g` regex is stateful). */
const HAS_CJK = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u;

/**
 * Re-cut a token run's CJK stretches into overlapping bigrams.
 *
 * `[\p{L}\p{N}]+` has no word boundary to find in unspaced text, so
 * `北京大学は東京にある` came out as ONE token and only a PREFIX of the whole
 * clause could ever match it — searching `大学` found nothing. Overlapping
 * bigrams are the standard fallback (`北京`, `京大`, `大学`, …): both sides run
 * through the same function, so a two-character query lands on exactly one
 * bigram and a longer one on a run of them.
 *
 * Only the CJK stretches are re-cut. A mixed run like `iphone15プロ` keeps
 * `iphone15` whole and bigrams only `プロ`, and a single CJK character (already
 * a whole word) is left as itself.
 */
const expandCjkRuns = (token: string): string[] => {
    if (!HAS_CJK.test(token)) {
        return [token];
    }

    const parts: string[] = [];
    let cursor = 0;

    for (const match of token.matchAll(CJK_RUN)) {
        const start = match.index;
        // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code points ARE the unit here: the run is matched as CJK only, so it holds no emoji or grapheme cluster, and splitting by UTF-16 unit would cut an astral ideograph in half
        const run = [...match[0]];

        if (start > cursor) {
            parts.push(token.slice(cursor, start));
        }

        cursor = start + match[0].length;

        if (run.length === 1) {
            parts.push(match[0]);

            continue;
        }

        for (let offset = 0; offset + 1 < run.length; offset += 1) {
            parts.push(`${String(run[offset])}${String(run[offset + 1])}`);
        }
    }

    if (cursor < token.length) {
        parts.push(token.slice(cursor));
    }

    return parts;
};

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
const foldText = (text: string): string => {
    // ASCII is invariant under every normalization form and carries no combining
    // mark, so for an all-ASCII string the NFD, the diacritic strip and the NFC
    // are each provably the identity — only the lowercase does anything. Most
    // indexed text and most queries are ASCII, and skipping the three no-op
    // passes drops three full scans and three intermediate strings.
    //
    // This is an optimization ONLY: it must never fold anything differently,
    // because analysis is frozen into stored indexes (see the module header) and
    // a divergence here would be a silent recall bug rather than an error.
    // `__tests__/analyzer.test.ts` pins the two paths together over a Unicode sweep.
    if (!NON_ASCII.test(text)) {
        return text.toLowerCase();
    }

    return text.normalize("NFD").replaceAll(LATIN_DIACRITICS, "").normalize("NFC").toLowerCase();
};

/**
 * Stopword lists are written in their natural spelling (`für`, `même`, `até`),
 * but they are matched against *folded* tokens — so they have to go through the
 * same folding, or every accented function word would silently fail to match
 * and stay in the index.
 */
const stopwordSet = (words: string): ReadonlySet<string> => new Set(foldText(words).split(" "));

/**
 * One list per declared language. Typed over the shared union rather than
 * `string`, so adding a language to `languages.ts` without a list
 * here is a compile error instead of an index that silently stops dropping
 * function words.
 */
const STOPWORDS: Record<SearchLanguage, ReadonlySet<string>> = {
    de: stopwordSet(DE_STOPWORDS),
    en: stopwordSet(EN_STOPWORDS),
    es: stopwordSet(ES_STOPWORDS),
    fr: stopwordSet(FR_STOPWORDS),
    it: stopwordSet(IT_STOPWORDS),
    nl: stopwordSet(NL_STOPWORDS),
    none: new Set<string>(),
    pt: stopwordSet(PT_STOPWORDS),
};

/**
 * Analysis version. Bumped whenever folding, stopwords or (eventually)
 * stemming change, so every existing index is detected as stale and rebuilt
 * rather than serving half-old analysis.
 *
 * v3: CJK runs are re-cut into overlapping bigrams, and a breve/diaeresis on a
 * Cyrillic base is no longer stripped.
 */
const ANALYZER_VERSION = 3;

/**
 * Longest token that reaches an index, in characters.
 *
 * The portable companion stores one token per row in a key column that is
 * `VARCHAR(768)` on MySQL and btree-indexed on Postgres, so an unbroken
 * alphanumeric run past those limits does not degrade the search — it fails the
 * companion `INSERT`, which fails the whole mutation and tells the user their
 * row cannot be saved, naming an internal column. A run this long is a hash, a
 * base64 blob or a minified bundle, never a word, so dropping it costs nothing
 * a search would have found. Applied to documents and queries alike, so the two
 * sides agree about what is unindexable.
 */
const MAX_TOKEN_LENGTH = 256;

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
    const resolved: SearchLanguage = language !== undefined && isSearchLanguage(language) ? language : "none";
    const cached = analyzerCache.get(resolved);

    if (cached) {
        return cached;
    }

    const stopwords = STOPWORDS[resolved];

    // Left as two chained `filter`s deliberately. Fusing them into one manual
    // push-loop reads like the obvious win — one pass, one array — and measured
    // 31% SLOWER on the no-stopword path (`__bench__/analyze.bench.ts`): V8's
    // `filter` presizes its result where a growing `push` loop cannot, and
    // folding the two predicates together forces a `stopwords.has` per token
    // even for the `none` analyzer, which the early return below skips entirely.
    const split = (text: string): string[] => {
        const folded = foldText(text);
        const runs = folded.match(TOKEN_RUN) ?? [];
        // One presence test per call, not one per token: `expandCjkRuns` is a
        // no-op for the overwhelmingly common all-Latin text, and this keeps
        // that no-op off the per-token path entirely.
        const tokens = (HAS_CJK.test(folded) ? runs.flatMap((run) => expandCjkRuns(run)) : runs).filter((token) => token.length <= MAX_TOKEN_LENGTH);

        return stopwords.size === 0 ? tokens : tokens.filter((token) => !stopwords.has(token));
    };

    const analyzer: SearchAnalyzer = {
        document: split,
        profile: `${resolved}-v${String(ANALYZER_VERSION)}`,
        query: (query) => {
            const raw = split(query);

            // Keep each token's last occurrence, in order (queries are ≤ a few
            // dozen tokens, so the quadratic lastIndexOf never matters).
            return raw.filter((token, index) => raw.lastIndexOf(token) === index);
        },
    };

    analyzerCache.set(resolved, analyzer);

    return analyzer;
};

export type { SearchAnalyzer };
export { createSearchAnalyzer, MAX_TOKEN_LENGTH };
