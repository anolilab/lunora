import { describe, expect, it, vi } from "vitest";

import { containsScorer, evaluate, exactMatchScorer, keywordScorer, llmScorer, regexScorer, scoreSample } from "../src/scorer";

describe("heuristic scorers", () => {
    it("containsScorer matches case-insensitively by default", () => {
        expect.assertions(2);

        expect(containsScorer("Shipped").score({ output: "it SHIPPED tuesday" })).toBe(1);
        expect(containsScorer("Shipped", { caseSensitive: true }).score({ output: "it shipped" })).toBe(0);
    });

    it("containsScorer refuses an empty needle", () => {
        expect.assertions(1);

        // Every string contains "", so this used to score every output a silent 1.
        expect(() => containsScorer("")).toThrow("requires a non-empty needle");
    });

    it("regexScorer is stateless across samples even with a /g pattern", () => {
        expect.assertions(2);

        // `.test()` on a /g regex advances `lastIndex`, so the same scorer used to
        // score every second matching sample 0.
        const scorer = regexScorer(/order #\d+/gu);

        expect(scorer.score({ output: "your order #42 shipped" })).toBe(1);
        expect(scorer.score({ output: "your order #43 shipped" })).toBe(1);
    });

    it("regexScorer scores 1 on a match", () => {
        expect.assertions(2);

        expect(regexScorer(/order #\d+/u).score({ output: "your order #42 shipped" })).toBe(1);
        expect(regexScorer(/order #\d+/u).score({ output: "no number here" })).toBe(0);
    });

    it("exactMatchScorer compares trimmed output to expected", () => {
        expect.assertions(3);

        expect(exactMatchScorer().score({ expected: "yes", output: "  yes " })).toBe(1);
        expect(exactMatchScorer().score({ expected: "yes", output: "no" })).toBe(0);
        expect(exactMatchScorer().score({ output: "yes" })).toBe(0); // no expected → 0
    });

    it("keywordScorer scores the fraction of keywords present", () => {
        expect.assertions(1);

        const result = keywordScorer(["shipped", "tuesday", "refund"]).score({ output: "It shipped Tuesday." });

        expect(result).toStrictEqual({ reason: "2/3 keywords present", score: 2 / 3 });
    });

    it("keywordScorer rejects an empty keyword list at construction", () => {
        expect.assertions(1);

        expect(() => keywordScorer([])).toThrow(/at least one keyword/u);
    });
});

describe(llmScorer, () => {
    it("parses the injected judge's numeric verdict and reason", async () => {
        expect.assertions(3);

        const judge = vi.fn<(prompt: string) => Promise<string>>(async (_prompt) => "0.9 - the answer is accurate and complete");
        const scorer = llmScorer({ criteria: "factual accuracy", judge });

        const result = await scorer.score({ input: "where is my order?", output: "It shipped." });

        expect(result).toStrictEqual({ reason: "0.9 - the answer is accurate and complete", score: 0.9 });
        // The judge was prompted with the criterion and the output.
        expect(judge.mock.calls[0]?.[0]).toContain("factual accuracy");
        expect(judge.mock.calls[0]?.[0]).toContain("It shipped.");
    });

    it("fails the eval on a garbage judge reply rather than inventing a verdict", async () => {
        expect.assertions(1);

        const scorer = llmScorer({ criteria: "x", judge: async () => "no idea" });

        await expect(scorer.score({ output: "y" })).rejects.toThrow("did not answer with a score in [0, 1]");
    });

    it("does not mis-score a reply whose leading number isn't the verdict", async () => {
        // The parser is anchored to the start, so a stray number in prose (an
        // "order #42" ref that once scored a bogus 1) no longer wins.
        expect.assertions(1);

        const scorer = llmScorer({ criteria: "x", judge: async () => "Order #42 handled well — 0.8" });

        await expect(scorer.score({ output: "y" })).rejects.toThrow("did not answer with a score in [0, 1]");
    });

    it("refuses an out-of-range or non-verdict leading number instead of clamping it to 1", async () => {
        expect.assertions(3);

        // "7/10" used to clamp to a perfect 1; "1." is a numbered list, not a score.
        await expect(llmScorer({ criteria: "x", judge: async () => "7/10" }).score({ output: "y" })).rejects.toThrow("did not answer with a score in [0, 1]");
        await expect(llmScorer({ criteria: "x", judge: async () => "1. The answer is wrong" }).score({ output: "y" })).rejects.toThrow(
            "did not answer with a score in [0, 1]",
        );
        await expect(llmScorer({ criteria: "x", judge: async () => "-2 - terrible" }).score({ output: "y" })).rejects.toThrow(
            "did not answer with a score in [0, 1]",
        );
    });
});

describe(scoreSample, () => {
    it("runs every scorer and averages the results", async () => {
        expect.assertions(3);

        const { average, scores } = await scoreSample({ expected: "shipped", output: "it shipped tuesday" }, [containsScorer("shipped"), exactMatchScorer()]);

        expect(scores["contains:shipped"]?.score).toBe(1);
        expect(scores["exact-match"]?.score).toBe(0);
        expect(average).toBe(0.5);
    });

    it("disambiguates duplicate scorer names so every verdict survives in `scores`", async () => {
        expect.assertions(4);

        const { average, scores } = await scoreSample({ expected: "yes", output: "yes" }, [exactMatchScorer(), exactMatchScorer()]);

        // Both verdicts are kept (a plain keyed record would drop one), and the
        // breakdown stays consistent with the average over both.
        expect(Object.keys(scores)).toStrictEqual(["exact-match", "exact-match#2"]);
        expect(scores["exact-match"]?.score).toBe(1);
        expect(scores["exact-match#2"]?.score).toBe(1);
        expect(average).toBe(1);
    });
});

describe(evaluate, () => {
    it("runs a dataset through `produce`, scores each, and aggregates", async () => {
        expect.assertions(4);

        const cases = [
            { expected: "shipped", input: "where is my order?" },
            { expected: "refunded", input: "cancel my order" },
        ];
        // A deterministic producer standing in for an agent harness run.
        const produce = (input: string): string => (input.includes("cancel") ? "It was refunded." : "It shipped Tuesday.");

        const result = await evaluate(cases, produce, [keywordScorer(["it"])]);

        expect(result.items).toHaveLength(2);
        expect(result.items[0]?.output).toBe("It shipped Tuesday.");
        expect(result.items[1]?.output).toBe("It was refunded.");
        // Both outputs contain "it" (case-insensitive) → every case scores 1 → average 1.
        expect(result.average).toBe(1);
    });

    it("reflects a scorer's per-case verdict in the aggregate", async () => {
        expect.assertions(3);

        const result = await evaluate([{ input: "a" }, { input: "b" }], (input) => (input === "a" ? "match" : "miss"), [containsScorer("match")]);

        expect(result.items[0]?.average).toBe(1);
        expect(result.items[1]?.average).toBe(0);
        expect(result.average).toBe(0.5);
    });
});
