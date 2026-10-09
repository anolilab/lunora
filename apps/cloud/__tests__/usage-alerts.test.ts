import { describe, expect, expectTypeOf, it } from "vitest";

import type { Doc, IndexName } from "../lunora/_generated/dataModel.js";
import { createRule, suggestUsageThreshold, usageProgress } from "../lunora/alerts";
import { alertFamily } from "../src/telemetry/alerts";
import { runUsageAlertSweep } from "../src/telemetry/usage-alert-sweep";
import type { UsageAlertMeter } from "../src/telemetry/usage-alerts";
import {
    evaluatedPeriods,
    PREVIOUS_MONTH_GRACE_MS,
    previousPeriodStart,
    usageAlertDecision,
    usageThresholdSuggestion,
    usageTotal,
} from "../src/telemetry/usage-alerts";
import { makeCtx, owner } from "./_helpers/fake-ctx";
import { memoryStore } from "./support/memory-store";

const JUNE = Date.UTC(2026, 5, 1);
const JULY = Date.UTC(2026, 6, 1);
/** Mid-June, 10:05 UTC. */
const MID_JUNE = Date.UTC(2026, 5, 15, 10, 5);

/** A usage rule row as `createRule` stores it. */
const rule = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    return {
        _id: "rule_req",
        channel: "email",
        destination: "ops@example.com",
        enabled: true,
        meter: "requests",
        name: "Requests budget",
        organizationId: "org_a",
        target: "usage_threshold",
        threshold: 2_000_000,
        ...overrides,
    };
};

/** One ledger row of `quantity` of `kind` for `org_a` in `periodStart`, from `deploymentId`. */
const usage = (quantity: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    return { createdAt: MID_JUNE, deploymentId: "dep_shop", kind: "requests", organizationId: "org_a", periodStart: JUNE, quantity, ...overrides };
};

const deployments = [
    { _id: "dep_shop", organizationId: "org_a", projectId: "prj_shop" },
    { _id: "dep_blog", organizationId: "org_a", projectId: "prj_blog" },
];

describe("the usage validators", () => {
    it("pair the stored meter with the meters a usage rule may watch", () => {
        expectTypeOf<NonNullable<Doc<"alertRules">["meter"]>>().toEqualTypeOf<UsageAlertMeter>();
    });

    it("classify usage_threshold as its own family", () => {
        expect(alertFamily("usage_threshold")).toBe("usage");
    });
});

describe(usageAlertDecision, () => {
    const MAY = Date.UTC(2026, 4, 1);

    it.each([
        ["fires at the threshold", { firedPeriod: undefined, firing: false, monthToDate: 100 }, "fire"],
        ["holds below it", { firedPeriod: null, firing: false, monthToDate: 99 }, "hold"],
        ["holds once fired this month, however far past", { firedPeriod: JUNE, firing: true, monthToDate: 10_000 }, "hold"],
        ["never fires a month once a later month fired", { firedPeriod: JULY, firing: true, monthToDate: 10_000 }, "hold"],
        ["fires again in a new month once crossed", { firedPeriod: MAY, firing: true, monthToDate: 100 }, "fire"],
        ["re-arms in a new month while below", { firedPeriod: MAY, firing: true, monthToDate: 5 }, "rearm"],
        ["has nothing to re-arm once re-armed", { firedPeriod: MAY, firing: false, monthToDate: 5 }, "hold"],
    ] as const)("%s", (_name, input, expected) => {
        expect(usageAlertDecision({ ...input, periodStart: JUNE, threshold: 100 })).toBe(expected);
    });
});

describe(evaluatedPeriods, () => {
    it("reads the previous month for the first 48 hours of a new one, then the current month alone", () => {
        expect(evaluatedPeriods(JULY)).toStrictEqual([JUNE, JULY]);
        expect(evaluatedPeriods(JULY + PREVIOUS_MONTH_GRACE_MS - 1)).toStrictEqual([JUNE, JULY]);
        expect(evaluatedPeriods(JULY + PREVIOUS_MONTH_GRACE_MS)).toStrictEqual([JULY]);
        expect(PREVIOUS_MONTH_GRACE_MS).toBe(48 * 60 * 60 * 1000);
    });
});

describe(usageTotal, () => {
    const rows = [
        { deploymentId: "dep_shop", quantity: 10 },
        { deploymentId: "dep_blog", quantity: 5 },
        { deploymentId: null, quantity: 3 },
        { deploymentId: "dep_shop", quantity: Number.NaN },
    ];
    const projectOf = (id: string): string | undefined => deployments.find((row) => row._id === id)?.projectId;

    it("counts every row for an org-wide rule, and only the project's deployments for a project rule", () => {
        expect(usageTotal(rows, undefined, projectOf)).toBe(18);
        expect(usageTotal(rows, "prj_shop", projectOf)).toBe(10);
        expect(usageTotal(rows, "prj_gone", projectOf)).toBe(0);
    });
});

describe(usageThresholdSuggestion, () => {
    it("suggests three times last month, to two significant figures", () => {
        expect(usageThresholdSuggestion("requests", 1_234_567, JUNE)).toStrictEqual({
            basis: "history",
            lastMonth: 1_234_567,
            meter: "requests",
            periodStart: JUNE,
            suggested: 3_700_000,
            unit: "requests",
        });
        expect(usageThresholdSuggestion("cpuMs", 6_660_000, JUNE).suggested).toBe(20_000_000);
    });

    it("never suggests below the meter's floor, so a quiet month does not alert on noise", () => {
        expect(usageThresholdSuggestion("requests", 1000, JUNE)).toMatchObject({ basis: "floor", lastMonth: 1000, suggested: 1_000_000 });
        expect(usageThresholdSuggestion("doDurationGbS", 0, JUNE)).toMatchObject({ basis: "floor", suggested: 100_000, unit: "GB-s" });
    });

    it("answers no history with null and the floor", () => {
        expect(usageThresholdSuggestion("d1RowsWritten", null, JUNE)).toMatchObject({ basis: "floor", lastMonth: null, suggested: 1_000_000 });
    });

    it("names last month across a year boundary", () => {
        expect(previousPeriodStart(Date.UTC(2027, 0, 3))).toBe(Date.UTC(2026, 11, 1));
    });
});

describe(runUsageAlertSweep, () => {
    it("fires once when the month's usage reaches the threshold, and not again that month", async () => {
        const database = memoryStore({ alertRules: [rule()], alertRuleState: [], platformUsage: [usage(1_500_000), usage(600_000)] });

        const first = await runUsageAlertSweep(database, { now: MID_JUNE });

        expect(first.fired).toBe(1);
        expect(first.deliveries).toStrictEqual([
            {
                body: expect.stringContaining("Workers requests on Lunora Cloud reached 2,100,000 requests in June 2026 (UTC)") as string,
                channel: "email",
                destination: "ops@example.com",
                id: "alerts_2",
                subject: "[Lunora] Requests budget: Workers requests passed 2,000,000 requests this month",
            },
        ]);
        expect(database.tables["alerts"]).toStrictEqual([
            expect.objectContaining({
                hash: `usage:requests:*:${String(JUNE)}`,
                organizationId: "org_a",
                ruleId: "rule_req",
                status: "firing",
                target: "usage_threshold",
            }),
        ]);
        expect(database.tables["alertRuleState"]).toStrictEqual([
            expect.objectContaining({ firedPeriod: JUNE, firing: true, lastValue: 2_100_000, organizationId: "org_a", ruleId: "rule_req" }),
        ]);

        database.tables["platformUsage"]?.push(usage(5_000_000));

        const again = await runUsageAlertSweep(database, { now: MID_JUNE + 3_600_000 });

        expect(again.fired).toBe(0);
        expect(database.tables["alerts"]).toHaveLength(1);
    });

    it("does not fire below the threshold, and fires the sweep after usage crosses it mid-month", async () => {
        const database = memoryStore({ alertRules: [rule()], platformUsage: [usage(1_999_999)] });

        await expect(runUsageAlertSweep(database, { now: MID_JUNE })).resolves.toMatchObject({ evaluatedOrgs: 1, fired: 0 });
        expect(database.tables["alerts"]).toBeUndefined();
        expect(database.tables["alertRuleState"]).toBeUndefined();

        database.tables["platformUsage"]?.push(usage(1));

        await expect(runUsageAlertSweep(database, { now: MID_JUNE + 3_600_000 })).resolves.toMatchObject({ fired: 1 });
    });

    it("re-arms in a new month: last month's usage does not count, and the rule fires again once this month crosses", async () => {
        const database = memoryStore({
            alertRules: [rule()],
            alertRuleState: [{ _id: "state_1", firedPeriod: JUNE, firing: true, organizationId: "org_a", ruleId: "rule_req" }],
            platformUsage: [usage(9_000_000), usage(1_000_000, { periodStart: JULY })],
        });
        const early = Date.UTC(2026, 6, 2, 3);

        await expect(runUsageAlertSweep(database, { now: early })).resolves.toMatchObject({ fired: 0 });
        // June stays the latest month it fired for: June can never fire again.
        expect(database.tables["alertRuleState"]).toStrictEqual([expect.objectContaining({ firedPeriod: JUNE, firing: false, lastValue: 1_000_000 })]);

        database.tables["platformUsage"]?.push(usage(1_000_000, { periodStart: JULY }));

        await expect(runUsageAlertSweep(database, { now: early + 3_600_000 })).resolves.toMatchObject({ fired: 1 });
        expect(database.tables["alertRuleState"]).toStrictEqual([expect.objectContaining({ firedPeriod: JULY, firing: true })]);
        expect(database.tables["alerts"]).toStrictEqual([expect.objectContaining({ hash: `usage:requests:*:${String(JULY)}` })]);
    });

    it("counts only the project's deployments for a project rule, and everything for an org-wide one", async () => {
        const database = memoryStore({
            alertRules: [rule({ _id: "rule_shop", projectId: "prj_shop", threshold: 150 }), rule({ _id: "rule_org", threshold: 150 })],
            deployments,
            platformUsage: [usage(100), usage(100, { deploymentId: "dep_blog" }), usage(40, { deploymentId: undefined })],
            projects: [{ _id: "prj_shop", name: "Shop", organizationId: "org_a" }],
        });

        const result = await runUsageAlertSweep(database, { now: MID_JUNE });

        expect(result.deliveries.map((delivery) => delivery.subject)).toStrictEqual([
            "[Lunora] Requests budget: Workers requests passed 150 requests this month",
        ]);
        expect(result.deliveries[0]?.body).not.toContain("for project");
        expect(database.tables["alerts"]).toStrictEqual([expect.objectContaining({ ruleId: "rule_org" })]);

        database.tables["platformUsage"]?.push(usage(50));

        await runUsageAlertSweep(database, { now: MID_JUNE + 3_600_000 });

        expect(database.tables["alerts"]?.map((alert) => alert["ruleId"])).toStrictEqual(["rule_org", "rule_shop"]);
        expect(database.tables["alerts"]?.[1]).toMatchObject({
            body: expect.stringContaining('Workers requests for project "Shop" on Lunora Cloud reached 150 requests') as string,
            hash: `usage:requests:prj_shop:${String(JUNE)}`,
        });
    });

    it("counts display-only rows, and ignores other meters, other orgs, other months and disabled rules", async () => {
        const database = memoryStore({
            alertRules: [rule({ meter: "cpuMs", threshold: 1000 }), rule({ _id: "rule_off", enabled: false, threshold: 1 })],
            platformUsage: [
                usage(600, { billable: false, kind: "cpuMs" }),
                usage(399, { kind: "cpuMs" }),
                usage(5000, { kind: "requests" }),
                usage(5000, { kind: "cpuMs", organizationId: "org_b" }),
                usage(5000, { kind: "cpuMs", periodStart: Date.UTC(2026, 4, 1) }),
            ],
        });

        await expect(runUsageAlertSweep(database, { now: MID_JUNE })).resolves.toMatchObject({ evaluatedOrgs: 1, fired: 0 });

        database.tables["platformUsage"]?.push(usage(1, { kind: "cpuMs" }));

        const result = await runUsageAlertSweep(database, { now: MID_JUNE });

        expect(result.deliveries[0]?.subject).toBe("[Lunora] Requests budget: Workers CPU time passed 1,000 CPU ms this month");
    });

    it("reads nothing past the rules when no organization has a usage rule", async () => {
        const database = memoryStore({ alertRules: [rule({ target: "usage_anomaly" })], platformUsage: [usage(1e12)] });

        await expect(runUsageAlertSweep(database, { now: MID_JUNE })).resolves.toStrictEqual({ deliveries: [], evaluatedOrgs: 0, fired: 0, incomplete: [] });
    });
});

describe("usage rule creation", () => {
    const input = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
        return {
            channel: "email",
            destination: "ops@example.com",
            meter: "doRowsWritten",
            name: "DO writes",
            organizationId: "org_a",
            target: "usage_threshold",
            threshold: 50_000_000,
            ...overrides,
        };
    };
    const tables = () => {
        return {
            alertRules: [],
            members: [owner("org_a")],
            projects: [
                { _id: "prj_shop", organizationId: "org_a" },
                { _id: "prj_other", organizationId: "org_b" },
            ],
        };
    };

    it("stores the meter and the project, and none of the metric fields", async () => {
        const { ctx, ops } = makeCtx(tables());

        await createRule.handler(ctx, input({ projectId: "prj_shop" }) as never);

        const inserted = ops.find((op) => op.kind === "insert" && op.table === "alertRules");
        const document = inserted?.kind === "insert" ? inserted.document : {};

        expect(document).toMatchObject({ meter: "doRowsWritten", projectId: "prj_shop", target: "usage_threshold", threshold: 50_000_000 });
        expect(document).not.toHaveProperty("comparator");
        expect(document).not.toHaveProperty("windowMinutes");
    });

    it.each([
        ["no meter", { meter: undefined }, "BAD_REQUEST"],
        ["a threshold below one", { threshold: 0 }, "BAD_REQUEST"],
        ["another organization's project", { projectId: "prj_other" }, "NOT_FOUND"],
        ["a meter on another family's rule", { target: "issue", threshold: 5 }, "BAD_REQUEST"],
        ["a deviation mode", { mode: "deviation" }, "BAD_REQUEST"],
    ])("refuses %s and writes no rule", async (_name, overrides, code) => {
        const { ctx, ops } = makeCtx(tables());

        await expect(createRule.handler(ctx as never, input(overrides) as never)).rejects.toMatchObject({ code });
        expect(ops.filter((op) => op.kind === "insert" && op.table === "alertRules")).toStrictEqual([]);
    });
});

describe("usage rule queries", () => {
    /** 9 July: last full month is June. */
    const now = Date.UTC(2026, 6, 9);

    it("suggests from last full month's usage of the organization, and says when there is none", async () => {
        const { ctx } = makeCtx(
            {
                members: [owner("org_a")],
                platformUsage: [
                    usage(4_000_000, { kind: "doRequests" }),
                    usage(2_000_000, { billable: false, deploymentId: "dep_blog", kind: "doRequests" }),
                    usage(9e9, { kind: "doRequests", periodStart: JULY }),
                    usage(9e9, { kind: "doRequests", organizationId: "org_b" }),
                ],
            },
            { now },
        );

        await expect(suggestUsageThreshold.handler(ctx, { meter: "doRequests", organizationId: "org_a" } as never)).resolves.toStrictEqual({
            basis: "history",
            lastMonth: 6_000_000,
            meter: "doRequests",
            periodStart: JUNE,
            suggested: 18_000_000,
            unit: "requests",
        });
        await expect(suggestUsageThreshold.handler(ctx, { meter: "cpuMs", organizationId: "org_a" } as never)).resolves.toMatchObject({
            basis: "floor",
            lastMonth: null,
            suggested: 10_000_000,
        });
    });

    it("refuses a caller who is not a member", async () => {
        const { ctx } = makeCtx({ members: [owner("org_b")] }, { now });

        await expect(suggestUsageThreshold.handler(ctx, { meter: "requests", organizationId: "org_a" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(usageProgress.handler(ctx, { organizationId: "org_a" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("reports each usage rule's month-to-date usage as the sweep counts it", async () => {
        const { ctx } = makeCtx(
            {
                alertRules: [
                    rule({ _id: "rule_org" }),
                    rule({ _id: "rule_shop", projectId: "prj_shop" }),
                    rule({ _id: "rule_issue", meter: undefined, target: "issue" }),
                ],
                deployments,
                members: [owner("org_a")],
                platformUsage: [usage(7, { periodStart: JULY }), usage(5, { deploymentId: "dep_blog", periodStart: JULY }), usage(1000)],
            },
            { now },
        );

        await expect(usageProgress.handler(ctx, { organizationId: "org_a" } as never)).resolves.toStrictEqual([
            { complete: true, monthToDate: 12, ruleId: "rule_org" },
            { complete: true, monthToDate: 7, ruleId: "rule_shop" },
        ]);
    });
});

describe("usageProgress over a month too long to read", () => {
    it("reports a lower bound, marked incomplete, rather than a partial sum passed off as the month", async () => {
        const { ctx } = makeCtx({ alertRules: [rule({ _id: "rule_org" })], members: [owner("org_a")], platformUsage: [] }, { now: MID_JUNE });
        let page = 0;

        (ctx.db as unknown as { platformUsage: { findMany: () => Promise<unknown> } }).platformUsage.findMany = () => {
            page += 1;

            return Promise.resolve({ continueCursor: String(page), isDone: false, page: [{ deploymentId: "dep_shop", quantity: 1 }] });
        };

        await expect(usageProgress.handler(ctx, { organizationId: "org_a" } as never)).resolves.toStrictEqual([
            { complete: false, monthToDate: 100, ruleId: "rule_org" },
        ]);
    });
});

describe("a month's usage that lands after the month ends", () => {
    /** June 30, 23:00 UTC, and the July hours after it. */
    const LAST_HOUR = Date.UTC(2026, 5, 30, 23);
    const HOUR = 3_600_000;

    it("alerts June once when its last rows arrive in July's first hours, and never again", async () => {
        const database = memoryStore({ alertRules: [rule()], platformUsage: [usage(1_900_000)] });

        await expect(runUsageAlertSweep(database, { now: LAST_HOUR })).resolves.toMatchObject({ fired: 0 });

        // The last hours of June, read back after midnight (a catch-up after an outage).
        database.tables["platformUsage"]?.push(usage(500_000, { createdAt: JULY + 5 * HOUR }));

        let fired = 0;

        for (let hour = 1; hour <= 48; hour += 1) {
            // eslint-disable-next-line no-await-in-loop -- the sweeps of consecutive hours, in order
            const result = await runUsageAlertSweep(database, { now: JULY + hour * HOUR });

            fired += result.fired;
        }

        expect(fired).toBe(1);
        expect(database.tables["alerts"]).toStrictEqual([
            expect.objectContaining({
                body: expect.stringContaining("reached 2,400,000 requests in June 2026") as string,
                hash: `usage:requests:*:${String(JUNE)}`,
            }),
        ]);
        expect(database.tables["alertRuleState"]).toStrictEqual([expect.objectContaining({ firedPeriod: JUNE })]);
    });

    it("fires the late June and a crossed July as two alerts, one per month", async () => {
        const database = memoryStore({
            alertRules: [rule()],
            platformUsage: [usage(2_500_000), usage(2_500_000, { periodStart: JULY })],
        });

        const result = await runUsageAlertSweep(database, { now: JULY + 3 * HOUR });

        expect(result.fired).toBe(2);
        expect(database.tables["alerts"]?.map((alert) => alert["hash"])).toStrictEqual([
            `usage:requests:*:${String(JUNE)}`,
            `usage:requests:*:${String(JULY)}`,
        ]);
        expect(database.tables["alertRuleState"]).toStrictEqual([expect.objectContaining({ firedPeriod: JULY, firing: true })]);
        await expect(runUsageAlertSweep(database, { now: JULY + 4 * HOUR })).resolves.toMatchObject({ fired: 0 });
    });

    it("does not fire June twice when it fired in June and its last rows arrive in July", async () => {
        const database = memoryStore({
            alertRules: [rule()],
            alertRuleState: [{ _id: "state_1", firedPeriod: JUNE, firing: true, organizationId: "org_a", ruleId: "rule_req" }],
            platformUsage: [usage(2_100_000), usage(900_000, { createdAt: JULY + HOUR })],
        });

        for (let hour = 1; hour <= 6; hour += 1) {
            // eslint-disable-next-line no-await-in-loop -- consecutive hourly sweeps
            await expect(runUsageAlertSweep(database, { now: JULY + hour * HOUR })).resolves.toMatchObject({ fired: 0 });
        }

        expect(database.tables["alerts"]).toBeUndefined();
    });

    it("stops reading June once the grace hours are over", async () => {
        const database = memoryStore({ alertRules: [rule()], platformUsage: [usage(5_000_000)] });

        await expect(runUsageAlertSweep(database, { now: JULY + PREVIOUS_MONTH_GRACE_MS })).resolves.toMatchObject({ fired: 0 });
    });
});

describe("a ledger read that stops at the drain's page cap", () => {
    /** The memory store, answering `platformUsage` one row per page, as a busy organization's month pages. */
    const paged = (rows: Record<string, unknown>[]): ReturnType<typeof memoryStore> => {
        const database = memoryStore({ alertRules: [rule({ threshold: 1000 })], platformUsage: rows });
        const findMany = database.findMany.bind(database);

        database.findMany = async (table, args) => {
            const answer = await findMany(table, args);

            if (table !== "platformUsage") {
                return answer;
            }

            const offset = Number(args?.cursor ?? 0);
            const done = offset + 1 >= answer.page.length;

            return { continueCursor: done ? null : String(offset + 1), isDone: done, page: answer.page.slice(offset, offset + 1) };
        };

        return database;
    };

    it("leaves a rule below its threshold so far undecided and reported, never 'below'", async () => {
        // 150 pages of one request: the drain stops at 100.
        const database = paged(Array.from({ length: 150 }, () => usage(1)));

        await expect(runUsageAlertSweep(database, { now: MID_JUNE })).resolves.toStrictEqual({
            deliveries: [],
            evaluatedOrgs: 1,
            fired: 0,
            incomplete: [{ organizationId: "org_a", periodStart: JUNE, ruleId: "rule_req" }],
        });
        expect(database.tables["alertRuleState"]).toBeUndefined();
    });

    it("fires on the lower bound once what it did read is past the threshold", async () => {
        const database = paged(Array.from({ length: 150 }, () => usage(20)));

        await expect(runUsageAlertSweep(database, { now: MID_JUNE })).resolves.toMatchObject({ fired: 1, incomplete: [] });
    });

    it("reads one meter's month through an index that leads with the organization and the month", () => {
        expectTypeOf<"by_org_period_kind">().toExtend<IndexName<"platformUsage">>();
    });
});
