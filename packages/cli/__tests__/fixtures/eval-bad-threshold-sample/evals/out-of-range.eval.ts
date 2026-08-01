import { evaluate, exactMatchScorer } from "@lunora/testing";

/**
 * A trivially-passing eval whose `threshold` export (`1.5`) is outside the
 * documented `[0, 1]` range — used by `eval.test.ts` to prove an
 * out-of-range per-eval `threshold` fails THAT eval instead of silently
 * gating with a value that can never fail (see plan 298).
 */
export default {
    name: "out-of-range",
    run: async () => evaluate([{ expected: "yes", input: "a" }], () => "yes", [exactMatchScorer()]),
    threshold: 1.5,
};
