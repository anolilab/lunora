import type { RetrievedChunk } from "./types";

/**
 * Reciprocal Rank Fusion (RRF): merge two ranked lists of chunks by their
 * _rank position_ rather than their absolute scores, which are not comparable
 * across different search methods (cosine vs BM25).
 *
 * Each result set contributes `1 / (k + rank)` to each chunk's fused score,
 * where `rank` is 0-based position in the list. The constant `k` (default 60)
 * dampens the influence of high ranks — the standard value from the RRF
 * literature that works well across domains.
 *
 * The fused list is sorted descending by fused score. Ties are broken by
 * preferring the chunk ranked higher in the vector search result (typically
 * the more semantically accurate of the two methods).
 *
 * Callers MUST ensure every chunk in both lists carries a unique, comparable
 * `id` — this is guaranteed by the chunk-id scheme `${sourceId}#${chunkIndex}`.
 * @experimental
 */
const hybridRank = (vectorResults: ReadonlyArray<RetrievedChunk>, textResults: ReadonlyArray<RetrievedChunk>, k = 60): ReadonlyArray<RetrievedChunk> => {
    const fused = new Map<string, { chunk: RetrievedChunk; score: number; vectorRank: number }>();

    for (const [rank, chunk] of vectorResults.entries()) {
        fused.set(chunk.id, { chunk, score: 1 / (k + rank), vectorRank: rank });
    }

    for (const [rank, chunk] of textResults.entries()) {
        const existing = fused.get(chunk.id);

        if (existing) {
            existing.score += 1 / (k + rank);
        } else {
            fused.set(chunk.id, { chunk, score: 1 / (k + rank), vectorRank: Number.POSITIVE_INFINITY });
        }
    }

    return [...fused.values()]
        .toSorted((a, b) => {
            const delta = b.score - a.score;

            // Ties: prefer the chunk with better vector rank.
            return delta === 0 ? a.vectorRank - b.vectorRank : delta;
        })
        .map((entry) => entry.chunk);
};

export default hybridRank;
