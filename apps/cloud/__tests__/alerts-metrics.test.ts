import { describe, expect, it } from "vitest";

import type { FiringRule, MetricObservation, MetricRule } from "../src/telemetry/alerts";
import {
    compareMetric,
    computeErrorRate,
    computeLatencyP95,
    computeLlmCost,
    computeMetric,
    deviatesByPercent,
    evaluateMetricRule,
    fireCrossedRules,
    fireMetricRules,
    percentile,
    rateOfChangePercent,
} from "../src/telemetry/alerts";

/** Build a metric observation with sensible defaults; override what a case needs. */
const observation = (over: Partial<MetricObservation> = {}): MetricObservation => ({
    durationMs: 10,
    kind: "worker",
    level: "info",
    startedAt: 1_000,
    ...over,
});

/** N observations, `errors` of which are error-level. */
const mixed = (total: number, errors: number, startedAt = 1_000): MetricObservation[] =>
    Array.from({ length: total }, (_, index) => observation({ level: index < errors ? "error" : "info", startedAt }));

describe(computeErrorRate, () => {
    it("is the percentage of error-level observations, 0 for an empty window", () => {
        expect(computeErrorRate([])).toBe(0);
        expect(computeErrorRate(mixed(4, 1))).toBe(25);
        expect(computeErrorRate(mixed(2, 2))).toBe(100);
        expect(computeErrorRate(mixed(3, 0))).toBe(0);
    });
});

describe(percentile, () => {
    it("returns the nearest-rank percentile, 0 for empty", () => {
        expect(percentile([], 95)).toBe(0);
        expect(percentile([5], 95)).toBe(5);
        // p95 of 1..100 (nearest-rank) is the 95th value.
        expect(
            percentile(
                Array.from({ length: 100 }, (_, index) => index + 1),
                95,
            ),
        ).toBe(95);
        expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    });
});

describe(computeLatencyP95, () => {
    it("takes the p95 of durationMs across the window", () => {
        const observations = Array.from({ length: 100 }, (_, index) => observation({ durationMs: index + 1 }));

        expect(computeLatencyP95(observations)).toBe(95);
        expect(computeLatencyP95([])).toBe(0);
    });
});

describe(computeLlmCost, () => {
    it("sums generation-span costMinor when present", () => {
        const observations = [
            observation({ costMinor: 120, kind: "generation" }),
            observation({ costMinor: 80, kind: "generation" }),
            observation({ costMinor: 999, kind: "worker" }), // ignored — not a generation
        ];

        expect(computeLlmCost(observations)).toBe(200);
    });

    it("falls back to total tokens when no cost is populated (the proxy)", () => {
        const observations = [
            observation({ completionTokens: 30, kind: "generation", promptTokens: 100 }),
            observation({ completionTokens: 20, kind: "generation", promptTokens: 50 }),
            observation({ kind: "worker", promptTokens: 500 }), // ignored — not a generation
        ];

        // 100+30 + 50+20 = 200 tokens as the proxy budget.
        expect(computeLlmCost(observations)).toBe(200);
    });

    it("is 0 when there are no generation spans", () => {
        expect(computeLlmCost([observation(), observation({ kind: "container" })])).toBe(0);
    });
});

describe(computeMetric, () => {
    it("dispatches to the right metric by target", () => {
        const observations = [observation({ durationMs: 100, kind: "generation", level: "error", promptTokens: 7 })];

        expect(computeMetric("error_rate", observations)).toBe(100);
        expect(computeMetric("latency_p95", observations)).toBe(100);
        expect(computeMetric("llm_cost", observations)).toBe(7);
    });
});

describe(compareMetric, () => {
    it("compares above (gt) or below (lt) the threshold", () => {
        expect(compareMetric(10, "gt", 5)).toBe(true);
        expect(compareMetric(5, "gt", 5)).toBe(false); // strict
        expect(compareMetric(3, "lt", 5)).toBe(true);
        expect(compareMetric(5, "lt", 5)).toBe(false);
    });
});

describe(rateOfChangePercent, () => {
    it("is the window-over-window percent delta, with a zero baseline as an unbounded spike", () => {
        expect(rateOfChangePercent(15, 10)).toBe(50);
        expect(rateOfChangePercent(5, 10)).toBe(-50);
        expect(rateOfChangePercent(0, 0)).toBe(0);
        expect(rateOfChangePercent(7, 0)).toBe(Number.POSITIVE_INFINITY);
    });
});

describe(deviatesByPercent, () => {
    it("fires when the absolute deviation meets the threshold percent", () => {
        expect(deviatesByPercent(15, 10, 40)).toBe(true); // +50% ≥ 40
        expect(deviatesByPercent(15, 10, 60)).toBe(false); // +50% < 60
        expect(deviatesByPercent(5, 10, 40)).toBe(true); // -50% ≥ 40 (a drop)
        expect(deviatesByPercent(7, 0, 40)).toBe(true); // spike from zero
        expect(deviatesByPercent(0, 0, 40)).toBe(false); // flat
    });
});

describe(evaluateMetricRule, () => {
    it("edge-triggers: fires only when the current window breaches and the prior did not", () => {
        const rule = { comparator: "gt" as const, target: "error_rate" as const, threshold: 50 };

        // prior 25% (not breaching) → current 100% (breaching): fires.
        expect(evaluateMetricRule(rule, mixed(2, 2), mixed(4, 1)).fired).toBe(true);
        // prior already breaching → current still breaching: does NOT re-fire.
        expect(evaluateMetricRule(rule, mixed(2, 2), mixed(2, 2)).fired).toBe(false);
        // neither breaches: no fire.
        expect(evaluateMetricRule(rule, mixed(4, 1), mixed(4, 1)).fired).toBe(false);
    });

    it("supports lt comparators (e.g. a latency SLO dropping below target)", () => {
        const rule = { comparator: "lt" as const, target: "latency_p95" as const, threshold: 100 };
        const fast = [observation({ durationMs: 20 })];
        const slow = [observation({ durationMs: 500 })];

        expect(evaluateMetricRule(rule, fast, slow).fired).toBe(true); // slow→fast crosses below
        expect(evaluateMetricRule(rule, fast, fast).fired).toBe(false); // already below
    });

    it("reports the computed current and prior values", () => {
        const result = evaluateMetricRule({ comparator: "gt", target: "error_rate", threshold: 10 }, mixed(4, 2), mixed(4, 1));

        expect(result.currentValue).toBe(50);
        expect(result.priorValue).toBe(25);
    });
});

/** Collect the rows a firing loop inserts; return incrementing string ids. */
const capturingInsert = (): { insert: (row: Record<string, unknown>) => Promise<string>; rows: Record<string, unknown>[] } => {
    const rows: Record<string, unknown>[] = [];

    return {
        insert: async (row) => {
            rows.push(row);

            return `alert_${String(rows.length)}`;
        },
        rows,
    };
};

describe(fireMetricRules, () => {
    const now = 10 * 60_000; // 10 minutes in
    const rule: MetricRule = {
        channel: "email",
        comparator: "gt",
        destination: "ops@example.com",
        name: "High error rate",
        ruleId: "rule_1",
        target: "error_rate",
        threshold: 50,
        windowMinutes: 5,
    };

    it("fires a metric rule when the current window breaches and the prior did not", async () => {
        // Current window (last 5 min): 2 errors of 2 = 100%. Prior window: 1 of 4 = 25%.
        const observations: MetricObservation[] = [
            ...mixed(2, 2, now - 60_000), // inside current window
            ...mixed(4, 1, now - 7 * 60_000), // inside prior window
        ];
        const { insert, rows } = capturingInsert();

        const deliveries = await fireMetricRules([rule], observations, "org_1", insert, now);

        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]?.channel).toBe("email");
        expect(deliveries[0]?.subject).toContain("Error rate above threshold");
        expect(deliveries[0]?.body).toContain("100% over the last 5 min");
        expect(rows[0]).toMatchObject({ hash: "error_rate:*", organizationId: "org_1", ruleId: "rule_1", status: "firing", target: "error_rate" });
    });

    it("does not fire when the prior window was already breaching", async () => {
        const observations: MetricObservation[] = [...mixed(2, 2, now - 60_000), ...mixed(2, 2, now - 7 * 60_000)];
        const { insert, rows } = capturingInsert();

        const deliveries = await fireMetricRules([rule], observations, "org_1", insert, now);

        expect(deliveries).toHaveLength(0);
        expect(rows).toHaveLength(0);
    });

    it("honors a functionPath scope", async () => {
        const scoped: MetricRule = { ...rule, functionPath: "messages:send" };
        const observations: MetricObservation[] = [
            // Breaching, but on a DIFFERENT function path — must be ignored.
            ...mixed(2, 2, now - 60_000).map((o) => ({ ...o, functionPath: "users:get" })),
            // The scoped path: only info spans → not breaching.
            observation({ functionPath: "messages:send", level: "info", startedAt: now - 60_000 }),
        ];
        const { insert } = capturingInsert();

        const deliveries = await fireMetricRules([scoped], observations, "org_1", insert, now);

        expect(deliveries).toHaveLength(0);
    });
});

describe(fireCrossedRules, () => {
    it("still fires an existing count-crossing rule exactly once on the crossing ingest", async () => {
        const rule: FiringRule = { channel: "email", destination: "ops@example.com", name: "Errors", ruleId: "rule_c", target: "issue", threshold: 5 };
        const { insert, rows } = capturingInsert();

        // 3 → 5 crosses the threshold of 5: fires once.
        const fired = await fireCrossedRules(
            [rule],
            { after: 5, before: 3, culprit: "messages:send", hash: "h1", organizationId: "org_1", sampleMessage: "boom", target: "issue", title: "boom" },
            insert,
            1,
        );

        expect(fired).toHaveLength(1);
        expect(rows[0]).toMatchObject({ hash: "h1", ruleId: "rule_c", status: "firing", target: "issue" });

        // A later ingest already over the threshold (5 → 7) does NOT re-fire.
        const again = await fireCrossedRules(
            [rule],
            { after: 7, before: 5, culprit: "messages:send", hash: "h1", organizationId: "org_1", sampleMessage: "boom", target: "issue", title: "boom" },
            insert,
            2,
        );

        expect(again).toHaveLength(0);
    });
});
