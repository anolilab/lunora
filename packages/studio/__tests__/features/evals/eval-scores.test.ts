import { describe, expect, it } from "vitest";

import { buildEvalCards, extractEvalRuns, extractEvalTrends } from "../../../src/features/evals/eval-scores";
import type { MetricHistoryResult, TraceSummary } from "../../../src/lib/admin";

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

const span = (attributes: Record<string, unknown>, name = "generate") => {
    return {
        attributes,
        depth: 1,
        durationMs: 5,
        name,
        offsetMs: 5,
        ok: true,
        parentSpanId: "",
        spanId: "span-1",
    };
};

describe("eval score extraction", () => {
    it("pulls the score, label, and trace hand-off off a graded span", () => {
        expect.assertions(1);

        const runs = extractEvalRuns([
            trace({ spans: [span({ "gen_ai.evaluation.answer-relevance.label": "pass", "gen_ai.evaluation.answer-relevance.score": 0.8 })] }),
        ]);

        expect(runs).toStrictEqual([
            {
                label: "pass",
                name: "answer-relevance",
                score: 0.8,
                spanName: "generate",
                // The span carries an offset, not a wall clock — 1000 + 5.
                startTs: 1005,
                traceId: "trace-1",
            },
        ]);
    });

    it("ignores spans and series that carry no eval score", () => {
        expect.assertions(2);

        expect(extractEvalRuns([trace({ spans: [span({ "http.status": 200 })] })])).toStrictEqual([]);
        expect(extractEvalTrends({ series: [{ functionPath: "f", kind: "counter", name: "orders.placed", points: [] }] })).toStrictEqual([]);
    });

    it("summarises from the durable buckets when they exist, and from the live ring otherwise", () => {
        expect.assertions(4);

        const runs = extractEvalRuns([trace({ spans: [span({ "gen_ai.evaluation.tone.score": 0.5 })] })]);
        const history: MetricHistoryResult = {
            series: [
                {
                    functionPath: "chat:answer",
                    kind: "gauge",
                    name: "gen_ai.evaluation.tone.score",
                    points: [
                        // Two scores in one bucket: `last` alone would report a
                        // minimum of 0.4 and a mean of 0.4, flattering both.
                        { bucketMs: 0, count: 2, last: 0.4, max: 0.4, min: 0, sum: 0.4 },
                        { bucketMs: 60_000, count: 1, last: 1, max: 1, min: 1, sum: 1 },
                    ],
                },
            ],
        };

        const [withTrend] = buildEvalCards(runs, extractEvalTrends(history));

        // Durable half wins the summary: the ring's single 0.5 is not the history.
        // mean = (0.4 + 1) / (2 + 1) samples, min from the bucket's own `min`.
        expect(withTrend).toMatchObject({ latest: 1, max: 1, mean: 1.4 / 3, min: 0, name: "tone" });
        expect(withTrend?.points).toHaveLength(2);
        // Its live runs still ride along — that is what makes a score clickable.
        expect(withTrend?.runs).toHaveLength(1);

        const [liveOnly] = buildEvalCards(runs, []);

        expect(liveOnly).toMatchObject({ latest: 0.5, max: 0.5, mean: 0.5, min: 0.5, points: [] });
    });
});
