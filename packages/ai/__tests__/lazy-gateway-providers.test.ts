import { describe, expect, it, vi } from "vitest";

import { AI_PROXY_URL_ENV } from "../src/gateway";
import type { AiBindingLike } from "../src/types";

const loaded = vi.hoisted(() => {
    return { anthropic: vi.fn<() => void>(), openai: vi.fn<() => void>(), sdk: vi.fn<() => void>() };
});

vi.mock(import("workers-ai-provider/openai"), () => {
    loaded.openai();

    return { openai: { wireFormat: "openai" } } as never;
});
vi.mock(import("workers-ai-provider/anthropic"), () => {
    loaded.anthropic();

    return { anthropic: { wireFormat: "anthropic" } } as never;
});
vi.mock(import("@ai-sdk/openai"), () => {
    loaded.sdk();

    return {
        createOpenAI: () => {
            return {
                chat: (modelId: string) => {
                    return {
                        doGenerate: async () => {
                            return { marker: modelId };
                        },
                        modelId,
                        provider: "mock",
                        specificationVersion: "v4",
                        supportedUrls: {},
                    };
                },
            };
        },
    } as never;
});

const { default: createAi } = await import("../src/create-ai");

const binding: AiBindingLike = {
    run: async () => {
        return {};
    },
};

describe("lazy gateway providers", () => {
    it("does not evaluate the provider packages for a Workers AI model id", () => {
        expect.assertions(3);

        createAi({ binding }).model("@cf/meta/llama-3.3-70b-instruct-fp8-fast");

        expect(loaded.openai).not.toHaveBeenCalled();
        expect(loaded.anthropic).not.toHaveBeenCalled();
        expect(loaded.sdk).not.toHaveBeenCalled();
    });

    it("builds a proxy model lazily and delegates to it once the import resolves", async () => {
        expect.assertions(2);

        const model = createAi({ env: { [AI_PROXY_URL_ENV]: "https://ai-proxy.test/v1" } }).model("openai/gpt-5") as unknown as {
            doGenerate: (options: never) => Promise<unknown>;
        };

        expect(loaded.sdk).not.toHaveBeenCalled();
        await expect(model.doGenerate({} as never)).resolves.toStrictEqual({ marker: "openai/gpt-5" });
    });
});
