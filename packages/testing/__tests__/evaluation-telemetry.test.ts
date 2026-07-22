import { describe, expect, it, vi } from "vitest";

import { evaluationAttributes, recordEvaluation } from "../src/evaluation-telemetry";

describe("recordEvaluation", () => {
    it("produces gen_ai.evaluation.<name>.score for the verdict", () => {
        expect.assertions(1);

        expect(recordEvaluation({ name: "exact-match", score: 1 })).toStrictEqual({ "gen_ai.evaluation.exact-match.score": 1 });
    });

    it("adds a gen_ai.evaluation.<name>.label when a label is given", () => {
        expect.assertions(1);

        expect(recordEvaluation({ label: "pass", name: "keyword-coverage", score: 0.8 })).toStrictEqual({
            "gen_ai.evaluation.keyword-coverage.label": "pass",
            "gen_ai.evaluation.keyword-coverage.score": 0.8,
        });
    });

    it("sanitizes a scorer name carrying a colon into a well-formed key", () => {
        expect.assertions(1);

        expect(evaluationAttributes({ name: "contains:shipped", score: 1 })).toStrictEqual({ "gen_ai.evaluation.contains_shipped.score": 1 });
    });

    it("attaches the attributes to a span handle when one is passed", () => {
        expect.assertions(2);

        const setAttributes = vi.fn<(fields: Record<string, number | string>) => void>();
        const attributes = recordEvaluation({ name: "llm-judge", score: 0.5, span: { setAttributes } });

        expect(setAttributes).toHaveBeenCalledWith({ "gen_ai.evaluation.llm-judge.score": 0.5 });
        // Also returned, so a span-less caller can ship it as a standalone event/metric.
        expect(attributes).toStrictEqual({ "gen_ai.evaluation.llm-judge.score": 0.5 });
    });

    it("rejects an empty name and a non-finite score", () => {
        expect.assertions(2);

        expect(() => recordEvaluation({ name: "", score: 1 })).toThrow("non-empty `name`");
        expect(() => recordEvaluation({ name: "x", score: Number.NaN })).toThrow("finite number");
    });
});
