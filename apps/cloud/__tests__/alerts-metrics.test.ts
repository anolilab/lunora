import { describe, expect, it } from "vitest";

import type { FiringRule, MetricObservation, MetricRule, MetricRulePorts } from "../src/telemetry/alerts";
import {
    compareMetric,
    computeErrorRate,
    computeLatencyP95,
    computeLlmCost,
    computeMetric,
    evaluateMetricLevel,
    fireCrossedRules,
    fireMetricRules,
    PAGERDUTY_EVENTS_URL,
    percentile,
    rateOfChangePercent,
    renderPagerDutyPayload,
    renderSlackPayload,
    webhookRequestFor,
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

describe(evaluateMetricLevel, () => {
    const rule = { comparator: "gt" as const, target: "error_rate" as const, threshold: 50 };

    it("fires when the window breaches and the rule was not already firing", () => {
        expect(evaluateMetricLevel(rule, mixed(2, 2), false)).toStrictEqual({ action: "fire", currentValue: 100, firing: true });
    });

    it("does not re-fire while the window stays breached (already firing)", () => {
        expect(evaluateMetricLevel(rule, mixed(2, 2), true)).toStrictEqual({ action: "none", currentValue: 100, firing: true });
    });

    it("clears when the window falls back under threshold and the rule was firing", () => {
        expect(evaluateMetricLevel(rule, mixed(4, 0), true)).toStrictEqual({ action: "clear", currentValue: 0, firing: false });
    });

    it("stays quiet when under threshold and not firing", () => {
        expect(evaluateMetricLevel(rule, mixed(4, 0), false)).toStrictEqual({ action: "none", currentValue: 0, firing: false });
    });
});

/**
 * A metric firing-loop store: an `alerts` sink + an in-memory `alertRuleState`
 * latch, exposing the injected {@link MetricRulePorts} plus the captured rows and
 * final state for assertions.
 */
const metricStore = (
    initial: Record<string, boolean> = {},
): {
    ports: MetricRulePorts<string>;
    rows: Record<string, unknown>[];
    state: Map<string, boolean>;
    writes: { firing: boolean; ruleId: string; value: number }[];
} => {
    const rows: Record<string, unknown>[] = [];
    const state = new Map(Object.entries(initial));
    const writes: { firing: boolean; ruleId: string; value: number }[] = [];

    return {
        ports: {
            insertAlert: async (row) => {
                rows.push(row);

                return `alert_${String(rows.length)}`;
            },
            wasFiring: (ruleId) => state.get(ruleId) ?? false,
            writeState: async (ruleId, firing, value) => {
                state.set(ruleId, firing);
                writes.push({ firing, ruleId, value });
            },
        },
        rows,
        state,
        writes,
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

    it("fires a metric rule when the current window breaches and the rule was not firing", async () => {
        const observations: MetricObservation[] = mixed(2, 2, now - 60_000); // 100% in the current window
        const store = metricStore();

        const outcome = await fireMetricRules([rule], observations, "org_1", store.ports, now);

        expect(outcome.fired).toBe(1);
        expect(outcome.deliveries).toHaveLength(1);
        expect(outcome.deliveries[0]?.channel).toBe("email");
        expect(outcome.deliveries[0]?.subject).toContain("Error rate above threshold");
        expect(outcome.deliveries[0]?.body).toContain("100% over the last 5 min");
        expect(store.rows[0]).toMatchObject({ hash: "error_rate:*", organizationId: "org_1", ruleId: "rule_1", status: "firing", target: "error_rate" });
        // The latch was persisted so the next pass won't re-fire.
        expect(store.state.get("rule_1")).toBe(true);
    });

    it("fires even when the prior window was ALSO breaching — the edge-trigger miss the sweep catches", async () => {
        // Both windows at 100%: the old window-over-window edge trigger would suppress
        // this, but level-triggered against a not-firing latch it correctly fires.
        const observations: MetricObservation[] = [...mixed(2, 2, now - 60_000), ...mixed(2, 2, now - 7 * 60_000)];
        const store = metricStore();

        const outcome = await fireMetricRules([rule], observations, "org_1", store.ports, now);

        expect(outcome.fired).toBe(1);
        expect(store.state.get("rule_1")).toBe(true);
    });

    it("does not re-fire while the rule stays firing", async () => {
        const observations: MetricObservation[] = mixed(2, 2, now - 60_000);
        const store = metricStore({ rule_1: true });

        const outcome = await fireMetricRules([rule], observations, "org_1", store.ports, now);

        expect(outcome.fired).toBe(0);
        expect(outcome.cleared).toBe(0);
        expect(outcome.deliveries).toHaveLength(0);
        expect(store.rows).toHaveLength(0);
    });

    it("clears a firing rule when its window falls back under threshold — no alert, latch reset", async () => {
        // Quiet current window (only info spans): 0% error, back under the threshold.
        const observations: MetricObservation[] = mixed(3, 0, now - 60_000);
        const store = metricStore({ rule_1: true });

        const outcome = await fireMetricRules([rule], observations, "org_1", store.ports, now);

        expect(outcome.cleared).toBe(1);
        expect(outcome.fired).toBe(0);
        expect(outcome.deliveries).toHaveLength(0);
        expect(store.rows).toHaveLength(0); // clearing never writes an alert row
        expect(store.state.get("rule_1")).toBe(false);
        expect(store.writes).toStrictEqual([{ firing: false, ruleId: "rule_1", value: 0 }]);
    });

    it("honors a functionPath scope", async () => {
        const scoped: MetricRule = { ...rule, functionPath: "messages:send" };
        const observations: MetricObservation[] = [
            // Breaching, but on a DIFFERENT function path — must be ignored.
            ...mixed(2, 2, now - 60_000).map((o) => ({ ...o, functionPath: "users:get" })),
            // The scoped path: only info spans → not breaching.
            observation({ functionPath: "messages:send", level: "info", startedAt: now - 60_000 }),
        ];
        const store = metricStore();

        const outcome = await fireMetricRules([scoped], observations, "org_1", store.ports, now);

        expect(outcome.deliveries).toHaveLength(0);
        expect(outcome.fired).toBe(0);
    });
});

describe("channel payloads", () => {
    const alert = {
        body: "Error rate is 100% over the last 5 min.",
        destination: "https://hooks.slack.com/services/T/B/x",
        subject: "[Lunora] High error rate",
    };

    it("renders a Slack incoming-webhook message", () => {
        expect(renderSlackPayload(alert)).toStrictEqual({ text: "*[Lunora] High error rate*\nError rate is 100% over the last 5 min." });
    });

    it("renders a PagerDuty Events API v2 trigger with the destination as the routing key", () => {
        expect(renderPagerDutyPayload({ ...alert, destination: "routing-key-123" })).toStrictEqual({
            dedup_key: "[Lunora] High error rate",
            event_action: "trigger",
            payload: { severity: "error", source: "lunora-cloud", summary: "[Lunora] High error rate — Error rate is 100% over the last 5 min." },
            routing_key: "routing-key-123",
        });
    });

    it("routes each webhook-family channel to the right URL + body", () => {
        const slack = webhookRequestFor({ ...alert, channel: "slack" });

        expect(slack.url).toBe("https://hooks.slack.com/services/T/B/x");
        expect(JSON.parse(slack.body)).toMatchObject({ text: expect.stringContaining("High error rate") });

        const pd = webhookRequestFor({ ...alert, channel: "pagerduty", destination: "routing-key-123" });

        expect(pd.url).toBe(PAGERDUTY_EVENTS_URL);
        expect(JSON.parse(pd.body)).toMatchObject({ event_action: "trigger", routing_key: "routing-key-123" });

        const plain = webhookRequestFor({ ...alert, channel: "webhook", destination: "https://hooks.example.com/x" });

        expect(plain.url).toBe("https://hooks.example.com/x");
        expect(JSON.parse(plain.body)).toStrictEqual({ body: alert.body, subject: alert.subject });
    });
});

/** Collect the rows the count-crossing firing loop inserts; return incrementing string ids. */
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
