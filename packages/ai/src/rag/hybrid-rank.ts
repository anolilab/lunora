import type { RetrievedChunk } from "./types";

/** The standard RRF damping constant from the literature; works well across domains. */
const DEFAULT_K = 60;

/** No third leg — a shared empty list so the default costs no allocation per call. */
const NO_GRAPH_RESULTS: ReadonlyArray<RetrievedChunk> = [];

/**
 * Reciprocal Rank Fusion (RRF): merge ranked lists of chunks by their _rank
 * position_ rather than their absolute scores, which are not comparable across
 * different search methods (cosine vs BM25 vs graph proximity).
 *
 * Each result set contributes `1 / (k + rank)` to each chunk's fused score,
 * where `rank` is 0-based position in the list. The constant `k` (default 60)
 * dampens the influence of high ranks.
 *
 * The optional THIRD list is the graph leg: chunks whose source document is
 * connected to a seed hit through the schema's relation graph, ordered by the
 * depth-decaying score `ctx.db.related` assigns. Its contribution is that RRF
 * term scaled by that score, so a depth-2 neighbour adds half of what a
 * depth-1 one does even where the two are adjacent in the leg's own ranking.
 * Rank alone cannot express that: a leg of nothing but depth-3 hits would
 * otherwise contribute exactly as much as a leg of direct neighbours, which is
 * the whole distinction a proximity signal exists to carry.
 *
 * **The returned chunks carry the fused score in `score`**, multiplied by the
 * chunk's `importance` so source weighting still applies. Writing it back is
 * what makes the fusion survive: a caller that re-sorts by `score` — as
 * `retrieve()` does, to apply importance weighting — would otherwise re-order
 * by the incomparable inputs and discard the ranking this function computed.
 * Since BM25 is unbounded while cosine is `[0, 1]`, that silently promoted
 * every lexical-only hit above every vector hit.
 *
 * So in hybrid mode `RetrievedChunk.score` is an RRF score (small, ~`1/60`
 * scale), not a cosine similarity. `retrieve()` applies `minScore` to the
 * vector leg *before* fusion for exactly this reason — the option is documented
 * against the cosine scale.
 *
 * Ties are broken by preferring the chunk ranked higher in the vector result,
 * typically the more semantically accurate of the two methods.
 *
 * Callers MUST ensure every chunk in both lists carries a unique, comparable
 * `id` — guaranteed by the chunk-id scheme `${sourceId}#${chunkIndex}`.
 * @experimental
 */
const hybridRank = (
    vectorResults: ReadonlyArray<RetrievedChunk>,
    textResults: ReadonlyArray<RetrievedChunk>,
    // Explicitly annotated: a default sourced from a const (rather than an
    // inline literal) needs one under `--isolatedDeclarations`.
    graphResults: ReadonlyArray<RetrievedChunk> = NO_GRAPH_RESULTS,
    k: number = DEFAULT_K,
): ReadonlyArray<RetrievedChunk> => {
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

    for (const [rank, chunk] of graphResults.entries()) {
        // `chunk.score` on a graph-leg chunk is the depth decay (1, 0.5, 0.25 …)
        // `ctx.db.related` assigned, NOT a relevance score — see the docblock.
        // Clamped into `[0, 1]` so a hand-built leg cannot out-weigh the search
        // legs by handing in a large number.
        const proximity = Math.min(Math.max(chunk.score, 0), 1);
        const contribution = proximity / (k + rank);
        const existing = fused.get(chunk.id);

        if (existing) {
            existing.score += contribution;
        } else {
            fused.set(chunk.id, { chunk, score: contribution, vectorRank: Number.POSITIVE_INFINITY });
        }
    }

    return [...fused.values()]
        .map((entry) => {
            return { ...entry, scored: { ...entry.chunk, score: entry.score * entry.chunk.importance } };
        })
        .toSorted((a, b) => {
            const delta = b.scored.score - a.scored.score;

            if (delta !== 0) {
                return delta;
            }

            // Ties: prefer the chunk with better vector rank. Subtracting two
            // `Infinity`s is `NaN`, which makes the whole comparator
            // inconsistent and the sort order arbitrary — reachable whenever two
            // lexical-only (or later-leg-only) chunks tie on fused score.
            if (a.vectorRank === b.vectorRank) {
                return 0;
            }

            return a.vectorRank < b.vectorRank ? -1 : 1;
        })
        .map((entry) => entry.scored);
};

export default hybridRank;
