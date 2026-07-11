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
        generateText: vi.fn(async () => {
            return { text: "ok", toolCalls: [], usage: undefined };
        }) as unknown as typeof actual.generateText,
    };
});

/** A bare AI SDK model object — passed through by `resolveAgentModel` (no `env.AI` needed). */
const fakeModel = { specificationVersion: "v2" } as unknown as LanguageModel;

describe(createAgentGenerate, () => {
    it("threads repairToolCall into the generateText request as experimental_repairToolCall", async () => {
        const repair = vi.fn();
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
});
