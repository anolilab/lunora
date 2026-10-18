import { describe, expect, it } from "vitest";

import type { AiMetrics, AiSpan } from "../src/types";
import { recordUsage } from "../src/usage";

/** A span + metrics double that records exactly what usage accounting reports. */
const recorder = () => {
    const attributes: Record<string, unknown> = {};
    const counts: [string, number | undefined, Record<string, unknown> | undefined][] = [];
    const span: AiSpan = {
        setAttribute: (key, value) => {
            attributes[key] = value;
        },
        setAttributes: (fields) => {
            Object.assign(attributes, fields);
        },
    };
    const metrics: AiMetrics = {
        count: (name, value, tags) => {
            counts.push([name, value, tags]);
        },
    };

    return { attributes, counts, metrics, span };
};

/** Every bucket a provider can report for one chat call. Totals include their breakdowns. */
// Unannotated so the SDK's full bucket shape (`noCache`, `text`) is not an excess-property error.
const everyBucket = {
    usage: {
        inputTokens: { cacheRead: 300, cacheWrite: 100, noCache: 600, total: 1000 },
        outputTokens: { reasoning: 200, text: 300, total: 500 },
    },
};

/** `gpt-4o-mini` is priced $0.15 / $0.60 per million input / output tokens. */
const miniCost = (inputTokens: number, outputTokens: number): number => (inputTokens * 0.15 + outputTokens * 0.6) / 1_000_000;

describe("recordUsage", () => {
    it("records cache and reasoning buckets alongside the totals when the provider reports them", () => {
        expect.assertions(1);

        const { attributes, span, metrics } = recorder();

        recordUsage("gpt-4o-mini", everyBucket, span, metrics);

        expect(attributes).toStrictEqual({
            "gen_ai.usage.cache_creation.input_tokens": 100,
            "gen_ai.usage.cache_read.input_tokens": 300,
            "gen_ai.usage.cost": miniCost(1000, 500),
            "gen_ai.usage.input_tokens": 1000,
            "gen_ai.usage.output_tokens": 500,
            "gen_ai.usage.reasoning.output_tokens": 200,
            "lunora.usage.cost.source": "estimated",
            "lunora.usage.status": "complete",
        });
    });

    it("does not count reasoning on top of the output total", () => {
        expect.assertions(2);

        const { attributes, counts, span, metrics } = recorder();

        recordUsage("gpt-4o-mini", everyBucket, span, metrics);

        // Reasoning is a subset of output: 500 total, not 500 + 200.
        expect(attributes["gen_ai.usage.output_tokens"]).toBe(500);
        expect(counts).toContainEqual(["gen_ai.usage.output_tokens", 500, { "gen_ai.request.model": "gpt-4o-mini" }]);
    });

    it("reports complete from the totals alone and emits no breakdown attributes", () => {
        expect.assertions(1);

        const { attributes, span, metrics } = recorder();

        recordUsage("gpt-4o-mini", { usage: { inputTokens: { total: 1000 }, outputTokens: { total: 500 } } }, span, metrics);

        expect(attributes).toStrictEqual({
            "gen_ai.usage.cost": miniCost(1000, 500),
            "gen_ai.usage.input_tokens": 1000,
            "gen_ai.usage.output_tokens": 500,
            "lunora.usage.cost.source": "estimated",
            "lunora.usage.status": "complete",
        });
    });

    it("drops a zero cache or reasoning breakdown rather than counting it", () => {
        expect.assertions(1);

        // The AI SDK fills 0 in for a breakdown the provider never sent.
        const { attributes, span, metrics } = recorder();

        recordUsage(
            "gpt-4o-mini",
            { usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, total: 1000 }, outputTokens: { reasoning: 0, total: 500 } } },
            span,
            metrics,
        );

        expect(Object.keys(attributes).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "gen_ai.usage.cost",
            "gen_ai.usage.input_tokens",
            "gen_ai.usage.output_tokens",
            "lunora.usage.cost.source",
            "lunora.usage.status",
        ]);
    });

    it("reports unavailable and no cost when the provider reports no token counts", () => {
        expect.assertions(3);

        const empty = recorder();

        recordUsage("gpt-4o-mini", {}, empty.span, empty.metrics);

        const buckets = recorder();

        const undefinedBuckets = {
            usage: {
                inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: undefined, total: undefined },
                outputTokens: { reasoning: undefined, text: undefined, total: undefined },
            },
        };

        recordUsage("gpt-4o-mini", undefinedBuckets, buckets.span, buckets.metrics);

        expect(empty.attributes).toStrictEqual({ "lunora.usage.status": "unavailable" });
        expect(buckets.attributes).toStrictEqual({ "lunora.usage.status": "unavailable" });
        expect([...empty.counts, ...buckets.counts]).toStrictEqual([]);
    });

    it("reports partial and withholds the estimate when the output total is missing", () => {
        expect.assertions(3);

        const { attributes, counts, span, metrics } = recorder();

        recordUsage("gpt-4o-mini", { usage: { inputTokens: { total: 1000 } } }, span, metrics);

        // Pricing the input alone would understate the call and sum into the total unseen.
        expect(attributes).toStrictEqual({ "gen_ai.usage.input_tokens": 1000, "lunora.usage.status": "partial" });
        expect(counts).toStrictEqual([["gen_ai.usage.input_tokens", 1000, { "gen_ai.request.model": "gpt-4o-mini" }]]);
        expect(attributes).not.toHaveProperty("gen_ai.usage.cost");
    });

    it("keeps a provider-reported cost even when the token counts are partial or missing", () => {
        expect.assertions(2);

        const partial = recorder();

        recordUsage(
            "openai/gpt-5",
            { providerMetadata: { gateway: { cost: 0.0123 } }, usage: { inputTokens: { total: 1000 } } },
            partial.span,
            partial.metrics,
        );

        const unavailable = recorder();

        recordUsage("openai/gpt-5", { providerMetadata: { gateway: { cost: 0.0123 } } }, unavailable.span, unavailable.metrics);

        expect(partial.attributes).toMatchObject({ "gen_ai.usage.cost": 0.0123, "lunora.usage.cost.source": "provider", "lunora.usage.status": "partial" });
        expect(unavailable.attributes).toStrictEqual({
            "gen_ai.usage.cost": 0.0123,
            "lunora.usage.cost.source": "provider",
            "lunora.usage.status": "unavailable",
        });
    });

    it("treats an embedding call with only an input total as complete", () => {
        expect.assertions(2);

        const { attributes, span, metrics } = recorder();

        recordUsage("text-embedding-3-small", { usage: { inputTokens: { total: 1_000_000 } } }, span, metrics, { expectsOutput: false });

        expect(attributes["lunora.usage.status"]).toBe("complete");
        expect(attributes["gen_ai.usage.cost"]).toBe(0.02);
    });
});
