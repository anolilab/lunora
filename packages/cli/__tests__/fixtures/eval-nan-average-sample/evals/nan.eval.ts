/**
 * Fixture eval whose `run` resolves with a NaN `average` — used by `eval.test.ts`
 * to prove a non-finite score fails the eval instead of passing or crashing the table.
 */
export default {
    name: "nan",
    run: async () => ({ average: Number.NaN, items: [] }),
};
