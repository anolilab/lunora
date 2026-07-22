import { isLunoraError } from "@lunora/errors";
import type { EmbeddingModel, LanguageModel } from "ai";
import { describe, expect, it } from "vitest";

import createAi from "../src/create-ai";
import { AI_GATEWAY_ACCOUNT_ID_ENV, AI_GATEWAY_ID_ENV } from "../src/gateway";
import type { AiBindingLike, WorkersAiProviderLike } from "../src/types";

/** A configured-gateway env (account + gateway id, no auth token). */
const gatewayEnv = (): Record<string, unknown> => ({ [AI_GATEWAY_ACCOUNT_ID_ENV]: "acct-123", [AI_GATEWAY_ID_ENV]: "my-gateway" });

/**
 * A fake Workers AI provider. Calling it records the requested model id and
 * returns a sentinel standing in for an AI SDK `LanguageModel`, so resolution
 * can be asserted without driving the real SDK.
 */
const fakeProvider = (): WorkersAiProviderLike & { embedCalls: string[]; modelCalls: string[] } => {
    const modelCalls: string[] = [];
    const embedCalls: string[] = [];

    const provider = ((modelId: string) => {
        modelCalls.push(modelId);

        return { __model: modelId } as unknown as LanguageModel;
    }) as WorkersAiProviderLike & { embedCalls: string[]; modelCalls: string[] };

    provider.textEmbeddingModel = (modelId: string): EmbeddingModel => {
        embedCalls.push(modelId);

        return { __embeddingModel: modelId } as unknown as EmbeddingModel;
    };

    provider.modelCalls = modelCalls;
    provider.embedCalls = embedCalls;

    return provider;
};

const fakeBinding = (): AiBindingLike & { runCalls: [string, Record<string, unknown>, Record<string, unknown> | undefined][] } => {
    const runCalls: [string, Record<string, unknown>, Record<string, unknown> | undefined][] = [];

    return {
        run: async (model, inputs, options) => {
            runCalls.push([model, inputs, options]);

            return { response: `ran ${model}` };
        },
        runCalls,
    };
};

describe("createAi", () => {
    it("throws when neither a binding nor a provider is supplied", () => {
        expect(() => createAi({})).toThrow(/requires a `binding`/);
    });

    describe("model resolution (provider-agnostic seam)", () => {
        it("resolves a string model id against the Workers AI provider", () => {
            const provider = fakeProvider();
            const ai = createAi({ provider });

            const model = ai.model("@cf/meta/llama-3.3-70b-instruct-fp8-fast");

            expect(provider.modelCalls).toStrictEqual(["@cf/meta/llama-3.3-70b-instruct-fp8-fast"]);
            expect(model).toStrictEqual({ __model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        });

        it("passes a bring-your-own AI SDK model straight through (no provider call)", () => {
            const provider = fakeProvider();
            const ai = createAi({ provider });
            const external = { __external: "openai:gpt-5" } as unknown as LanguageModel;

            const model = ai.model(external);

            expect(model).toBe(external);
            expect(provider.modelCalls).toStrictEqual([]);
        });

        it("falls back to defaultModel when no model is passed", () => {
            const provider = fakeProvider();
            const ai = createAi({ defaultModel: "@cf/meta/llama-3.1-8b-instruct", provider });

            ai.model();

            expect(provider.modelCalls).toStrictEqual(["@cf/meta/llama-3.1-8b-instruct"]);
        });

        it("throws when no model and no defaultModel are available", () => {
            const ai = createAi({ provider: fakeProvider() });

            expect(() => ai.model()).toThrow(/no model supplied and no `defaultModel`/);
        });
    });

    describe("embedding model resolution", () => {
        it("resolves a string id against the provider's textEmbeddingModel", () => {
            const provider = fakeProvider();
            const ai = createAi({ provider });

            const model = ai.embeddingModel("@cf/baai/bge-base-en-v1.5");

            expect(provider.embedCalls).toStrictEqual(["@cf/baai/bge-base-en-v1.5"]);
            expect(model).toStrictEqual({ __embeddingModel: "@cf/baai/bge-base-en-v1.5" });
        });

        it("passes a bring-your-own EmbeddingModel through unchanged", () => {
            const provider = fakeProvider();
            const ai = createAi({ provider });
            const external = { __external: "openai-embed" } as unknown as EmbeddingModel;

            expect(ai.embeddingModel(external)).toBe(external);
            expect(provider.embedCalls).toStrictEqual([]);
        });

        it("throws a clear LunoraError when the provider has no textEmbeddingModel", () => {
            const provider = ((modelId: string) => ({ __model: modelId }) as unknown as LanguageModel) as WorkersAiProviderLike;
            const ai = createAi({ provider });

            // A LunoraError (not a raw TypeError) so the runtime's toErrorBody and the
            // CLI's renderLunoraError surface the curated catalog title/hint.
            expect(() => ai.embeddingModel("@cf/baai/bge-base-en-v1.5")).toThrow(/does not expose `textEmbeddingModel`/);

            let caught: unknown;

            try {
                ai.embeddingModel("@cf/baai/bge-base-en-v1.5");
            } catch (error) {
                caught = error;
            }

            expect(isLunoraError(caught)).toBe(true);
        });

        it("falls back to defaultEmbeddingModel when no embedding model is passed", () => {
            const provider = fakeProvider();
            const ai = createAi({ defaultEmbeddingModel: "@cf/baai/bge-base-en-v1.5", provider });

            ai.embeddingModel();

            expect(provider.embedCalls).toStrictEqual(["@cf/baai/bge-base-en-v1.5"]);
        });

        it("does not reuse the language-model defaultModel as an embedding fallback", () => {
            // A language-model default must never leak into embeddingModel(): the ids
            // belong to different Workers AI families, so reusing it would defer a
            // wrong-family error to inference time instead of failing locally.
            const provider = fakeProvider();
            const ai = createAi({ defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", provider });

            expect(() => ai.embeddingModel()).toThrow(/no embedding model supplied and no `defaultEmbeddingModel`/);
            expect(provider.embedCalls).toStrictEqual([]);
        });

        it("throws when no embedding model and no defaultEmbeddingModel are available", () => {
            const ai = createAi({ provider: fakeProvider() });

            expect(() => ai.embeddingModel()).toThrow(/no embedding model supplied and no `defaultEmbeddingModel`/);
        });
    });

    describe("run (raw binding passthrough)", () => {
        it("forwards model, inputs, and options to the binding", async () => {
            const binding = fakeBinding();
            const ai = createAi({ binding, provider: fakeProvider() });

            const result = await ai.run("@cf/meta/m2m100-1.2b", { source_lang: "en", target_lang: "fr", text: "hi" }, { gateway: { id: "g" } });

            expect(binding.runCalls).toStrictEqual([["@cf/meta/m2m100-1.2b", { source_lang: "en", target_lang: "fr", text: "hi" }, { gateway: { id: "g" } }]]);
            expect(result).toStrictEqual({ response: "ran @cf/meta/m2m100-1.2b" });
        });

        it("throws when only a custom provider (no binding) was supplied", async () => {
            const ai = createAi({ provider: fakeProvider() });

            await expect(ai.run("@cf/meta/m2m100-1.2b", {})).rejects.toThrow(/ai\.run requires the `binding`/);
        });

        it("routes raw ai.run() through the env-resolved gateway when the caller sets none", async () => {
            const binding = fakeBinding();
            const ai = createAi({ binding, env: gatewayEnv() });

            await ai.run("@cf/meta/m2m100-1.2b", { text: "hi" });

            expect(binding.runCalls).toStrictEqual([["@cf/meta/m2m100-1.2b", { text: "hi" }, { gateway: { id: "my-gateway" } }]]);
        });

        it("preserves a caller-supplied gateway over the env-resolved one", async () => {
            const binding = fakeBinding();
            const ai = createAi({ binding, env: gatewayEnv() });

            await ai.run("@cf/meta/m2m100-1.2b", { text: "hi" }, { gateway: { id: "explicit" } });

            expect(binding.runCalls).toStrictEqual([["@cf/meta/m2m100-1.2b", { text: "hi" }, { gateway: { id: "explicit" } }]]);
        });

        it("leaves run options untouched when no gateway is configured", async () => {
            const binding = fakeBinding();
            const ai = createAi({ binding });

            await ai.run("@cf/meta/m2m100-1.2b", { text: "hi" });

            expect(binding.runCalls).toStrictEqual([["@cf/meta/m2m100-1.2b", { text: "hi" }, undefined]]);
        });
    });

    describe("provider construction from a binding", () => {
        it("builds the Workers AI provider from env.AI when no provider is given", () => {
            const binding = fakeBinding();
            // No `provider` → createAi must construct one via createWorkersAI and
            // expose it. We only assert it produced a callable provider; the real
            // provider's model objects are opaque AI SDK internals.
            const ai = createAi({ binding });

            expect(typeof ai.workersai).toBe("function");
            expect(() => ai.model("@cf/meta/llama-3.1-8b-instruct")).not.toThrow();
        });
    });

    it("exposes the underlying provider for raw model access", () => {
        const provider = fakeProvider();
        const ai = createAi({ provider });

        expect(ai.workersai).toBe(provider);
    });
});
