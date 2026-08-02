import { evaluate, exactMatchScorer } from "@lunora/testing";

/**
 * A trivially-passing eval whose `threshold` export is `NaN` — used by
 * `eval.test.ts` to prove an invalid per-eval `threshold` fails THAT eval
 * with a diagnosable error, and never even runs `run()`, instead of
 * reproducing the "every eval FAILs with no stated cause" symptom the global
 * `--threshold` guard was built to prevent (see plan 298).
 */
export default {
    name: "nan-threshold",
    run: async () => evaluate([{ expected: "yes", input: "a" }], () => "yes", [exactMatchScorer()]),
    threshold: Number.NaN,
};
