/**
 * The Okapi BM25 scoring kernel, shared by every lexical store.
 *
 * Extracted so the in-memory reference store and the durable SQL-backed one
 * rank identically. Two implementations of the same formula drift, and a
 * ranking that changes when you swap the store for a durable one is a change
 * nobody asked for and nobody would notice until retrieval quality moved.
 * @experimental
 */

/** Term-saturation constant. 1.5 is the standard default — higher rewards repeated terms more. */
const BM25_K1 = 1.5;

/** Length-normalization constant (0 = off, 1 = full). 0.75 is the standard default. */
const BM25_B = 0.75;

/** Lowercase and split into `[a-z0-9]+` tokens — dependency-free, adequate for keyword recall. */
const TOKEN_PATTERN = /[a-z0-9]+/g;

/** Split text into lowercase alphanumeric tokens. */
const tokenize = (text: string): string[] => text.toLowerCase().match(TOKEN_PATTERN) ?? [];

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

export { BM25_B, BM25_K1, bm25Idf, bm25TermScore, tokenize };
