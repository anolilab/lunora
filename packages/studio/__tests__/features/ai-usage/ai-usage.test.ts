import { describe, expect, it } from "vitest";

import { buildAiUsage, costProvenance, extractAiCalls } from "../../../src/features/ai-usage/ai-usage";
import { formatTokens, formatUsd } from "../../../src/features/reports/metrics-format";
import type { MetricHistoryPoint, MetricHistorySeries, TraceSummary } from "../../../src/lib/admin";

const MINUTE = 60_000;

/** A counter bucket as `@lunora/observability` folds it: `sum` of the increments, `count` of the calls. */
const bucket = (bucketMs: number, values: number[]): MetricHistoryPoint => {
    return {
        bucketMs,
        count: values.length,
        last: values.at(-1) ?? 0,
        max: Math.max(...values),
        min: Math.min(...values),
        sum: values.reduce((total, value) => total + value, 0),
    };
};

const series = (name: string, functionPath: string, model: string, points: MetricHistoryPoint[], source?: "estimated" | "provider"): MetricHistorySeries => {
    return {
        attributes: { "gen_ai.request.model": model, ...(source === undefined ? {} : { "lunora.usage.cost.source": source }) },
        functionPath,
        kind: "counter",
        name,
        points,
    };
};

const trace = (overrides: Partial<TraceSummary> & Pick<TraceSummary, "spans">): TraceSummary => {
    return {
        durationMs: 10,
        functionPath: "chat:answer",
        ok: true,
        rootName: "chat:answer",
        startTs: 1000,
        traceId: "trace-1",
        ...overrides,
    };
};

const span = (name: string, attributes: Record<string, unknown>, offsetMs = 5) => {
    return {
        attributes,
        depth: 1,
        durationMs: 5,
        name,
        offsetMs,
        ok: true,
        parentSpanId: "",
        spanId: `span-${offsetMs.toString()}`,
    };
};

describe("ai usage from durable metric history", () => {
    const history = {
        series: [
            // chat:answer on sonnet — two calls in minute 0, one in minute 2; provider-priced.
            series("gen_ai.usage.input_tokens", "chat:answer", "anthropic/claude-sonnet-5", [bucket(0, [100, 200]), bucket(2 * MINUTE, [50])]),
            series("gen_ai.usage.output_tokens", "chat:answer", "anthropic/claude-sonnet-5", [bucket(0, [10, 20]), bucket(2 * MINUTE, [5])]),
            series("gen_ai.usage.cost", "chat:answer", "anthropic/claude-sonnet-5", [bucket(0, [0.25, 0.5]), bucket(2 * MINUTE, [0.125])], "provider"),
            // summarize:run on llama — one call, cost estimated from a price table.
            series("gen_ai.usage.input_tokens", "summarize:run", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", [bucket(MINUTE, [1000])]),
            series("gen_ai.usage.output_tokens", "summarize:run", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", [bucket(MINUTE, [300])]),
            series("gen_ai.usage.cost", "summarize:run", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", [bucket(MINUTE, [0.0625])], "estimated"),
            // Unrelated app metric — must be ignored.
            { functionPath: "orders:place", kind: "counter" as const, name: "orders.placed", points: [bucket(0, [1, 1, 1])] },
        ],
    };

    it("counts a call that reported only a cost, and never merges two models' call counts by max", () => {
        expect.assertions(2);

        const usage = buildAiUsage(
            {
                series: [
                    // A gateway-priced call with no token usage at all.
                    series("gen_ai.usage.cost", "chat:answer", "openai/gpt-5", [bucket(0, [0.5, 0.25])], "provider"),
                    // Three input-only calls on one model, two output-only on another.
                    series("gen_ai.usage.input_tokens", "chat:answer", "model-a", [bucket(0, [1, 1, 1])]),
                    series("gen_ai.usage.output_tokens", "chat:answer", "model-b", [bucket(0, [1, 1])]),
                ],
            },
            [],
        );

        expect(usage.totals.calls).toBe(7);
        expect(usage.byModel.find((row) => row.key === "openai/gpt-5")?.calls).toBe(2);
    });

    it("totals tokens from bucket sums and calls from bucket counts, keeping cost split by source", () => {
        expect.assertions(2);

        const usage = buildAiUsage(history, []);

        expect(usage.source).toBe("history");
        expect(usage.totals).toStrictEqual({
            calls: 4,
            estimatedCost: 0.0625,
            inputTokens: 1350,
            outputTokens: 335,
            providerCost: 0.875,
        });
    });

    it("breaks usage down by function and by model, most expensive first", () => {
        expect.assertions(4);

        const usage = buildAiUsage(history, []);

        expect(usage.byFunction.map((row) => row.key)).toStrictEqual(["chat:answer", "summarize:run"]);
        expect(usage.byFunction[0]).toStrictEqual({ calls: 3, estimatedCost: 0, inputTokens: 350, key: "chat:answer", outputTokens: 35, providerCost: 0.875 });
        expect(usage.byModel.map((row) => row.key)).toStrictEqual(["anthropic/claude-sonnet-5", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"]);
        expect(usage.byModel[1]).toMatchObject({ calls: 1, estimatedCost: 0.0625, providerCost: 0 });
    });

    it("merges one function's calls across models without double-counting calls", () => {
        expect.assertions(1);

        const usage = buildAiUsage(
            {
                series: [
                    series("gen_ai.usage.input_tokens", "chat:answer", "a", [bucket(0, [10])]),
                    series("gen_ai.usage.output_tokens", "chat:answer", "a", [bucket(0, [1])]),
                    series("gen_ai.usage.input_tokens", "chat:answer", "b", [bucket(0, [20, 30])]),
                    series("gen_ai.usage.output_tokens", "chat:answer", "b", [bucket(0, [2, 3])]),
                ],
            },
            [],
        );

        expect(usage.byFunction).toStrictEqual([{ calls: 3, estimatedCost: 0, inputTokens: 60, key: "chat:answer", outputTokens: 6, providerCost: 0 }]);
    });

    it("builds a per-minute cost trend with silent minutes filled as zero", () => {
        expect.assertions(1);

        const usage = buildAiUsage(history, []);

        expect(usage.trend).toStrictEqual([
            { bucketMs: 0, estimatedCost: 0, providerCost: 0.75 },
            { bucketMs: MINUTE, estimatedCost: 0.0625, providerCost: 0 },
            { bucketMs: 2 * MINUTE, estimatedCost: 0, providerCost: 0.125 },
        ]);
    });

    it("treats a cost series without a recognised source as estimated", () => {
        expect.assertions(1);

        const usage = buildAiUsage({ series: [series("gen_ai.usage.cost", "f", "m", [bucket(0, [0.5])])] }, []);

        expect(usage.totals).toMatchObject({ estimatedCost: 0.5, providerCost: 0 });
    });
});

describe("ai calls from live trace spans", () => {
    it("extracts ai.generate and ai.stream spans with their trace hand-off, newest first", () => {
        expect.assertions(1);

        const calls = extractAiCalls([
            trace({
                spans: [
                    span("ai.generate", {
                        "gen_ai.operation.name": "chat",
                        "gen_ai.request.model": "anthropic/claude-sonnet-5",
                        "gen_ai.usage.cost": 0.002,
                        "gen_ai.usage.input_tokens": 120,
                        "gen_ai.usage.output_tokens": 40,
                        "lunora.usage.cost.source": "provider",
                    }),
                    span("db.query", { table: "messages" }, 1),
                    span("ai.stream", { "gen_ai.operation.name": "chat", "gen_ai.request.model": "m" }, 9),
                ],
            }),
        ]);

        expect(calls).toStrictEqual([
            { functionPath: "chat:answer", model: "m", ok: true, startTs: 1009, streaming: true, traceId: "trace-1" },
            {
                cost: 0.002,
                costSource: "provider",
                functionPath: "chat:answer",
                inputTokens: 120,
                model: "anthropic/claude-sonnet-5",
                ok: true,
                outputTokens: 40,
                // Offset from the trace anchor, not a wall clock — 1000 + 5.
                startTs: 1005,
                streaming: false,
                traceId: "trace-1",
            },
        ]);
    });

    it("falls back to the live ring for totals when no durable history exists", () => {
        expect.assertions(3);

        const usage = buildAiUsage({ series: [] }, [
            trace({
                spans: [
                    span("ai.generate", {
                        "gen_ai.request.model": "m",
                        "gen_ai.usage.cost": 0.01,
                        "gen_ai.usage.input_tokens": 10,
                        "gen_ai.usage.output_tokens": 5,
                    }),
                    span("ai.stream", { "gen_ai.request.model": "m" }, 6),
                ],
            }),
        ]);

        expect(usage.source).toBe("live");
        expect(usage.totals).toStrictEqual({ calls: 2, estimatedCost: 0.01, inputTokens: 10, outputTokens: 5, providerCost: 0 });
        expect(usage.trend).toStrictEqual([]);
    });

    it("reports nothing when neither half has AI telemetry", () => {
        expect.assertions(2);

        const usage = buildAiUsage(undefined, [trace({ spans: [span("db.query", {})] })]);

        expect(usage.source).toBe("none");
        expect(usage.calls).toStrictEqual([]);
    });
});

describe("cost provenance and formatting", () => {
    it("labels a slice by where its cost came from", () => {
        expect.assertions(4);

        expect(costProvenance({ estimatedCost: 0, providerCost: 1 })).toBe("provider");
        expect(costProvenance({ estimatedCost: 1, providerCost: 0 })).toBe("estimated");
        expect(costProvenance({ estimatedCost: 1, providerCost: 1 })).toBe("mixed");
        expect(costProvenance({ estimatedCost: 0, providerCost: 0 })).toBe("none");
    });

    it("keeps sub-cent spend readable instead of rounding it to $0.00", () => {
        expect.assertions(4);

        expect(formatUsd(0, "en-US")).toBe("$0.00");
        expect(formatUsd(12.345, "en-US")).toBe("$12.35");
        expect(formatUsd(0.000_423_1, "en-US")).toBe("$0.000423");
        expect(formatTokens(1_234_567, "en-US")).toBe("1,234,567");
    });
});
