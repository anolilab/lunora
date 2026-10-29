import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";

/**
 * `generate.ts` reaches `ai` at module scope through `agent-ai` -> `@lunora/ai`
 * (its barrel re-exports values from `ai`), so `@lunora/ai` is mocked here to
 * isolate the deferral `generate.ts` itself owns.
 */
const evaluated = vi.hoisted(() => {
    return { count: 0 };
});

vi.mock(import("@lunora/ai"), () => ({ createAi: vi.fn<() => never>() }) as never);

vi.mock(import("ai"), async (importOriginal) => {
    evaluated.count += 1;

    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        generateText: vi.fn<() => Promise<{ text: string; toolCalls: never[]; usage: undefined }>>(async () => {
            return { text: "ok", toolCalls: [], usage: undefined };
        }) as unknown as typeof actual.generateText,
    };
});

describe("ai root load boundary", () => {
    it("evaluates the ai root once, on the first model call", async () => {
        const { defineAgent } = await import("../src/define-agent");
        const { createAgentGenerate } = await import("../src/generate");

        const agent = defineAgent({ model: { specificationVersion: "v2" } as unknown as LanguageModel });
        const generate = createAgentGenerate(agent, {});

        expect(evaluated.count).toBe(0);

        await generate({ messages: [] });
        await generate({ messages: [] });

        expect(evaluated.count).toBe(1);
    });

    it("retries turn preparation after a transient model factory failure", async () => {
        const { defineAgent } = await import("../src/define-agent");
        const { createAgentGenerate } = await import("../src/generate");

        let attempts = 0;
        const agent = defineAgent({
            model: () => {
                attempts += 1;

                if (attempts === 1) {
                    throw new Error("model factory hiccup");
                }

                return { specificationVersion: "v2" } as unknown as LanguageModel;
            },
        });
        const generate = createAgentGenerate(agent, {});

        await expect(generate({ messages: [] })).rejects.toThrow("model factory hiccup");
        await expect(generate({ messages: [] })).resolves.toMatchObject({ text: "ok" });
        expect(attempts).toBe(2);
    });
});
