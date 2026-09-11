import type { RetrievedChunk } from "./types";

/** The standard RRF damping constant from the literature; works well across domains. */
const DEFAULT_K = 60;

/**
 * How a leg's reciprocal-rank term is weighted before it is summed.
 *
 * `"rank"` is plain RRF: position in the leg is the only signal, which is the
 * point — cosine, BM25 and graph-proximity scores are not comparable.
 *
 * `"proximity"` additionally scales the term by the chunk's own `score`, clamped
 * into `[0, 1]`. It exists for the graph leg, where `score` is the depth decay
 * `ctx.db.related` assigned (1, 0.5, 0.25 …) rather than a relevance score: a
 * depth-2 neighbour should add half of what a depth-1 one does even where the
 * two are adjacent in the leg's own ranking. Rank alone cannot express that — a
 * leg of nothing but depth-3 hits would otherwise contribute exactly as much as
 * a leg of direct neighbours, which is the whole distinction a proximity signal
 * exists to carry.
 */
type FusionWeight = "proximity" | "rank";

/** One ranked list feeding the fusion, and the rule its contribution follows. */
interface FusionLeg {
    /** The leg's chunks, best first. */
    chunks: ReadonlyArray<RetrievedChunk>;

    /** Defaults to `"rank"`. See {@link FusionWeight}. */
    weight?: FusionWeight;
}

interface HybridRankOptions {
    /** RRF damping constant; higher flattens rank differences. Defaults to 60. */
    k?: number;
}

/**
 * Reciprocal Rank Fusion (RRF): merge ranked lists of chunks by their _rank
 * position_ rather than their absolute scores, which are not comparable across
 * different search methods (cosine vs BM25 vs graph proximity).
 *
 * Each leg contributes `1 / (k + rank)` to each chunk's fused score, where
 * `rank` is 0-based position within that leg. The constant `k` (default 60)
 * dampens the influence of high ranks. A leg declared `weight: "proximity"`
 * scales its term by the chunk's own score — see {@link FusionWeight}.
 *
 * Legs are a LIST rather than one parameter per search method: what a leg needs
 * to declare is its scoring rule, not its position, and a positional graph slot
 * forced callers with no lexical leg to write `hybridRank(vector, [], graph)`.
 *
 * **The returned chunks carry the fused score in `score`**, multiplied by the
 * chunk's `importance` so source weighting still applies. Writing it back is
 * what makes the fusion survive: a caller that re-sorts by `score` — as
 * `retrieve()` does, to apply importance weighting — would otherwise re-order
 * by the incomparable inputs and discard the ranking this function computed.
 * Since BM25 is unbounded while cosine is `[0, 1]`, that silently promoted
 * every lexical-only hit above every vector hit.
 *
 * Importance is applied ONCE, by this call. A caller with several signals passes
 * them as several legs to ONE call, never one call per leg: the returned list is
 * both weighted and sorted by that weighting, so handing it back in as a leg
 * makes the next pass derive its ranks from an already-weighted ordering and
 * weight it a second time.
 *
 * So in hybrid mode `RetrievedChunk.score` is an RRF score (small, ~`1/60`
 * scale), not a cosine similarity. `retrieve()` applies `minScore` to the
 * vector leg *before* fusion for exactly this reason — the option is documented
 * against the cosine scale.
 *
 * Ties are broken by preferring the chunk ranked higher in the FIRST leg,
 * conventionally the vector one and typically the more semantically accurate.
 *
 * Callers MUST ensure every chunk across every leg carries a unique, comparable
 * `id` — guaranteed by the chunk-id scheme `${sourceId}#${chunkIndex}`.
 * @experimental
 */
const hybridRank = (legs: ReadonlyArray<FusionLeg>, options: HybridRankOptions = {}): ReadonlyArray<RetrievedChunk> => {
    const k = options.k ?? DEFAULT_K;
    const fused = new Map<string, { chunk: RetrievedChunk; primaryRank: number; score: number }>();

    for (const [legIndex, leg] of legs.entries()) {
        const byProximity = leg.weight === "proximity";

        for (const [rank, chunk] of leg.chunks.entries()) {
            // Clamped into `[0, 1]` so a hand-built proximity leg cannot
            // out-weigh the rank legs by handing in a large number.
            const weight = byProximity ? Math.min(Math.max(chunk.score, 0), 1) : 1;
            const contribution = weight / (k + rank);
            const existing = fused.get(chunk.id);

            if (existing) {
                existing.score += contribution;
            } else {
                // The first leg is the tie-break ranking; a chunk absent from it
                // sorts after one that is present at the same fused score.
                fused.set(chunk.id, { chunk, primaryRank: legIndex === 0 ? rank : Number.POSITIVE_INFINITY, score: contribution });
            }
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

            // Ties: prefer the chunk with the better first-leg rank. Subtracting
            // two `Infinity`s is `NaN`, which makes the whole comparator
            // inconsistent and the sort order arbitrary — reachable whenever two
            // chunks absent from the first leg tie on fused score.
            if (a.primaryRank === b.primaryRank) {
                return 0;
            }

            return a.primaryRank < b.primaryRank ? -1 : 1;
        })
        .map((entry) => entry.scored);
};

export type { FusionLeg, FusionWeight, HybridRankOptions };
export { hybridRank };
