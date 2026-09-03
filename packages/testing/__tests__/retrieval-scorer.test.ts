import { describe, expect, it, vi } from "vitest";

import { groundednessScorer, mrrScorer, ndcgAtK, precisionAtK, recallAtK } from "../src/retrieval-scorer";
import type { ScorerSample } from "../src/scorer";
import { evaluate } from "../src/scorer";

const sample = (retrieved: ReadonlyArray<string>, relevant: ReadonlyArray<string>): ScorerSample => {
    return { metadata: { relevant, retrieved }, output: "answer" };
};

describe("recallAtK", () => {
    it("scores the fraction of gold ids inside the cutoff", async () => {
        expect.assertions(1);

        const result = await recallAtK(2).score(sample(["a", "b", "c"], ["a", "c"]));

        expect(result).toMatchObject({ score: 0.5 });
    });

    it("scores the whole retrieved list when no cutoff is given", async () => {
        expect.assertions(1);

        const result = await recallAtK().score(sample(["a", "b", "c"], ["a", "c"]));

        expect(result).toMatchObject({ score: 1 });
    });

    it("fails closed when the case declares no gold ids", async () => {
        expect.assertions(2);

        const result = await recallAtK(5).score({ metadata: { retrieved: ["a"] }, output: "x" });

        // A mis-wired eval must never read as a perfect score.
        expect(result).toMatchObject({ score: 0 });
        expect((result as { reason: string }).reason).toMatch(/no gold ids/u);
    });

    it("rejects a non-positive cutoff", () => {
        expect.assertions(1);

        expect(() => recallAtK(0)).toThrow(/`k` must be a positive integer/u);
    });
});

describe("precisionAtK", () => {
    it("scores the fraction of the cutoff that is gold", async () => {
        expect.assertions(1);

        const result = await precisionAtK(4).score(sample(["a", "x", "y", "z"], ["a"]));

        expect(result).toMatchObject({ score: 0.25 });
    });

    it("scores 0 when nothing was retrieved", async () => {
        expect.assertions(1);

        const result = await precisionAtK(3).score(sample([], ["a"]));

        expect(result).toMatchObject({ score: 0 });
    });
});

describe("mrrScorer", () => {
    it("scores the reciprocal rank of the first gold hit", async () => {
        expect.assertions(2);

        const first = await mrrScorer().score(sample(["a", "b"], ["a"]));
        const third = await mrrScorer().score(sample(["x", "y", "a"], ["a"]));

        expect(first).toMatchObject({ score: 1 });
        expect(third).toMatchObject({ score: 1 / 3 });
    });

    it("scores 0 when no gold id was retrieved", async () => {
        expect.assertions(1);

        const missed = await mrrScorer().score(sample(["x", "y"], ["a"]));

        expect(missed).toMatchObject({ score: 0 });
    });

    it("distinguishes orderings that recall cannot", async () => {
        expect.assertions(3);

        const first = sample(["a", "x", "y"], ["a"]);
        const last = sample(["x", "y", "a"], ["a"]);

        // Recall@3 cannot tell these apart; MRR is the whole point.
        const recallFirst = await recallAtK(3).score(first);
        const recallLast = await recallAtK(3).score(last);
        const mrrFirst = await mrrScorer().score(first);
        const mrrLast = await mrrScorer().score(last);

        expect(recallFirst).toMatchObject({ score: 1 });
        expect(recallLast).toMatchObject({ score: 1 });
        expect(mrrFirst).not.toStrictEqual(mrrLast);
    });
});

describe("ndcgAtK", () => {
    it("scores 1 for a perfect ranking", async () => {
        expect.assertions(1);

        const result = await ndcgAtK(3).score(sample(["a", "b", "x"], ["a", "b"]));

        expect((result as { score: number }).score).toBeCloseTo(1, 10);
    });

    it("scores lower when gold ids rank below noise", async () => {
        expect.assertions(1);

        const good = (await ndcgAtK(3).score(sample(["a", "b", "x"], ["a", "b"]))) as { score: number };
        const bad = (await ndcgAtK(3).score(sample(["x", "a", "b"], ["a", "b"]))) as { score: number };

        expect(bad.score).toBeLessThan(good.score);
    });

    it("stays at 1 for a perfect ranking when the gold set exceeds the cutoff", async () => {
        expect.assertions(1);

        // Three gold ids but a cutoff of 2: the best achievable arrangement is
        // still two gold ids in the window, so this must not be penalised.
        const result = (await ndcgAtK(2).score(sample(["a", "b", "c"], ["a", "b", "c"]))) as { score: number };

        expect(result.score).toBeCloseTo(1, 10);
    });

    it("scores 0 when nothing was retrieved", async () => {
        expect.assertions(1);

        const empty = await ndcgAtK(3).score(sample([], ["a"]));

        expect(empty).toMatchObject({ score: 0 });
    });

    it("does not reward retrieving less than `k`", async () => {
        expect.assertions(2);

        // One of three gold ids inside a cutoff of 5. Normalising against the
        // RETRIEVED window instead of `k` made this a perfect 1.0 — the metric
        // this module says to gate on, rewarding a strategy for returning
        // fewer results. `recallAtK(5)` correctly says 1/3.
        const result = (await ndcgAtK(5).score(sample(["a"], ["a", "b", "c"]))) as { score: number };
        const recall = (await recallAtK(5).score(sample(["a"], ["a", "b", "c"]))) as { score: number };

        expect(result.score).toBeCloseTo(1 / (1 + 1 / Math.log2(3) + 0.5), 10);
        expect(recall.score).toBeCloseTo(1 / 3, 10);
    });

    it("credits a repeated gold id once", async () => {
        expect.assertions(2);

        // A duplicate is one passage found, not two: counting it let recall
        // exceed 1 and gave DCG a rank it never earned.
        const recall = (await recallAtK(4).score(sample(["a", "a", "a"], ["a"]))) as { score: number };
        const ndcg = (await ndcgAtK(4).score(sample(["a", "a", "a"], ["a"]))) as { score: number };

        expect(recall.score).toBe(1);
        expect(ndcg.score).toBeCloseTo(1, 10);
    });
});

describe("groundednessScorer", () => {
    it("judges the answer against the retrieved context", async () => {
        expect.assertions(2);

        const judge = vi.fn<(prompt: string) => Promise<string>>(async () => "0.9 - fully supported");
        const result = await groundednessScorer({ judge }).score({
            metadata: { context: "[source:a#0]\nKeys rotate every 90 days." },
            output: "Keys rotate every 90 days.",
        });

        expect(result).toMatchObject({ score: 0.9 });
        expect(judge.mock.calls[0]?.[0]).toContain("Keys rotate every 90 days.");
    });

    it("refuses an out-of-range judge verdict instead of clamping it to 1", async () => {
        expect.assertions(1);

        // Shares `parseJudgeScore` with `llmScorer`, so "7/10" used to score a perfect 1.
        const judge = vi.fn<(prompt: string) => Promise<string>>(async () => "7/10 - mostly supported");

        await expect(
            groundednessScorer({ judge }).score({ metadata: { context: "[source:a#0]\nKeys rotate every 90 days." }, output: "Keys rotate every 90 days." }),
        ).rejects.toThrow("did not answer with a score in [0, 1]");
    });

    it("fails closed with no retrieved context", async () => {
        expect.assertions(2);

        const judge = vi.fn<(prompt: string) => Promise<string>>(async () => "1 - great");
        const result = await groundednessScorer({ judge }).score({ output: "confident nonsense" });

        // Nothing could have grounded the answer, so it cannot be grounded.
        expect(result).toMatchObject({ score: 0 });
        expect(judge).not.toHaveBeenCalled();
    });

    it("requires an injected judge", () => {
        expect.assertions(1);

        // @ts-expect-error -- exercising the runtime guard for JS callers
        expect(() => groundednessScorer({})).toThrow(/requires an injected `judge`/u);
    });
});

describe("evaluate with run metadata", () => {
    it("merges the run's retrieved ids over the case's gold ids", async () => {
        expect.assertions(2);

        const result = await evaluate(
            [{ input: "how do I rotate keys?", metadata: { relevant: ["security#3"] } }],
            () => {
                return { metadata: { retrieved: ["security#3", "other#0"] }, output: "rotate them every 90 days" };
            },
            [recallAtK(2), precisionAtK(2)],
        );

        expect(result.items[0]?.scores["recall@2"]).toMatchObject({ score: 1 });
        expect(result.items[0]?.scores["precision@2"]).toMatchObject({ score: 0.5 });
    });

    it("still accepts a plain string producer", async () => {
        expect.assertions(1);

        const result = await evaluate([{ input: "hi", metadata: { relevant: ["a"], retrieved: ["a"] } }], () => "hello", [recallAtK(1)]);

        expect(result.average).toBe(1);
    });
});
