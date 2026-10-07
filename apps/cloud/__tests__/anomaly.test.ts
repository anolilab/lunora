import { describe, expect, it, vi } from "vitest";

import { createRule, createSilence } from "../lunora/alerts";
import type { ControlPlaneDatabase } from "../src/store";
import type { AnomalyBaseline } from "../src/telemetry/anomaly";
import { advanceBaseline, ANOMALY_BUCKET_MS, anomalyScore, isSilenced, MIN_ANOMALY_SAMPLES, scoreBucket } from "../src/telemetry/anomaly";
import { runAnomalySweep } from "../src/telemetry/anomaly-sweep";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/** 10:30 UTC on 15 June — mid-month, so the scored hour (09:00–10:00) is in the open period. */
const NOW = Date.UTC(2026, 5, 15, 10, 30);
const BUCKET_START = Date.UTC(2026, 5, 15, 9);

/** A warmed-up baseline of ~2000 requests an hour with a realistic spread. */
const warm: AnomalyBaseline = { mean: 2000, samples: MIN_ANOMALY_SAMPLES + 10, variance: 100 * 100 };

describe(anomalyScore, () => {
    it("scores a spike in standard deviations from the baseline", () => {
        expect(anomalyScore("requests", warm, 2500)).toBeCloseTo(5);
        expect(anomalyScore("requests", warm, 1500)).toBeCloseTo(-5);
    });

    it("scores nothing while the baseline is warming up", () => {
        expect(anomalyScore("requests", { ...warm, samples: MIN_ANOMALY_SAMPLES - 1 }, 50_000)).toBe(0);
        expect(anomalyScore("requests", undefined, 50_000)).toBe(0);
    });

    it("never scores under the minimum activity floor, however large the relative jump", () => {
        // 10 → 900 requests is a 90x jump, and still below the 1000/hour floor.
        expect(anomalyScore("requests", { mean: 10, samples: 100, variance: 1 }, 900)).toBe(0);
        expect(anomalyScore("errors", { mean: 1, samples: 100, variance: 0 }, 24)).toBe(0);
    });

    it("floors sigma at the Poisson spread, so a flat history does not turn noise into a page", () => {
        // Zero variance; the floor is √10000 = 100, so +300 is three sigma — not thirty thousand.
        expect(anomalyScore("requests", { mean: 10_000, samples: 100, variance: 0 }, 10_300)).toBeCloseTo(3);
    });

    it("treats a non-finite or negative value as nothing", () => {
        expect(anomalyScore("requests", warm, Number.NaN)).toBeCloseTo(-20);
        expect(anomalyScore("requests", warm, -5)).toBeCloseTo(-20);
    });
});

describe(advanceBaseline, () => {
    it("seeds from the first bucket and then moves as an EWMA", () => {
        const seeded = advanceBaseline(undefined, 1000);

        expect(seeded).toStrictEqual({ mean: 1000, samples: 1, variance: 0 });

        const next = advanceBaseline(seeded, 2000);

        expect(next.mean).toBeCloseTo(1050);
        expect(next.variance).toBeCloseTo(0.95 * 0.05 * 1000 * 1000);
        expect(next.samples).toBe(2);
    });

    it("scores against the baseline as it stood BEFORE the bucket, so a spike cannot mask itself", () => {
        const { next, reading } = scoreBucket("requests", warm, 2500);

        expect(reading).toStrictEqual({ mean: 2000, score: anomalyScore("requests", warm, 2500), value: 2500 });
        expect(next.mean).toBeGreaterThan(2000);
    });
});

describe(isSilenced, () => {
    const silence = { endsAt: BUCKET_START + 30 * 60_000, startsAt: BUCKET_START - 60_000, target: "usage_anomaly" as const };

    it("covers the signal of its own target for an overlapping hour only", () => {
        expect(isSilenced([silence], "requests", BUCKET_START, BUCKET_START + ANOMALY_BUCKET_MS)).toBe(true);
        expect(isSilenced([silence], "errors", BUCKET_START, BUCKET_START + ANOMALY_BUCKET_MS)).toBe(false);
        expect(isSilenced([silence], "requests", BUCKET_START + ANOMALY_BUCKET_MS, BUCKET_START + 2 * ANOMALY_BUCKET_MS)).toBe(false);
    });
});

/** An enabled `usage_anomaly > 4σ` rule for org1. */
const usageRule = {
    _id: "rule_usage",
    channel: "webhook",
    comparator: "gt",
    destination: "https://hook.example",
    enabled: true,
    name: "Traffic spike",
    organizationId: "org1",
    target: "usage_anomaly",
    threshold: 4,
};

/** A warmed `requests` baseline row for org1 that last folded in the hour before the scored one. */
const baselineRow = {
    _id: "base_req",
    lastBucketStart: BUCKET_START - ANOMALY_BUCKET_MS,
    lastMean: 2000,
    lastScore: 0,
    lastValue: 2000,
    organizationId: "org1",
    signal: "requests",
    ...warm,
};

/** One ledger row of `quantity` requests, created inside the scored hour unless told otherwise. */
const usage = (organizationId: string, quantity: number, createdAt = BUCKET_START + 60_000) => {
    return { createdAt, kind: "requests", organizationId, quantity };
};

describe(runAnomalySweep, () => {
    it("fires a usage anomaly for a spike, latches it, and advances the baseline", async () => {
        const insert = vi.fn<ControlPlaneDatabase["insert"]>((table: string) => Promise.resolve(`${table}_id`));
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const database = fakeControlPlaneDb(
            {
                alertRuleState: [],
                alertRules: [usageRule],
                anomalyBaselines: [baselineRow],
                anomalySilences: [],
                // 2400 + 600 = 3000 in the hour: ten sigma over 2000 ± 100. The other
                // org's row and the row from outside the hour must not count.
                platformUsage: [usage("org1", 2400), usage("org1", 600), usage("org2", 1_000_000), usage("org1", 1_000_000, BUCKET_START - 1)],
            },
            { insert, patch },
        );

        const result = await runAnomalySweep(database, { now: NOW });

        expect(result.scored).toBe(1);
        expect(result.deliveries).toHaveLength(1);
        expect(result.deliveries[0]?.subject).toContain("requests anomaly (+10.0σ)");
        expect(result.transitions).toStrictEqual([
            { action: "fire", organizationId: "org1", reading: { mean: 2000, score: 10, value: 3000 }, ruleId: "rule_usage", target: "usage_anomaly" },
        ]);
        expect(insert).toHaveBeenCalledWith("alerts", expect.objectContaining({ organizationId: "org1", ruleId: "rule_usage", target: "usage_anomaly" }));
        expect(insert).toHaveBeenCalledWith("alertRuleState", expect.objectContaining({ firing: true, lastValue: 10, ruleId: "rule_usage" }));
        expect(patch).toHaveBeenCalledWith(
            "base_req",
            expect.objectContaining({ lastBucketStart: BUCKET_START, lastScore: 10, lastValue: 3000, samples: warm.samples + 1 }),
            "anomalyBaselines",
        );
    });

    it("reads the ledger for the org and the completed hour only", async () => {
        const database = fakeControlPlaneDb({ alertRules: [usageRule], anomalyBaselines: [baselineRow] });
        const findMany = vi.spyOn(database, "findMany");

        await runAnomalySweep(database, { now: NOW });

        expect(findMany).toHaveBeenCalledWith(
            "platformUsage",
            expect.objectContaining({
                where: { createdAt: { gte: BUCKET_START, lt: BUCKET_START + ANOMALY_BUCKET_MS }, kind: "requests", organizationId: "org1" },
            }),
        );
    });

    it("never folds the same hour in twice, and does not re-fire a latched rule on a re-run", async () => {
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("id"));
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const database = fakeControlPlaneDb(
            {
                alertRuleState: [{ _id: "state1", firing: true, organizationId: "org1", ruleId: "rule_usage" }],
                alertRules: [usageRule],
                // This hour is already folded in, with a breaching score.
                anomalyBaselines: [{ ...baselineRow, lastBucketStart: BUCKET_START, lastScore: 10, samples: warm.samples + 1 }],
                platformUsage: [usage("org1", 3000)],
            },
            { insert, patch },
        );

        const result = await runAnomalySweep(database, { now: NOW });

        expect(result).toStrictEqual({ deliveries: [], scored: 0, transitions: [] });
        expect(patch).not.toHaveBeenCalled();
        expect(insert).not.toHaveBeenCalled();
    });

    it("finishes the rules of an hour whose baseline was written before a crash", async () => {
        const database = fakeControlPlaneDb({
            alertRuleState: [],
            alertRules: [usageRule],
            anomalyBaselines: [{ ...baselineRow, lastBucketStart: BUCKET_START, lastScore: 10, lastValue: 3000, samples: warm.samples + 1 }],
        });

        const result = await runAnomalySweep(database, { now: NOW });

        expect(result.scored).toBe(0);
        expect(result.deliveries).toHaveLength(1);
    });

    it("skips a silenced hour entirely: no measurement, no baseline update, no alert", async () => {
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("id"));
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const database = fakeControlPlaneDb(
            {
                alertRules: [usageRule],
                anomalyBaselines: [baselineRow],
                anomalySilences: [{ endsAt: NOW + 3_600_000, organizationId: "org1", startsAt: NOW - 7_200_000, target: "usage_anomaly" }],
                platformUsage: [usage("org1", 1_000_000)],
            },
            { insert, patch },
        );

        const result = await runAnomalySweep(database, { now: NOW });

        expect(result).toStrictEqual({ deliveries: [], scored: 0, transitions: [] });
        expect(patch).not.toHaveBeenCalled();
    });

    it("ignores another org's silence", async () => {
        const database = fakeControlPlaneDb({
            alertRules: [usageRule],
            anomalyBaselines: [baselineRow],
            anomalySilences: [{ endsAt: NOW + 3_600_000, organizationId: "org2", startsAt: NOW - 7_200_000, target: "usage_anomaly" }],
            platformUsage: [usage("org1", 3000)],
        });

        await expect(runAnomalySweep(database, { now: NOW })).resolves.toMatchObject({ scored: 1 });
    });

    it("skips the last hour of a closed period, which ledger compaction can inflate", async () => {
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const database = fakeControlPlaneDb({ alertRules: [usageRule], anomalyBaselines: [baselineRow] }, { patch });

        const result = await runAnomalySweep(database, { now: Date.UTC(2026, 6, 1, 0, 5) });

        expect(result.scored).toBe(0);
        expect(patch).not.toHaveBeenCalled();
    });

    it("starts a baseline for a new rule without firing on it", async () => {
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("id"));
        const database = fakeControlPlaneDb({ alertRules: [usageRule], platformUsage: [usage("org1", 50_000)] }, { insert });

        const result = await runAnomalySweep(database, { now: NOW });

        expect(result.scored).toBe(1);
        expect(result.deliveries).toStrictEqual([]);
        expect(insert).toHaveBeenCalledWith(
            "anomalyBaselines",
            expect.objectContaining({ lastBucketStart: BUCKET_START, mean: 50_000, organizationId: "org1", samples: 1, signal: "requests" }),
        );
    });

    it("scores error spans for an error_anomaly rule and clears once they recover", async () => {
        const errorRule = { ...usageRule, _id: "rule_err", target: "error_anomaly", threshold: 3 };
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const database = fakeControlPlaneDb(
            {
                alertRuleState: [{ _id: "state_err", firing: true, organizationId: "org1", ruleId: "rule_err" }],
                alertRules: [errorRule],
                anomalyBaselines: [{ ...baselineRow, _id: "base_err", mean: 40, signal: "errors", variance: 25 }],
                observations: Array.from({ length: 40 }, () => {
                    return { level: "error", organizationId: "org1", startedAt: BUCKET_START + 1000 };
                }),
            },
            { patch },
        );

        const result = await runAnomalySweep(database, { now: NOW });

        expect(result.transitions).toMatchObject([{ action: "clear", ruleId: "rule_err" }]);
        expect(patch).toHaveBeenCalledWith("state_err", expect.objectContaining({ firing: false }), "alertRuleState");
    });

    it("measures nothing for orgs without an enabled anomaly rule", async () => {
        const database = fakeControlPlaneDb({ alertRules: [{ ...usageRule, enabled: false }], platformUsage: [usage("org1", 3000)] });
        const findMany = vi.spyOn(database, "findMany");

        await expect(runAnomalySweep(database, { now: NOW })).resolves.toStrictEqual({ deliveries: [], scored: 0, transitions: [] });
        expect(findMany).toHaveBeenCalledTimes(1);
    });
});

describe("anomaly rule + silence validation", () => {
    const rule = (threshold: number, comparator: "gt" | "lt" = "gt") => {
        return { channel: "email", comparator, destination: "ops@example.com", name: "r", organizationId: "org1", target: "usage_anomaly", threshold };
    };

    it("stores an anomaly rule with its comparator and no window", async () => {
        const { ctx, ops } = makeCtx({ alertRules: [], members: [owner("org1")] });

        await createRule.handler(ctx, rule(4) as never);

        const inserted = ops.find((op) => op.kind === "insert" && op.table === "alertRules");

        expect(inserted).toMatchObject({ document: { comparator: "gt", organizationId: "org1", target: "usage_anomaly", threshold: 4 } });
        expect(inserted?.kind === "insert" ? inserted.document : {}).not.toHaveProperty("windowMinutes");
    });

    it.each([
        [0.5, "gt"],
        [-4, "gt"],
        [4, "lt"],
        [51, "gt"],
    ] as const)("refuses threshold %s with %s", async (threshold, comparator) => {
        const { ctx } = makeCtx({ alertRules: [], members: [owner("org1")] });

        await expect(createRule.handler(ctx as never, rule(threshold, comparator) as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    const now = 1_700_000_000_000;

    it("stamps the silence's org and author from the verified membership", async () => {
        const { ctx, ops } = makeCtx({ anomalySilences: [], members: [owner("org1")] }, { now });

        await createSilence.handler(ctx, { endsAt: now + 3_600_000, organizationId: "org1", reason: " load test ", target: "usage_anomaly" } as never);

        expect(ops.find((op) => op.kind === "insert" && op.table === "anomalySilences")).toMatchObject({
            document: { createdBy: "usr_1", endsAt: now + 3_600_000, organizationId: "org1", reason: "load test", startsAt: now },
        });
        expect(ops.find((op) => op.kind === "insert" && op.table === "auditLog")).toMatchObject({
            document: { action: "alerts.silence.create", actorUserId: "usr_1", organizationId: "org1" },
        });
    });

    it("refuses a member who is not an owner or admin", async () => {
        const { ctx } = makeCtx({ anomalySilences: [], members: [{ ...owner("org1"), role: "member" }] }, { now });

        await expect(
            createSilence.handler(ctx as never, { endsAt: now + 3_600_000, organizationId: "org1", reason: "x", target: "usage_anomaly" } as never),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it.each([
        ["in the past", { endsAt: now - 1 }],
        ["longer than 30 days", { endsAt: now + 31 * 86_400_000 }],
        ["ending before it starts", { endsAt: now + 1000, startsAt: now + 2000 }],
    ])("refuses a silence %s", async (_label, window) => {
        const { ctx } = makeCtx({ anomalySilences: [], members: [owner("org1")] }, { now });

        await expect(
            createSilence.handler(ctx as never, { organizationId: "org1", reason: "x", target: "usage_anomaly", ...window } as never),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("caps live silences per org and prunes ended ones", async () => {
        const live = Array.from({ length: 20 }, (_, index) => {
            return { _id: `s${String(index)}`, endsAt: now + 1000, organizationId: "org1" };
        });
        const { ctx, ops } = makeCtx(
            { anomalySilences: [...live, { _id: "ended", endsAt: now - 1, organizationId: "org1" }], members: [owner("org1")] },
            { now },
        );

        await expect(
            createSilence.handler(ctx as never, { endsAt: now + 3_600_000, organizationId: "org1", reason: "x", target: "usage_anomaly" } as never),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(ops).toContainEqual({ id: "ended", kind: "delete" });
    });
});
