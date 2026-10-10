import { describe, expect, it, vi } from "vitest";

import { createRule, createSilence } from "../lunora/alerts";
import type { ReadbackFleet } from "../src/deploy/sweeps";
import { runReadbackUsageSweep } from "../src/deploy/sweeps";
import type { ControlPlaneDatabase } from "../src/store";
import type { AnomalyBaseline } from "../src/telemetry/anomaly";
import { advanceBaseline, ANOMALY_BUCKET_MS, anomalyScore, isSilenced, MIN_ANOMALY_SAMPLES, MIN_ANOMALY_VOLUME, scoreBucket } from "../src/telemetry/anomaly";
import { runAnomalySweep } from "../src/telemetry/anomaly-sweep";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";
import { makeCtx, owner } from "./_helpers/fake-ctx";
import { memoryStore } from "./support/memory-store";

/**
 * 10:30 UTC on 15 June — mid-month. The readback runs on the same tick, so the
 * requests signal scores the hour the previous tick's readback finished
 * (08:00–09:00), storage the hour before (07:00–08:00), errors the last hour.
 */
const NOW = Date.UTC(2026, 5, 15, 10, 30);
const HOUR = ANOMALY_BUCKET_MS;
const BUCKET_START = Date.UTC(2026, 5, 15, 8);
const STORAGE_BUCKET_START = Date.UTC(2026, 5, 15, 7);
const ERRORS_BUCKET_START = Date.UTC(2026, 5, 15, 9);

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
        // Under a cent of storage rows an hour, before and after.
        expect(anomalyScore("storage", { mean: 1e7, samples: 100, variance: 0 }, MIN_ANOMALY_VOLUME.storage - 1)).toBe(0);
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

/** The scored hour's month — the ledger period its rows carry. */
const JUNE = Date.UTC(2026, 5, 1);

/** One ledger row of `quantity` requests, as the readback writes it: for the hour from `windowStart`, written as it ends. */
const usage = (organizationId: string, quantity: number, windowStart = BUCKET_START, kind = "requests", periodStart = JUNE) => {
    return { createdAt: windowStart + HOUR, kind, organizationId, periodStart, quantity, windowEnd: windowStart + HOUR, windowStart };
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
                platformUsage: [usage("org1", 2400), usage("org1", 600), usage("org2", 1_000_000), usage("org1", 1_000_000, BUCKET_START - HOUR)],
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
                // Every row whose window can overlap the hour was written at or after it began.
                where: { createdAt: { gte: BUCKET_START }, kind: "requests", organizationId: "org1" },
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

    /**
     * The readback bills a window to the month it happened in, so the first run
     * of a month writes rows of the month before — and compaction can then fold
     * the whole closed month onto one of them. Scored by `createdAt`, that
     * survivor read as a month of traffic in one hour; scored by its window, it
     * does not overlap the new month's hours at all.
     */
    it("never counts a closed month's compaction survivor written in the scored hour", async () => {
        const july = Date.UTC(2026, 6, 1);
        // At 03:30 the requests signal scores 01:00–02:00 (the hour the 02:00 readback finished).
        const now = Date.UTC(2026, 6, 1, 3, 30);
        const bucket = Date.UTC(2026, 6, 1, 1);
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const survivor = { ...usage("org1", 60_000_000, july - HOUR), createdAt: bucket + 5 * 60_000 };
        // A self-reported row of June, created in July, carrying the month: counted for its own month only.
        const reported = { createdAt: bucket + 7 * 60_000, kind: "requests", organizationId: "org1", periodStart: JUNE, quantity: 60_000_000 };
        const database = fakeControlPlaneDb(
            {
                alertRuleState: [],
                alertRules: [usageRule],
                anomalyBaselines: [{ ...baselineRow, lastBucketStart: bucket - ANOMALY_BUCKET_MS }],
                anomalySilences: [],
                platformUsage: [survivor, reported, usage("org1", 2000, bucket, "requests", july)],
            },
            { patch },
        );

        const result = await runAnomalySweep(database, { now });

        expect(result.deliveries).toStrictEqual([]);
        expect(patch).toHaveBeenCalledWith("base_req", expect.objectContaining({ lastBucketStart: bucket, lastValue: 2000 }), "anomalyBaselines");
    });

    it("fires a storage anomaly when a Durable Object runs away on rows without any requests", async () => {
        const storageRule = { ...usageRule, _id: "rule_storage", name: "Storage runaway", target: "storage_anomaly" };
        // A warmed baseline of about 4 cents of storage rows an hour, priced in nano-cents.
        const storageBaseline = {
            ...baselineRow,
            _id: "base_storage",
            lastBucketStart: STORAGE_BUCKET_START - HOUR,
            mean: 4e9,
            signal: "storage",
            variance: 5e8 * 5e8,
        };
        const insert = vi.fn<ControlPlaneDatabase["insert"]>((table: string) => Promise.resolve(`${table}_id`));
        const database = fakeControlPlaneDb(
            {
                alertRuleState: [],
                alertRules: [storageRule],
                anomalyBaselines: [storageBaseline],
                anomalySilences: [],
                // An alarm loop: a billion rows read and two million written in the hour, no requests at all.
                platformUsage: [
                    usage("org1", 1_000_000_000, STORAGE_BUCKET_START, "doRowsRead"),
                    usage("org1", 2_000_000, STORAGE_BUCKET_START, "doRowsWritten"),
                    usage("org1", 5000, STORAGE_BUCKET_START, "d1RowsWritten"),
                ],
            },
            { insert },
        );

        const result = await runAnomalySweep(database, { now: NOW });
        // 1e9 × 100 + 2e6 × 100_000 + 5000 × 100_000 nano-cents.
        const value = 1e9 * 100 + 2e6 * 100_000 + 5000 * 100_000;

        expect(result.transitions).toStrictEqual([
            {
                action: "fire",
                organizationId: "org1",
                reading: { mean: 4e9, score: (value - 4e9) / 5e8, value },
                ruleId: "rule_storage",
                target: "storage_anomaly",
            },
        ]);
        expect(result.deliveries[0]?.subject).toContain("storage row cost anomaly");
        expect(result.deliveries[0]?.body).toContain("$3.0050");
        expect(insert).toHaveBeenCalledWith("alerts", expect.objectContaining({ ruleId: "rule_storage", target: "storage_anomaly" }));
    });

    it("scores a write runaway against a read-heavy normal, priced, and a read wobble as noise", () => {
        // Normal: ten million rows read an hour (one cent). Runaway: the same reads plus a million writes, priced at 100,000 nano-cents each.
        const baseline: AnomalyBaseline = { mean: 1e9, samples: MIN_ANOMALY_SAMPLES + 10, variance: 1e8 * 1e8 };

        expect(anomalyScore("storage", baseline, 1e9 + 1e6 * 100_000)).toBeGreaterThan(50);
        // A one-percent wobble in reads is noise.
        expect(Math.abs(anomalyScore("storage", baseline, 1.01e9))).toBeLessThan(1);
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
                    return { level: "error", organizationId: "org1", startedAt: ERRORS_BUCKET_START + 1000 };
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

/**
 * The readback and the anomaly sweep end to end, on the same hourly ticks: a
 * steady 2000 requests an hour must never alert, whatever the windows the
 * readback happens to read — a month boundary, or a catch-up after failed reads.
 */
describe("anomaly scoring of what the readback writes", () => {
    const RATE = 2000;
    /** The scheduled tick lands a little after the hour, as `Date.now()` does. */
    const JITTER = 400;
    const shop = { _id: "dep_shop", organizationId: "org1", resourceRef: "shop", scriptName: "shop", status: "live", target: "cloudflare-wfp" };

    /** Run hourly ticks from `first` to `last` (hour starts): anomaly sweep first (the worst order of the race), then the readback. */
    const run = async (first: number, last: number, failing: (tick: number) => boolean) => {
        const database = memoryStore({
            alertRuleState: [],
            alertRules: [usageRule],
            // Warm at 2000 ± 100, already folded up to the hour before the first one scored.
            anomalyBaselines: [{ ...baselineRow, lastBucketStart: first - 2 * HOUR }],
            anomalySilences: [],
            deployments: [shop],
            usageCheckpoints: [{ _id: "cp_req", readAtMs: first - HOUR + JITTER, scopeKey: "default", target: "cloudflare-wfp", updatedAt: 0 }],
        });
        const fleet: ReadbackFleet = {
            id: "cloudflare-wfp",
            usage: {
                scopes: () => Promise.resolve(["default"]),
                sources: {
                    requests: {
                        cadence: "continuous",
                        // A steady rate: the count is proportional to whatever window is asked for.
                        read: (_scope, window) =>
                            failing(window.untilMs)
                                ? Promise.reject(new Error("analytics 503"))
                                : Promise.resolve([{ meters: { requests: (RATE * (window.untilMs - window.sinceMs)) / HOUR }, resourceRef: "shop" }]),
                    },
                },
            },
        };
        const deliveries: unknown[] = [];
        const values: number[] = [];
        let skipped = 0;

        for (let tick = first; tick <= last; tick += HOUR) {
            const now = tick + JITTER;
            const before = (database.tables["anomalyBaselines"]?.[0] as { lastBucketStart: number }).lastBucketStart;
            // eslint-disable-next-line no-await-in-loop -- ticks are sequential by construction
            const result = await runAnomalySweep(database, { cell: "default", now });
            // eslint-disable-next-line no-await-in-loop -- the readback of the same tick, after the sweep
            await runReadbackUsageSweep(database, [fleet], { now, onScopeFailed: () => undefined });
            const baseline = database.tables["anomalyBaselines"]?.[0] as { lastBucketStart: number; lastValue: number; variance: number };

            deliveries.push(...result.deliveries);

            if (baseline.lastBucketStart === before) {
                skipped += 1;
            } else {
                values.push(baseline.lastValue);
            }
        }

        const baseline = database.tables["anomalyBaselines"]?.[0] as { mean: number; variance: number };

        return { deliveries, mean: baseline.mean, skipped, values, variance: baseline.variance };
    };

    it("scores a steady hour across a month boundary as steady: no alert, and the baseline keeps its spread", async () => {
        const outcome = await run(Date.UTC(2026, 5, 30, 20), Date.UTC(2026, 6, 1, 6), () => false);

        expect(outcome.deliveries).toStrictEqual([]);
        // Skipped: the first tick (its hour was already folded in), and June 30 22:00 and 23:00,
        // scored only after June closed — an hour of a closed month is never scored.
        expect(outcome.skipped).toBe(3);
        expect(outcome.values.every((value) => Math.abs(value - RATE) < 1)).toBe(true);
        expect(Math.abs(outcome.mean - RATE)).toBeLessThan(1);
        // Folding steady hours only shrinks the variance; the regression blew 10,000 up to ~196,000.
        expect(outcome.variance).toBeLessThanOrEqual(warm.variance);
    });

    it("scores the hours of a catch-up run as the steady hours they were: no spike, no dip", async () => {
        const down = [Date.UTC(2026, 5, 15, 3), Date.UTC(2026, 5, 15, 4), Date.UTC(2026, 5, 15, 5)];
        // Three readback ticks fail in a row; the fourth reads four hours at once.
        const outcome = await run(Date.UTC(2026, 5, 15, 0), Date.UTC(2026, 5, 15, 12), (until) => down.includes(Math.floor(until / HOUR) * HOUR));

        expect(outcome.deliveries).toStrictEqual([]);
        // The hours not yet read back are held, not scored as a collapse (plus the first
        // tick, whose hour was already folded in)…
        expect(outcome.skipped).toBe(down.length + 1);
        // …and the catch-up is spread over the hours it covers, not scored as one spike.
        expect(outcome.values.every((value) => Math.abs(value - RATE) < 1)).toBe(true);
        expect(outcome.variance).toBeLessThanOrEqual(warm.variance);
    });
});
