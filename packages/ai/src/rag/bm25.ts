/**
 * The Okapi BM25 scoring kernel, shared by every lexical store.
 *
 * Extracted so the in-memory reference store and the durable SQL-backed one
 * rank identically. Two implementations of the same formula drift, and a
 * ranking that changes when you swap the store for a durable one is a change
 * nobody asked for and nobody would notice until retrieval quality moved.
 * @experimental
 */

// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/search-core is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { createSearchAnalyzer } from "@lunora/search-core";

/** Term-saturation constant. 1.5 is the standard default — higher rewards repeated terms more. */
const BM25_K1 = 1.5;

/** Length-normalization constant (0 = off, 1 = full). 0.75 is the standard default. */
const BM25_B = 0.75;

/**
 * The analysis both lexical stores index and search through — the same one
 * `.global()` and Durable Object full-text search already use.
 *
 * Not hand-rolled here, and specifically not `/[a-z0-9]+/`: that splitter
 * produces ZERO tokens for German, French, Japanese or Cyrillic text, both
 * stores skip token-less chunks, and hybrid retrieval then degrades to
 * vector-only with nothing logged. `createSearchAnalyzer` splits on
 * `[\p{L}\p{N}]+`, NFD-folds diacritics so `Grüße` and `Grusse` meet, and caps
 * token length.
 *
 * `undefined` selects the language-neutral profile: no stopword list, because a
 * RAG corpus is not declared to be in one language and dropping English
 * function words from a French index would be worse than dropping none.
 *
 * Analysis is PERSISTED by the durable store, so changing what a token is here
 * means re-indexing every deployed lexical store.
 */
const analyzer = createSearchAnalyzer(undefined);

/** Split document text into index tokens, repeats intact (term frequency is the score). */
const tokenize = (text: string): string[] => analyzer.document(text);

/** Split a query into its distinct terms, in order. */
const tokenizeQuery = (query: string): string[] => analyzer.query(query);

/**
 * BM25 "plus" inverse document frequency — always non-negative, so a term
 * common enough to appear in most documents contributes nothing rather than
 * subtracting score.
 */
const bm25Idf = (documentCount: number, documentFrequency: number): number =>
    Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));

/** One term's contribution to a document's score. */
const bm25TermScore = (idf: number, frequency: number, documentLength: number, averageLength: number): number => {
    const denominator = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * documentLength) / averageLength);

    return idf * ((frequency * (BM25_K1 + 1)) / denominator);
};

export { BM25_B, BM25_K1, bm25Idf, bm25TermScore, tokenize, tokenizeQuery };
