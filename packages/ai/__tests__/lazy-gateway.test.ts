import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiBindingLike } from "../src/types";

const state = vi.hoisted(() => {
    return {
        evaluated: [] as string[],
        failNextCreate: false,
    };
});

vi.mock(import("workers-ai-provider"), (() => {
    state.evaluated.push("workers-ai-provider");

    return {
        createWorkersAI: (settings: { providers?: unknown }) => {
            if (state.failNextCreate) {
                state.failNextCreate = false;

                throw new Error("create failed");
            }

            const tag = settings.providers === undefined ? "plain" : "gateway";
            const provider = (modelId: string) => {
                return {
                    doGenerate: async () => {
                        return { via: tag };
                    },
                    modelId,
                    provider: `${tag}.chat`,
                };
            };

            provider.textEmbeddingModel = (modelId: string) => {
                return {
                    doEmbed: async () => {
                        return { via: tag };
                    },
                    maxEmbeddingsPerCall: tag === "gateway" ? 2048 : 3000,
                    modelId,
                    supportsParallelCalls: true,
                };
            };

            return provider;
        },
    };
}) as never);

vi.mock(import("workers-ai-provider/openai"), (() => {
    state.evaluated.push("openai-plugin");

    return { openai: {} };
}) as never);

vi.mock(import("workers-ai-provider/anthropic"), (() => {
    state.evaluated.push("anthropic-plugin");

    return { anthropic: {} };
}) as never);

vi.mock(import("@ai-sdk/openai"), (() => {
    state.evaluated.push("@ai-sdk/openai");

    return {
        createOpenAI: () => {
            return {};
        },
    };
}) as never);

const { default: createAi } = await import("../src/create-ai");

const binding: AiBindingLike = {
    run: async () => {
        return { response: "hi" };
    },
};

interface Callable {
    doEmbed: (options: unknown) => Promise<unknown>;
    doGenerate: (options: unknown) => Promise<unknown>;
    maxEmbeddingsPerCall: unknown;
}

const CF_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

describe("lazy gateway routing", () => {
    beforeEach(() => {
        state.failNextCreate = false;
    });

    it("imports nothing at construction, even with a gateway configured, until a model call", async () => {
        expect.assertions(3);

        // Runs first in this file: the mocked modules have not been evaluated yet.
        const ai = createAi({ binding, env: { LUNORA_AI_GATEWAY_ID: "gw" } });

        ai.model("openai/gpt-4o");
        ai.model(CF_ID);
        // Long enough for any import started at construction to have evaluated its module.
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });

        expect(state.evaluated).toStrictEqual([]);

        await (ai.model("openai/gpt-4o") as unknown as Callable).doGenerate({});

        expect(state.evaluated).toContain("workers-ai-provider");
        expect(state.evaluated).toContain("openai-plugin");
    });

    it("routes a gateway slug through ctx.ai.workersai to the plugin-equipped instance", async () => {
        expect.assertions(2);

        const ai = createAi({ binding });

        await expect((ai.workersai("openai/gpt-4o") as unknown as Callable).doGenerate({})).resolves.toStrictEqual({ via: "gateway" });
        await expect((ai.workersai(CF_ID) as unknown as Callable).doGenerate({})).resolves.toStrictEqual({ via: "plain" });
    });

    it("resolves gateway embedding limits from the real model rather than the Workers AI constants", async () => {
        expect.assertions(4);

        const ai = createAi({ binding });
        const gateway = ai.embeddingModel("openai/text-embedding-3-small") as unknown as Callable;
        const workersAi = ai.embeddingModel("@cf/baai/bge-base-en-v1.5") as unknown as Callable;

        expect(workersAi.maxEmbeddingsPerCall).toBe(3000);
        expect(gateway.maxEmbeddingsPerCall).not.toBe(3000);
        await expect(gateway.maxEmbeddingsPerCall).resolves.toBe(2048);
        await expect(gateway.doEmbed({})).resolves.toStrictEqual({ via: "gateway" });
    });

    it("does not keep a rejected load: the next call through the same facade succeeds", async () => {
        expect.assertions(4);

        const ai = createAi({ binding });

        state.failNextCreate = true;

        await expect((ai.workersai(CF_ID) as unknown as Callable).doGenerate({})).rejects.toThrow("create failed");
        await expect((ai.workersai(CF_ID) as unknown as Callable).doGenerate({})).resolves.toStrictEqual({ via: "plain" });

        state.failNextCreate = true;

        await expect((ai.workersai("openai/gpt-4o") as unknown as Callable).doGenerate({})).rejects.toThrow("create failed");
        await expect((ai.workersai("openai/gpt-4o") as unknown as Callable).doGenerate({})).resolves.toStrictEqual({ via: "gateway" });
    });
});
