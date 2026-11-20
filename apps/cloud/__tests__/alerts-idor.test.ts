import { describe, expect, it } from "vitest";

import { anomalyBaselines, createRule, deleteRule, deleteSilence, setRuleEnabled, silences } from "../lunora/alerts";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * Alert rules and silences are org-scoped and carry no project or deployment
 * column, so "the right row" is: the named table, and the caller's verified
 * org. The ids below share one id space, as a well-formed id of another table
 * does in production, so a check that only asked "is this row in my org?"
 * through the table-agnostic reader would pass on the wrong row.
 */
const NOW = 1_700_000_000_000;

const tables = () => {
    return {
        alertRules: [
            { _id: "rule_org1", enabled: true, organizationId: "org1" },
            { _id: "rule_org2", enabled: true, organizationId: "org2" },
        ],
        alerts: [{ _id: "alert_org1", organizationId: "org1", status: "firing" }],
        anomalyBaselines: [{ _id: "base_org2", organizationId: "org2", samples: 30, signal: "requests" }],
        anomalySilences: [
            { _id: "sil_org1", endsAt: NOW + 1000, organizationId: "org1", target: "usage_anomaly" },
            { _id: "sil_org2", endsAt: NOW + 1000, organizationId: "org2", target: "usage_anomaly" },
        ],
        members: [owner("org1")],
    };
};

/** Every write except the rate limiter's own bucket row. */
const writes = (ops: ReturnType<typeof makeCtx>["ops"]) => ops.filter((op) => op.kind !== "insert" || op.table !== "rateLimits");

describe("alert rule and silence ids are pinned to their table and org", () => {
    it.each([
        ["setRuleEnabled with another org's rule", setRuleEnabled, { enabled: false, id: "rule_org2" }],
        ["setRuleEnabled with an alerts id of the same org", setRuleEnabled, { enabled: false, id: "alert_org1" }],
        ["setRuleEnabled with a silence id of the same org", setRuleEnabled, { enabled: false, id: "sil_org1" }],
        ["deleteRule with another org's rule", deleteRule, { id: "rule_org2" }],
        ["deleteRule with a silence id of the same org", deleteRule, { id: "sil_org1" }],
        ["deleteSilence with another org's silence", deleteSilence, { id: "sil_org2" }],
        ["deleteSilence with a rule id of the same org", deleteSilence, { id: "rule_org1" }],
        ["deleteSilence with an alerts id of the same org", deleteSilence, { id: "alert_org1" }],
    ] as const)("refuses %s and writes nothing", async (_label, mutation, args) => {
        const { ctx, ops } = makeCtx(tables(), { now: NOW });

        await expect(mutation.handler(ctx, { organizationId: "org1", ...args } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(writes(ops)).toStrictEqual([]);
    });

    it.each([
        ["another org's project", "prj_org2"],
        ["a rule id of the same org", "rule_org1"],
    ])("refuses a usage rule scoped to %s and writes nothing", async (_label, projectId) => {
        const { ctx, ops } = makeCtx(
            {
                ...tables(),
                projects: [
                    { _id: "prj_org1", organizationId: "org1" },
                    { _id: "prj_org2", organizationId: "org2" },
                ],
            },
            { now: NOW },
        );
        const rule = {
            channel: "email",
            destination: "ops@example.com",
            meter: "requests",
            name: "r",
            organizationId: "org1",
            target: "usage_threshold",
            threshold: 10,
        };

        await expect(createRule.handler(ctx, { ...rule, projectId } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(writes(ops)).toStrictEqual([]);
    });

    it("touches the named row of its own table", async () => {
        const { ctx, ops } = makeCtx(tables(), { now: NOW });

        await deleteSilence.handler(ctx, { id: "sil_org1", organizationId: "org1" } as never);
        await setRuleEnabled.handler(ctx, { enabled: false, id: "rule_org1", organizationId: "org1" } as never);

        expect(ops).toContainEqual({ id: "sil_org1", kind: "delete" });
        expect(ops).toContainEqual({ id: "rule_org1", kind: "patch", patch: { enabled: false, updatedAt: NOW } });
    });

    it("refuses a viewer before touching the row", async () => {
        const { ctx, ops } = makeCtx({ ...tables(), members: [{ ...owner("org1"), role: "viewer" }] }, { now: NOW });

        await expect(deleteSilence.handler(ctx, { id: "sil_org1", organizationId: "org1" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(writes(ops)).toStrictEqual([]);
    });

    it("lists only the caller's org's silences, and refuses another org's reads", async () => {
        const { ctx } = makeCtx(tables(), { now: NOW });

        await expect(silences.handler(ctx, { organizationId: "org1" } as never)).resolves.toMatchObject([{ _id: "sil_org1" }]);
        await expect(silences.handler(ctx, { organizationId: "org2" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(anomalyBaselines.handler(ctx, { organizationId: "org2" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("drops metric-only fields from an anomaly rule, so it cannot scope to a function path", async () => {
        const { ctx, ops } = makeCtx({ alertRules: [], members: [owner("org1")] }, { now: NOW });

        await createRule.handler(ctx, {
            channel: "email",
            destination: "ops@example.com",
            functionPath: "someone:else",
            name: "r",
            organizationId: "org1",
            target: "usage_anomaly",
            threshold: 4,
            windowMinutes: 5,
        } as never);

        const inserted = ops.find((op) => op.kind === "insert" && op.table === "alertRules");

        expect(inserted?.kind === "insert" ? new Set(Object.keys(inserted.document)) : undefined).toStrictEqual(
            new Set(["channel", "comparator", "createdAt", "destination", "enabled", "name", "organizationId", "target", "threshold", "updatedAt"]),
        );
    });
});
