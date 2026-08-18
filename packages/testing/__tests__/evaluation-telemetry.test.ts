import { describe, expect, it, vi } from "vitest";

import { evaluationAttributes as sharedEvaluationAttributes } from "../../../shared/evaluation-attributes";
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

describe("evaluationAttributes wire-format parity with shared/evaluation-attributes", () => {
    // `@lunora/testing` delegates to the shared `gen_ai.evaluation.*` builder (see
    // shared/evaluation-attributes.ts) so scorers and the runtime's own
    // `recordEvaluation` never drift. This locks the emitted keys/values equal for
    // a representative set of inputs, including sanitisation and unicode.
    const cases: { label?: string; name: string; score: number }[] = [
        { name: "exact-match", score: 1 },
        { label: "pass", name: "keyword-coverage", score: 0.8 },
        { name: "contains:shipped", score: 1 },
        { label: "fail-hard", name: "my scorer!! (v2)", score: 0.75 },
        { name: "évalúation ✓ 评估", score: 0.42 },
    ];

    it.each(cases)("matches the shared builder for %j", (input) => {
        expect.assertions(1);

        expect(evaluationAttributes(input)).toStrictEqual(sharedEvaluationAttributes(input));
    });

    it("rejects the same empty-name and non-finite-score inputs as the shared builder", () => {
        expect.assertions(4);

        expect(() => sharedEvaluationAttributes({ name: "", score: 1 })).toThrow("non-empty `name`");
        expect(() => sharedEvaluationAttributes({ name: "x", score: Number.NaN })).toThrow("finite number");

        // The wrapper keys its `BAD_REQUEST` re-wrap on this exact type, so the
        // builder's misuse errors must stay `TypeError`s.
        expect(() => sharedEvaluationAttributes({ name: "", score: 1 })).toThrow(TypeError);
        expect(() => sharedEvaluationAttributes({ name: "x", score: Number.NaN })).toThrow(TypeError);
    });

    it("passes a non-validation failure through untouched instead of re-labelling it BAD_REQUEST", () => {
        expect.assertions(2);

        // A getter that blows up while the builder reads the input stands in for
        // any future internal fault. Re-wrapping it as `BAD_REQUEST` would blame
        // the caller for something they cannot fix, behind a spliced message.
        const hostile = {
            get name(): string {
                throw new RangeError("internal fault");
            },
            score: 1,
        };

        expect(() => evaluationAttributes(hostile)).toThrow(RangeError);
        expect(() => evaluationAttributes(hostile)).toThrow("internal fault");
    });
});
