/**
 * Fixture eval whose `run` resolves without an `average` at all — used by `eval.test.ts`
 * to prove a missing score fails the eval instead of passing when no threshold is set.
 */
export default {
    name: "missing",
    run: async () => ({ items: [] }),
};
