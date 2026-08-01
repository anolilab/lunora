/**
 * Fixture eval whose `run` throws — used by `eval.test.ts` to prove a crashed
 * eval always fails the run (non-zero exit), independent of `--threshold`.
 */
export default {
    name: "broken",
    run: async (): Promise<never> => {
        throw new Error("boom");
    },
};
