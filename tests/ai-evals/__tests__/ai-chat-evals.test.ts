/**
 * The CI gate over the assistant eval set in `ai-chat.eval.ts`.
 *
 * The eval module is shaped for `lunora eval`, which nothing in CI runs — so
 * without this file the set would be a report nobody reads. Running it here
 * costs nothing (the model is scripted; no network, no token) and turns it into
 * a real regression signal: a prompt edit that drops the grounding block, a
 * ladder change that offers a tool above the configured tier, or a refactor that
 * lets a model failure throw instead of degrade, all fail here.
 *
 * Asserted per case rather than on the aggregate: a mean is a number nobody can
 * act on, while a failing case names the behaviour and prints the scorer reasons
 * that decided it.
 */
import { describe, expect, it } from "vitest";

import aiChatEval from "../ai-chat.eval";

/** Render the scorers that did not give full marks, for the failure message. */
const shortfall = (scores: Record<string, { reason?: string; score: number }>): string =>
    Object.entries(scores)
        .filter(([, verdict]) => verdict.score < 1)
        .map(([name, verdict]) => `${name} = ${verdict.score.toFixed(2)}${verdict.reason === undefined ? "" : ` (${verdict.reason})`}`)
        .join("; ");

describe("studio ai chat evals", () => {
    it("holds every behavioural expectation in the eval set", async () => {
        expect.hasAssertions();

        const result = await aiChatEval.run();

        // A silently empty set would score a vacuous 1 — the failure mode a
        // quality gate can least afford.
        expect(result.items.length).toBeGreaterThan(10);

        const failed = result.items.filter((item) => item.average < aiChatEval.threshold).map((item) => `${item.input} — ${shortfall(item.scores)}`);

        expect(failed).toStrictEqual([]);
        expect(result.average).toBe(1);
    });
});
