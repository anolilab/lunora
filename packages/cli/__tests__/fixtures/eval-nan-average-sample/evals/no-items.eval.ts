/**
 * Fixture eval whose `run` resolves with a finite `average` but no `items` — used by `eval.test.ts`
 * to prove a result without its case list fails the eval instead of crashing the table.
 */
export default {
    name: "no-items",
    run: async () => ({ average: 0.9 }),
};
