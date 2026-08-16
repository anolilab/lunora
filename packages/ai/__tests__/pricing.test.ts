import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL_PRICES, estimateModelCost, lookupModelPrice } from "../src/pricing";

describe("lookupModelPrice", () => {
    it("finds a Workers AI model by its exact id", () => {
        expect.assertions(1);

        expect(lookupModelPrice("@cf/baai/bge-base-en-v1.5")).toStrictEqual({ input: 0.02 });
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
        expect(lookupModelPrice("@cf/baai/bge-m3")).toStrictEqual({ input: 0.02 });
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

    it("returns undefined for an absent model id", () => {
        expect.assertions(2);

        expect(estimateModelCost(undefined, { inputTokens: 1000 })).toBeUndefined();
        expect(estimateModelCost("", { inputTokens: 1000 })).toBeUndefined();
    });

    it("ships a table that is small on purpose", () => {
        expect.assertions(1);

        // A table covering every model is a table that is wrong about most of
        // them; anything absent returns undefined rather than a guess.
        expect(Object.keys(DEFAULT_MODEL_PRICES).length).toBeLessThan(20);
    });
});
