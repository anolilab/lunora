/**
 * Retrieval-side scorers — the half of RAG evaluation that judging the final
 * answer cannot reach.
 *
 * A generation scorer tells you the answer was wrong. It cannot tell you which
 * half broke: whether retrieval never surfaced the right passage (a recall
 * problem, fixed with chunking, hybrid search, or a deeper candidate pool) or
 * surfaced it and the model ignored it (a generation problem, fixed with the
 * prompt). Those have opposite fixes, so measuring only the answer sends you to
 * the wrong one half the time.
 *
 * These read the run's ranked ids from sample metadata and compare them against
 * the case's gold ids:
 *
 * ```ts
 * import { evaluate, mrrScorer, ndcgAtK, recallAtK } from "@lunora/testing";
 *
 * await evaluate(
 *     [{ input: "how do I rotate keys?", metadata: { relevant: ["security#3"] } }],
 *     async (input) => {
 *         const { chunks, context } = await docs(ctx).retrieve(input);
 *         return { metadata: { retrieved: chunks.map((chunk) => chunk.id) }, output: context };
 *     },
 *     [recallAtK(5), ndcgAtK(5), mrrScorer()],
 * );
 * ```
 *
 * `retrieved` is the run's ranked ids (best first); `relevant` is the case's
 * gold set. Both default to the metadata keys of those names — pass
 * {@link RetrievalScorerOptions} to read different ones.
 */
import { LunoraError } from "@lunora/errors";

import type { Scorer, ScoreResult, ScorerSample } from "./scorer";

/** Metadata key holding the run's ranked retrieved ids (best first). */
const RETRIEVED_KEY = "retrieved";
/** Metadata key holding the case's gold relevant ids. */
const RELEVANT_KEY = "relevant";

/** The verdict number at the start of a judge's reply (`"0.8 - reason"`). */
const LEADING_SCORE = /^\s*(-?\d+(?:\.\d+)?)/u;

/** Where a retrieval scorer reads its two id lists from. */
interface RetrievalScorerOptions {
    /** Metadata key holding the gold relevant ids. Default `"relevant"`. */
    relevantKey?: string;
    /** Metadata key holding the run's ranked retrieved ids. Default `"retrieved"`. */
    retrievedKey?: string;
}

/** One sample's ranked retrieved ids alongside the gold set to judge them against. */
interface RetrievalPair {
    relevant: ReadonlySet<string>;
    retrieved: ReadonlyArray<string>;
}

/** Read a metadata field as a list of non-empty string ids. */
const idsAt = (sample: ScorerSample, key: string): string[] => {
    const raw = sample.metadata?.[key];

    if (!Array.isArray(raw)) {
        return [];
    }

    return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
};

/**
 * Read a sample's `(retrieved, relevant)` pair, or `undefined` when the case
 * declares no gold set.
 *
 * A case with no `relevant` ids cannot be scored: every metric here is defined
 * against a gold set, and treating "nothing is relevant" as a perfect score
 * would make a mis-wired eval read as 1.0 across the board — the most dangerous
 * failure mode a quality gate has.
 */
const readPair = (sample: ScorerSample, options: RetrievalScorerOptions | undefined): RetrievalPair | undefined => {
    const relevant = idsAt(sample, options?.relevantKey ?? RELEVANT_KEY);

    if (relevant.length === 0) {
        return undefined;
    }

    return { relevant: new Set(relevant), retrieved: idsAt(sample, options?.retrievedKey ?? RETRIEVED_KEY) };
};

/** The fail-closed verdict for a case that declares no gold ids. */
const noGoldVerdict = (options: RetrievalScorerOptions | undefined): ScoreResult => {
    return { reason: `no gold ids under metadata.${options?.relevantKey ?? RELEVANT_KEY} — cannot score retrieval`, score: 0 };
};

/** Validate a `k` cutoff, which must be a positive integer when given. */
const assertK = (k: number | undefined, label: string): void => {
    if (k !== undefined && (!Number.isInteger(k) || k < 1)) {
        throw new LunoraError("BAD_REQUEST", `@lunora/testing: ${label} \`k\` must be a positive integer`);
    }
};

/** The first `k` retrieved ids, or all of them when no cutoff is set. */
const windowOf = (pair: RetrievalPair, k: number | undefined): ReadonlyArray<string> => (k === undefined ? pair.retrieved : pair.retrieved.slice(0, k));

/** Count how many of `ids` are in the gold set. */
const countHits = (ids: ReadonlyArray<string>, relevant: ReadonlySet<string>): number => ids.filter((id) => relevant.has(id)).length;

/** Discounted cumulative gain over a ranked window, under binary relevance. */
const discountedGain = (ids: ReadonlyArray<string>, relevant: ReadonlySet<string>): number => {
    let gain = 0;

    for (const [index, id] of ids.entries()) {
        if (relevant.has(id)) {
            gain += 1 / Math.log2(index + 2);
        }
    }

    return gain;
};

/** Ideal DCG: `count` gold passages packed into the top of the window. */
const idealGainOf = (count: number): number => {
    let gain = 0;

    for (let index = 0; index < count; index += 1) {
        gain += 1 / Math.log2(index + 2);
    }

    return gain;
};

/**
 * Recall@k scorer — what fraction of the gold passages made it into the top
 * `k`.
 *
 * This is the ceiling on everything downstream: a passage retrieval never
 * returned is one no reranker can promote and no prompt can cite. Omit `k` to
 * score the whole retrieved list.
 */
const recallAtK = (k?: number, options?: RetrievalScorerOptions): Scorer => {
    assertK(k, "recallAtK");

    return {
        name: k === undefined ? "recall" : `recall@${String(k)}`,
        score: (sample): ScoreResult => {
            const pair = readPair(sample, options);

            if (pair === undefined) {
                return noGoldVerdict(options);
            }

            const hits = countHits(windowOf(pair, k), pair.relevant);

            return { reason: `${String(hits)}/${String(pair.relevant.size)} gold ids retrieved`, score: hits / pair.relevant.size };
        },
    };
};

/**
 * Precision@k scorer — what fraction of the top `k` retrieved passages are
 * gold.
 *
 * This is the counterweight to recall: padding `topK` raises recall for free
 * while burying the answer in noise the model has to read past, and pay for.
 * Omit `k` to score the whole retrieved list.
 */
const precisionAtK = (k?: number, options?: RetrievalScorerOptions): Scorer => {
    assertK(k, "precisionAtK");

    return {
        name: k === undefined ? "precision" : `precision@${String(k)}`,
        score: (sample): ScoreResult => {
            const pair = readPair(sample, options);

            if (pair === undefined) {
                return noGoldVerdict(options);
            }

            const window = windowOf(pair, k);

            if (window.length === 0) {
                return { reason: "nothing retrieved", score: 0 };
            }

            const hits = countHits(window, pair.relevant);

            return { reason: `${String(hits)}/${String(window.length)} retrieved ids are gold`, score: hits / window.length };
        },
    };
};

/**
 * Mean Reciprocal Rank scorer — `1 / rank` of the first gold passage: 1 if it
 * is first, 0.5 if second, 0 if absent.
 *
 * This is the metric that notices ordering, which recall cannot. A gold passage
 * at rank 20 counts the same as rank 1 for recall@20, but only one of those
 * survives a context-window trim or a model that skims the top of its prompt.
 */
const mrrScorer = (options?: RetrievalScorerOptions): Scorer => {
    return {
        name: "mrr",
        score: (sample): ScoreResult => {
            const pair = readPair(sample, options);

            if (pair === undefined) {
                return noGoldVerdict(options);
            }

            const rank = pair.retrieved.findIndex((id) => pair.relevant.has(id));

            return rank === -1 ? { reason: "no gold id retrieved", score: 0 } : { reason: `first gold id at rank ${String(rank + 1)}`, score: 1 / (rank + 1) };
        },
    };
};

/**
 * Normalized Discounted Cumulative Gain scorer — relevance discounted
 * logarithmically by rank, divided by the best achievable arrangement.
 *
 * This is the one to gate on when comparing retrieval strategies. Unlike recall
 * it is sensitive to order, and unlike MRR it credits every gold passage rather
 * than only the first — so it is the metric that can actually say whether a
 * reranker or a hybrid leg helped.
 *
 * Relevance is binary: an id is gold or it is not, which is what a gold-id set
 * expresses. Graded relevance would need per-id weights.
 */
const ndcgAtK = (k?: number, options?: RetrievalScorerOptions): Scorer => {
    assertK(k, "ndcgAtK");

    return {
        name: k === undefined ? "ndcg" : `ndcg@${String(k)}`,
        score: (sample): ScoreResult => {
            const pair = readPair(sample, options);

            if (pair === undefined) {
                return noGoldVerdict(options);
            }

            const window = windowOf(pair, k);

            if (window.length === 0) {
                return { reason: "nothing retrieved", score: 0 };
            }

            const gain = discountedGain(window, pair.relevant);

            // The ideal is bounded by the window, so a gold set larger than `k`
            // does not drag a perfect ranking below 1.
            const idealGain = idealGainOf(Math.min(pair.relevant.size, window.length));

            return { reason: `dcg ${gain.toFixed(3)} / ideal ${idealGain.toFixed(3)}`, score: idealGain === 0 ? 0 : gain / idealGain };
        },
    };
};

/**
 * Groundedness scorer — does the answer assert only what the retrieved context
 * supports?
 *
 * This is the generation-side counterpart to the metrics above: perfect
 * retrieval still fails if the model answers from its own weights. It scores
 * the output against the context via an injected `judge`, the same shape
 * `llmScorer` takes, so this stays model-agnostic and mockable.
 *
 * Reads the context from `metadata.context` by default — the `context` string
 * `retrieve()` already returns. Fails closed: no context means nothing could
 * have grounded the answer.
 */
const groundednessScorer = (options: { contextKey?: string; judge: (prompt: string) => Promise<string>; name?: string }): Scorer => {
    if (typeof options.judge !== "function") {
        throw new LunoraError("BAD_REQUEST", "@lunora/testing: groundednessScorer requires an injected `judge` function");
    }

    const contextKey = options.contextKey ?? "context";

    return {
        name: options.name ?? "groundedness",
        score: async (sample): Promise<ScoreResult> => {
            const context = sample.metadata?.[contextKey];

            if (typeof context !== "string" || context.trim().length === 0) {
                return { reason: `no retrieved context under metadata.${contextKey}`, score: 0 };
            }

            const verdict = await options.judge(
                [
                    "Rate how well the ASSISTANT ANSWER is supported by the RETRIEVED CONTEXT below.",
                    "Score 1 if every claim in the answer is supported by the context, 0 if the answer asserts",
                    "anything the context does not support. Judge support only — do NOT reward correctness",
                    "the context does not contain.",
                    "Respond with a single number from 0 to 1, then a dash and a one-line reason.",
                    "",
                    `Retrieved context:\n${context}`,
                    "",
                    `Assistant answer: ${sample.output}`,
                ].join("\n"),
            );

            const match = LEADING_SCORE.exec(verdict);
            const parsed = match ? Number(match[1]) : 0;

            return { reason: verdict.trim(), score: Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0 };
        },
    };
};

export type { RetrievalScorerOptions };
export { groundednessScorer, mrrScorer, ndcgAtK, precisionAtK, recallAtK };
