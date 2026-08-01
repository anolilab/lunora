import { evaluate, exactMatchScorer } from "@lunora/testing";

/**
 * Same `0.5`-average shape as `eval-threshold-sample/evals/mixed.eval.ts`, but
 * exports its own `threshold: 0.4` — used by `eval.test.ts` to prove a
 * per-eval `threshold` export wins over a stricter global `--threshold`.
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
    threshold: 0.4,
};
