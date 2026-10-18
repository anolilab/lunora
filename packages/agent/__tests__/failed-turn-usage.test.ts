import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { defineAgent } from "../src/define-agent";
import { createAgentGenerate, createCompact, createEpisodeExtract, createGraphExtract, usageOfFailedTurn } from "../src/generate";

const billed = {
    inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 2, total: 2 },
    outputTokens: { reasoning: undefined, text: 1, total: 1 },
};

/** A model whose one `doGenerate` call ends in the provider's `error` finish reason, having billed `billed`. */
const failingModel = (): MockLanguageModelV4 =>
    new MockLanguageModelV4({
        doGenerate: () =>
            Promise.resolve({
                content: [],
                finishReason: { raw: "length", unified: "error" },
                usage: billed,
                warnings: [],
            }),
    });

const billedUsage = { inputTokens: 2, outputTokens: 1, totalTokens: 3 };

describe("the usage a failed model turn carries", () => {
    it("is attached to the error a non-streamed turn fails with", async () => {
        expect.assertions(2);

        const agent = defineAgent({ model: failingModel() });
        const failure: unknown = await createAgentGenerate(
            agent,
            {},
        )({ messages: [{ content: "hi", role: "user" }] }).then(
            () => undefined,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(Error);
        expect(usageOfFailedTurn(failure)).toStrictEqual(billedUsage);
    });

    it("is attached to the error a maintenance call fails with, so a failed compaction is counted too", async () => {
        expect.assertions(1);

        const failure: unknown = await createCompact()({
            env: {},
            messages: [{ content: "older", role: "user" }],
            model: failingModel(),
            previousSummary: undefined,
        }).then(
            () => undefined,
            (error: unknown) => error,
        );

        expect(usageOfFailedTurn(failure)).toStrictEqual(billedUsage);
    });

    it("is attached to the error the episode and graph extractions fail with", async () => {
        expect.assertions(2);

        const episode: unknown = await createEpisodeExtract()({ assistantText: "a", env: {}, model: failingModel(), userInput: "q" }).then(
            () => undefined,
            (error: unknown) => error,
        );
        const graph: unknown = await createGraphExtract()({ assistantText: "a", env: {}, model: failingModel(), userInput: "q" }).then(
            () => undefined,
            (error: unknown) => error,
        );

        expect(usageOfFailedTurn(episode)).toStrictEqual(billedUsage);
        expect(usageOfFailedTurn(graph)).toStrictEqual(billedUsage);
    });

    it("is absent on an error that never came from a turn", () => {
        expect(usageOfFailedTurn(new Error("boom"))).toBeUndefined();
        expect(usageOfFailedTurn(undefined)).toBeUndefined();
    });
});
