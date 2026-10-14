import { evaluate, exactMatchScorer } from "@lunora/testing";

/**
 * Fixture eval whose average lands at exactly `0.5` (one exact match, one
 * miss) — used by `eval.test.ts` to exercise `--threshold`'s pass/fail
 * boundary without a per-eval `threshold` export of its own.
 */
export default {
    name: "mixed",
    run: async () =>
        evaluate(
            [
                { expected: "yes", input: "a" },
                { expected: "yes", input: "b" },
            ],
            (input: string) => (input === "a" ? "yes" : "no"),
            [exactMatchScorer()],
        ),
};
