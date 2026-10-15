import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";

/** The first evaluation of `ai` fails; the seam must load it again on the next call. */
const evaluations = vi.hoisted(() => {
    return { count: 0 };
});

vi.mock(import("@lunora/ai"), () => ({ createAi: vi.fn<() => never>() }) as never);

vi.mock(import("ai"), async (importOriginal) => {
    evaluations.count += 1;

    if (evaluations.count === 1) {
        throw new Error("ai import hiccup");
    }

    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        generateText: vi.fn<() => Promise<{ text: string; toolCalls: never[]; usage: undefined }>>(async () => {
            return { text: "ok", toolCalls: [], usage: undefined };
        }) as unknown as typeof actual.generateText,
    };
});

const FIRST_LOAD_FAILURE = /ai import hiccup|error when mock/;

describe("ai root load retry", () => {
    it("loads the ai root again after a rejected import", async () => {
        expect.assertions(3);

        const { defineAgent } = await import("../src/define-agent");
        const { createAgentGenerate } = await import("../src/generate");

        const agent = defineAgent({ model: { specificationVersion: "v2" } as unknown as LanguageModel });
        const generate = createAgentGenerate(agent, {});

        await expect(generate({ messages: [] })).rejects.toThrow(FIRST_LOAD_FAILURE);
        await expect(generate({ messages: [] })).resolves.toMatchObject({ text: "ok" });
        expect(evaluations.count).toBe(2);
    });
});
