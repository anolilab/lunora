import { containsScorer, evaluate } from "@lunora/testing";

/**
 * Fixture eval for `packages/cli/__tests__/commands/eval.test.ts` — deliberately
 * simple (no `agentHarness`, a pure `produce`) so the test exercises the
 * runner's discovery/threshold/aggregation logic, not the kit's own behavior
 * (that is `packages/testing`'s job, covered by its own suite). Both cases
 * score 1 (each output contains "it"), so `average` is exactly `1`.
 */
export default {
    name: "support-triage",
    run: async () =>
        evaluate(
            [
                { expected: "shipped", input: "where is my order?" },
                { expected: "refunded", input: "cancel my order" },
            ],
            (input: string) => (input.includes("cancel") ? "It was refunded." : "It shipped Tuesday."),
            [containsScorer("it")],
        ),
};
