import { describe, expect, it, vi } from "vitest";

import type { AiBindingLike } from "../src/types";

const loaded = vi.hoisted(() => vi.fn<() => void>());

// The real package, but recording when it is first evaluated.
// eslint-disable-next-line vitest/prefer-import-in-mock -- importOriginal keeps the real module
vi.mock("workers-ai-provider", async (importOriginal) => {
    loaded();

    return importOriginal();
});

const { default: createAi } = await import("../src/create-ai");

const binding: AiBindingLike = {
    run: async () => {
        return { response: "hi" };
    },
};

interface Callable {
    doGenerate: (options: unknown) => Promise<unknown>;
    modelId: string;
    provider: string;
}

const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const EMBEDDING_ID = "@cf/baai/bge-base-en-v1.5";

describe("lazy workers-ai-provider", () => {
    it("does not evaluate the package until a model is called, and reports identity synchronously", async () => {
        expect.assertions(6);

        const ai = createAi({ binding });
        const model = ai.model(MODEL_ID) as unknown as Callable;
        const embedding = ai.embeddingModel(EMBEDDING_ID) as unknown as { maxEmbeddingsPerCall: unknown };

        expect(model.modelId).toBe(MODEL_ID);
        expect(embedding.maxEmbeddingsPerCall).toBe(3000);
        expect(loaded).not.toHaveBeenCalled();

        // The binding's reply is not a valid prompt result, so the call fails after the load.
        await model.doGenerate({ prompt: [] }).catch(() => {});

        expect(loaded).toHaveBeenCalledTimes(1);
        expect(model.provider).toBe("workersai.chat");
        expect(ai.workersai).toBeTypeOf("function");
    });

    it("reports the same identity fields as the real provider", async () => {
        expect.assertions(8);

        const { createWorkersAI } = await import("workers-ai-provider");
        const real = createWorkersAI({ binding });
        const ai = createAi({ binding });
        const chat = ai.model(MODEL_ID) as unknown as Record<string, unknown>;
        const embedding = ai.embeddingModel(EMBEDDING_ID) as unknown as Record<string, unknown>;
        const realChat = real(MODEL_ID) as unknown as Record<string, unknown>;
        const realEmbedding = real.textEmbeddingModel(EMBEDDING_ID) as unknown as Record<string, unknown>;

        expect(chat.modelId).toBe(realChat.modelId);
        expect(chat.provider).toBe(realChat.provider);
        expect(chat.specificationVersion).toBe(realChat.specificationVersion);
        await expect(chat.supportedUrls).resolves.toStrictEqual(realChat.supportedUrls);
        expect(embedding.modelId).toBe(realEmbedding.modelId);
        expect(embedding.provider).toBe(realEmbedding.provider);
        expect(embedding.maxEmbeddingsPerCall).toBe(realEmbedding.maxEmbeddingsPerCall);
        expect(embedding.supportsParallelCalls).toBe(realEmbedding.supportsParallelCalls);
    });

    it("delegates a call to the real provider on first use", async () => {
        expect.assertions(1);

        const run = vi.fn<AiBindingLike["run"]>(async () => {
            return { response: "hello" };
        });
        const model = createAi({ binding: { run } }).model(MODEL_ID) as unknown as Callable;

        await model.doGenerate({ prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }] }).catch(() => {});

        expect(run).toHaveBeenCalledWith(MODEL_ID, expect.anything(), expect.anything());
    });
});
