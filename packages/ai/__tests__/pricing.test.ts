import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL_PRICES, estimateImageCost, estimateModelCost, lookupModelPrice } from "../src/pricing";

describe("lookupModelPrice", () => {
    it("finds a Workers AI model by its exact id", () => {
        expect.assertions(1);

        expect(lookupModelPrice("@cf/baai/bge-base-en-v1.5")).toStrictEqual({ input: 0.067 });
    });

    it("strips a provider prefix", () => {
        expect.assertions(1);

        expect(lookupModelPrice("openai/text-embedding-3-small")).toStrictEqual({ input: 0.02 });
    });

    it("strips a trailing date stamp", () => {
        expect.assertions(1);

        expect(lookupModelPrice("text-embedding-3-small-2024-01-25")).toStrictEqual({ input: 0.02 });
    });

    it("does not mistake a Workers AI id's own slashes for a provider prefix", () => {
        expect.assertions(1);

        // Reducing "@cf/baai/bge-m3" to "bge-m3" would miss its entry.
        expect(lookupModelPrice("@cf/baai/bge-m3")).toStrictEqual({ input: 0.012 });
    });

    it("strips a provider prefix from a Workers AI id without eating its own slashes", () => {
        expect.assertions(2);

        // The AI Gateway's unified form prefixes the provider onto the `@cf/...` id.
        expect(lookupModelPrice("workers-ai/@cf/baai/bge-m3")).toStrictEqual({ input: 0.012 });
        expect(lookupModelPrice("workers-ai/@cf/meta/llama-3.1-8b-instruct")).toStrictEqual(lookupModelPrice("@cf/meta/llama-3.1-8b-instruct"));
    });

    it("prices the generation models the docs' examples use, with an output price", () => {
        expect.assertions(3);

        // A chat span carried NO cost at all off an AI Gateway while the table held
        // embedding models only — the estimator's fallback existed but every
        // `defineAgent` example's model missed it.
        expect(lookupModelPrice("@cf/meta/llama-3.3-70b-instruct-fp8-fast")?.output).toBeGreaterThan(0);
        expect(lookupModelPrice("@cf/meta/llama-3.1-8b-instruct")?.output).toBeGreaterThan(0);
        expect(lookupModelPrice("gpt-5")?.output).toBeGreaterThan(0);
    });

    it("returns undefined for a model it does not cover", () => {
        expect.assertions(1);

        expect(lookupModelPrice("some-model-nobody-priced")).toBeUndefined();
    });

    it("accepts a caller-supplied price table", () => {
        expect.assertions(1);

        expect(lookupModelPrice("my-model", { "my-model": { input: 1, output: 2 } })).toStrictEqual({ input: 1, output: 2 });
    });

    it("does not resolve prototype keys", () => {
        expect.assertions(1);

        expect(lookupModelPrice("constructor")).toBeUndefined();
    });
});

describe("estimateModelCost", () => {
    it("prices input tokens per million", () => {
        expect.assertions(1);

        // 1M tokens at $0.02/M.
        expect(estimateModelCost("text-embedding-3-small", { inputTokens: 1_000_000 })).toBeCloseTo(0.02, 10);
    });

    it("prices input and output together", () => {
        expect.assertions(1);

        const cost = estimateModelCost("chat", { inputTokens: 1_000_000, outputTokens: 2_000_000 }, { chat: { input: 1, output: 3 } });

        expect(cost).toBeCloseTo(7, 10);
    });

    it("treats a missing output price as zero", () => {
        expect.assertions(1);

        expect(estimateModelCost("text-embedding-3-small", { inputTokens: 1_000_000, outputTokens: 500 })).toBeCloseTo(0.02, 10);
    });

    it("returns undefined rather than 0 for an unpriced model", () => {
        expect.assertions(1);

        // Zero would quietly sum into a total; absent shows up as absent.
        expect(estimateModelCost("unknown-model", { inputTokens: 1000 })).toBeUndefined();
    });

    it("returns undefined with no usable token count", () => {
        expect.assertions(3);

        expect(estimateModelCost("text-embedding-3-small", {})).toBeUndefined();
        expect(estimateModelCost("text-embedding-3-small", { inputTokens: 0 })).toBeUndefined();
        expect(estimateModelCost("text-embedding-3-small", { inputTokens: Number.NaN })).toBeUndefined();
    });

    it("returns undefined rather than 0 for an image-only price with token usage", () => {
        expect.assertions(1);

        expect(estimateModelCost("dall-e-3", { inputTokens: 1000, outputTokens: 1000 })).toBeUndefined();
    });

    it("returns undefined for an absent model id", () => {
        expect.assertions(2);

        expect(estimateModelCost(undefined, { inputTokens: 1000 })).toBeUndefined();
        expect(estimateModelCost("", { inputTokens: 1000 })).toBeUndefined();
    });

    it("bills cache reads at the cache rate when the price lists one", () => {
        expect.assertions(1);

        // 1000 input tokens, 400 of them cache reads: 600 at $1/M, 400 at $0.1/M.
        const cost = estimateModelCost("chat", { cacheReadTokens: 400, inputTokens: 1000 }, { chat: { cacheRead: 0.1, input: 1 } });

        expect(cost).toBeCloseTo((600 * 1 + 400 * 0.1) / 1_000_000, 12);
    });

    it("bills cache writes at the input rate when the price lists no write rate", () => {
        expect.assertions(1);

        const cost = estimateModelCost("chat", { cacheWriteTokens: 200, inputTokens: 1000 }, { chat: { cacheRead: 0.1, input: 1 } });

        expect(cost).toBeCloseTo(1000 / 1_000_000, 12);
    });

    it("never prices cache tokens on top of the input total", () => {
        expect.assertions(2);

        // 400 of the 1000 input tokens are cached. With no cache rate listed the
        // cost is the plain 1000-token input cost, not 1400.
        // gpt-4o-mini is $0.15 per million input tokens.
        const plain = (1000 * 0.15) / 1_000_000;

        expect(estimateModelCost("gpt-4o-mini", { cacheReadTokens: 400, inputTokens: 1000 })).toBeCloseTo(plain, 12);
        // Cache counts beyond the total are clamped to it rather than billed twice.
        expect(estimateModelCost("gpt-4o-mini", { cacheReadTokens: 5000, inputTokens: 1000 })).toBeCloseTo(plain, 12);
    });

    it("ships a table that is small on purpose", () => {
        expect.assertions(1);

        // A table covering every model is a table that is wrong about most of
        // them; anything absent returns undefined rather than a guess.
        expect(Object.keys(DEFAULT_MODEL_PRICES).length).toBeLessThan(20);
    });
});

describe("estimateImageCost", () => {
    it("prices an image model per generated image", () => {
        expect.assertions(1);

        expect(estimateImageCost("@cf/black-forest-labs/flux-1-schnell")).toBeCloseTo(0.000_633_6, 10);
    });

    it("multiplies by the image count", () => {
        expect.assertions(1);

        expect(estimateImageCost("gpt-image-1", 3)).toBeCloseTo(0.12, 10);
    });

    it("strips a provider prefix, like the token estimator", () => {
        expect.assertions(1);

        expect(estimateImageCost("openai/dall-e-3")).toBeCloseTo(0.04, 10);
    });

    it("returns undefined for a token-priced model", () => {
        expect.assertions(1);

        // A chat model carries no `perImage` price, so an image estimate over it
        // is absent rather than a false zero.
        expect(estimateImageCost("gpt-5")).toBeUndefined();
    });

    it("returns undefined for an unpriced model or a non-positive count", () => {
        expect.assertions(3);

        expect(estimateImageCost("some-image-model-nobody-priced")).toBeUndefined();
        expect(estimateImageCost("@cf/black-forest-labs/flux-1-schnell", 0)).toBeUndefined();
        expect(estimateImageCost(undefined)).toBeUndefined();
    });
});
