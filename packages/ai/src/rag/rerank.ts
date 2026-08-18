import { concurrentMap } from "./concurrent";
import type { RagReranker, RetrievedChunk } from "./types";

/** Upper bound on concurrent scorer calls, mirroring `INDEX_CONCURRENCY`'s rationale. */
const RERANK_CONCURRENCY = 8;

/** Options for {@link scoreReranker}. */
interface ScoreRerankerOptions {
    /**
     * Drop chunks scoring below this threshold, in the scorer's own scale.
     * Omitted → nothing is dropped and the reranker only reorders.
     *
     * Worth setting: reranking's real value is not just promoting the best
     * passage but *rejecting* the ones vector search only matched topically,
     * and a chunk that survives to the prompt is a chunk the model may cite.
     */
    minScore?: number;

    /**
     * Score one `(query, passage)` pair for relevance. Higher is better; the
     * scale does not matter, only the ordering it induces.
     *
     * Called once per candidate chunk. Wrap a Workers AI reranker
     * (`ctx.ai.run("@cf/baai/bge-reranker-base", …)`), a Cohere/Voyage rerank
     * endpoint, or an LLM prompted to rate relevance.
     */
    score: (query: string, text: string) => Promise<number> | number;
}

/**
 * Batched variant — score every candidate in one call.
 */
interface BatchRerankerOptions {
    /** Drop chunks scoring below this threshold. See {@link ScoreRerankerOptions.minScore}. */
    minScore?: number;

    /**
     * Score all candidates at once, returning one number per passage **in the
     * same order**. Prefer this over {@link ScoreRerankerOptions.score} when the
     * provider has a batch endpoint: cross-encoder APIs are priced and rate
     * limited per request, so N passages in one call beats N calls.
     *
     * A result whose length does not match the input is rejected rather than
     * zipped against the wrong passages.
     */
    scoreAll: (query: string, texts: ReadonlyArray<string>) => Promise<ReadonlyArray<number>> | ReadonlyArray<number>;
}

/** Reorder chunks by `scores[i]`, descending, dropping anything under `minScore`. */
const applyScores = (chunks: ReadonlyArray<RetrievedChunk>, scores: ReadonlyArray<number>, minScore: number | undefined): ReadonlyArray<RetrievedChunk> =>
    chunks
        .map((chunk, index) => {
            return { chunk, score: scores[index] as number };
        })
        .filter((entry) => Number.isFinite(entry.score) && (minScore === undefined || entry.score >= minScore))
        .toSorted((a, b) => b.score - a.score)
        // The reranker's score replaces the retrieval score: it is the one that
        // decided this ordering, so leaving the old cosine/RRF value in place
        // would show a `score` that contradicts the order it is printed in.
        .map((entry) => {
            return { ...entry.chunk, score: entry.score };
        });

/**
 * Adapt a per-passage relevance scorer into a {@link RagReranker}.
 *
 * The scorer is **injected** — `@lunora/ai` takes no provider dependency to
 * make a model call. Scoring runs with bounded concurrency so a 50-candidate
 * pool does not fan out 50 simultaneous subrequests.
 *
 * ```ts
 * defineRag({
 *   index: "docs",
 *   rerank: scoreReranker({
 *     score: async (query, text) => {
 *       const result = await ctx.ai.run("@cf/baai/bge-reranker-base", { query, contexts: [{ text }] });
 *       return result.response[0].score;
 *     },
 *   }),
 * });
 * ```
 * @experimental
 */
const scoreReranker = (options: ScoreRerankerOptions): RagReranker => {
    if (typeof options.score !== "function") {
        throw new TypeError("scoreReranker: `score` must be a function");
    }

    return async (query, chunks) => {
        if (chunks.length === 0) {
            return chunks;
        }

        const scores = await concurrentMap(chunks, RERANK_CONCURRENCY, async (chunk) => options.score(query, chunk.text));

        return applyScores(chunks, scores, options.minScore);
    };
};

/**
 * Adapt a **batch** relevance scorer into a {@link RagReranker} — one call for
 * the whole candidate pool. See {@link BatchRerankerOptions.scoreAll}.
 * @experimental
 */
const batchReranker = (options: BatchRerankerOptions): RagReranker => {
    if (typeof options.scoreAll !== "function") {
        throw new TypeError("batchReranker: `scoreAll` must be a function");
    }

    return async (query, chunks) => {
        if (chunks.length === 0) {
            return chunks;
        }

        const scores = await options.scoreAll(
            query,
            chunks.map((chunk) => chunk.text),
        );

        // Zipping a mismatched result would attach each score to the wrong
        // passage and silently produce a confident, meaningless ranking.
        if (scores.length !== chunks.length) {
            throw new TypeError(
                `batchReranker: \`scoreAll\` returned ${String(scores.length)} scores for ${String(chunks.length)} passages — it must return one score per passage, in order`,
            );
        }

        return applyScores(chunks, scores, options.minScore);
    };
};

export type { BatchRerankerOptions, ScoreRerankerOptions };
export { batchReranker, scoreReranker };
