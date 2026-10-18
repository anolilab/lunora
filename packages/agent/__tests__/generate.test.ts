import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { describe, expect, it, vi } from "vitest";

import { defineAgent } from "../src/define-agent";
import { createAgentGenerate } from "../src/generate";

// Capture the request handed to `generateText` without hitting a real model.
vi.mock(import("ai"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        generateText: vi.fn<() => Promise<{ text: string; toolCalls: never[]; usage: undefined }>>(async () => {
            return { text: "ok", toolCalls: [], usage: undefined };
        }) as unknown as typeof actual.generateText,
    };
});

/** A bare AI SDK model object — passed through by `resolveAgentModel` (no `env.AI` needed). */
const fakeModel = { specificationVersion: "v2" } as unknown as LanguageModel;

describe(createAgentGenerate, () => {
    it("threads repairToolCall into the generateText request as experimental_repairToolCall", async () => {
        const repair = vi.fn<() => void>();
        const agent = defineAgent({ model: fakeModel, repairToolCall: repair as never });

        await createAgentGenerate(agent, {})({ messages: [] });

        const request = vi.mocked(generateText).mock.calls.at(-1)?.[0] as Record<string, unknown>;

        expect(request["experimental_repairToolCall"]).toBe(repair);
    });

    it("omits experimental_repairToolCall when the agent does not set repairToolCall", async () => {
        const agent = defineAgent({ model: fakeModel });

        await createAgentGenerate(agent, {})({ messages: [] });

        const request = vi.mocked(generateText).mock.calls.at(-1)?.[0] as Record<string, unknown>;

        expect(request["experimental_repairToolCall"]).toBeUndefined();
    });

    it("projects the cache and reasoning breakdowns off the token details, dropping a zero one", async () => {
        expect.assertions(1);

        // A cache-write detail the provider filled in as 0 must not appear as a counted bucket.
        vi.mocked(generateText).mockResolvedValueOnce({
            output: undefined,
            text: "ok",
            toolCalls: [],
            usage: {
                inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 0, noCacheTokens: 6 },
                inputTokens: 10,
                outputTokenDetails: { reasoningTokens: 2, textTokens: 3 },
                outputTokens: 5,
                totalTokens: 15,
            },
        } as never);

        const result = await createAgentGenerate(defineAgent({ model: fakeModel }), {})({ messages: [] });

        expect(result.usage).toStrictEqual({ cacheReadTokens: 4, inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 15 });
    });
});
