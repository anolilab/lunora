import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { defineAgent } from "../src/define-agent";
import { createAgentGenerate, createCompact, createEpisodeExtract, createGraphExtract, createStreamGenerate, usageOfFailedTurn } from "../src/generate";

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

describe("a provider error finish that reports only part of its usage", () => {
    const inputOnly = { inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 2, total: 2 } };
    const outputOnly = { outputTokens: { reasoning: undefined, text: 1, total: 1 } };
    const finish = { raw: "length", unified: "error" } as const;

    const failureOf = (promise: Promise<unknown>): Promise<unknown> =>
        promise.then(
            () => undefined,
            (error: unknown) => error,
        );

    const expectProviderFailure = (failure: unknown): void => {
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(TypeError);
        expect((failure as Error).message).toBe("model finished with an error reason (provider reason: length)");
        expect((failure as Error).cause).toStrictEqual(finish);
    };

    it.each([
        ["only input usage", inputOnly],
        ["only output usage", outputOnly],
        ["no usage", undefined],
    ])("a non-streamed turn fails with the provider failure when the finish reports %s", async (_label, usage) => {
        expect.assertions(5);

        const model = new MockLanguageModelV4({
            doGenerate: () => Promise.resolve({ content: [], finishReason: finish, usage: usage as never, warnings: [] }),
        });
        const failure = await failureOf(createAgentGenerate(defineAgent({ model }), {})({ messages: [{ content: "hi", role: "user" }] }));

        expectProviderFailure(failure);

        expect(usageOfFailedTurn(failure) === undefined).toBe(usage === undefined);
    });

    it.each([
        ["only input usage", inputOnly],
        ["only output usage", outputOnly],
        ["no usage", undefined],
    ])("a streamed turn fails with the provider failure when the finish reports %s", async (_label, usage) => {
        expect.assertions(5);

        const model = new MockLanguageModelV4({
            doStream: () =>
                Promise.resolve({
                    stream: simulateReadableStream({ chunks: [{ finishReason: finish, type: "finish", usage: usage as never }] }),
                }),
        });
        const failure = await failureOf(createStreamGenerate(defineAgent({ model }), {})({ messages: [{ content: "hi", role: "user" }] }, () => undefined));

        expectProviderFailure(failure);

        expect(usageOfFailedTurn(failure) === undefined).toBe(usage === undefined);
    });
});
