import { describe, expect, it } from "vitest";

import { ingest as ingestLogs, ingestGroups as ingestLogGroups } from "../lunora/logs";
import { ingest as ingestMetrics } from "../lunora/metrics";
import { ingest as ingestTelemetry } from "../lunora/telemetry";
import { hashDeployKey } from "../src/deploy/keys";
import { makeCtx } from "./_helpers/fake-ctx";

/**
 * A project-scoped key sends telemetry for its own project only. Without the
 * check, CI holding project A's key could stamp spans and metrics with project
 * B's deployment id, or write log lines under B's script name, and B's charts,
 * issues and log search would show them as B's.
 */

const KEY = "production:org_1|secret";

/** Key `dk_a` is scoped to project A; `dep_a` and alias `web-a` are A's, `dep_b` and `web-b` are B's. */
const store = async (projectId: null | string = "proj_a") => {
    const hashedKey = await hashDeployKey(KEY);

    return makeCtx({
        aliasOwnership: [
            { _id: "own_a", alias: "web-a", organizationId: "org_1", projectId: "proj_a" },
            { _id: "own_b", alias: "web-b", organizationId: "org_1", projectId: "proj_b" },
        ],
        alertRules: [],
        deployKeys: [{ _id: "dk_a", capability: "ingest", hashedKey, organizationId: "org_1", ...(projectId === null ? {} : { projectId }) }],
        deployments: [
            { _id: "dep_a", organizationId: "org_1", projectId: "proj_a" },
            { _id: "dep_b", organizationId: "org_1", projectId: "proj_b" },
        ],
    });
};

const point = { at: 1, kind: "sum", name: "requests", value: 1 };
const line = { level: "info", message: "hello" };

describe("telemetry ingest with a project-scoped key", () => {
    it("refuses metrics, spans and logs attributed to another project", async () => {
        expect.assertions(3);

        const { ctx } = await store();

        await expect(
            ingestMetrics.handler(ctx, { deployKey: KEY, deploymentId: "dep_b", organizationId: "org_1", points: [point] } as never),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(
            ingestTelemetry.handler(ctx, { deployKey: KEY, deploymentId: "dep_b", events: [], organizationId: "org_1" } as never),
        ).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        await expect(ingestLogs.handler(ctx, { deployKey: KEY, lines: [line], organizationId: "org_1", scriptName: "web-b" } as never)).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });

    it("accepts its own project's deployment and script", async () => {
        expect.assertions(2);

        const { ctx } = await store();

        await expect(
            ingestMetrics.handler(ctx, { deployKey: KEY, deploymentId: "dep_a", organizationId: "org_1", points: [point] } as never),
        ).resolves.toStrictEqual({ ingested: 1 });
        await expect(ingestLogs.handler(ctx, { deployKey: KEY, lines: [line], organizationId: "org_1", scriptName: "web-a" } as never)).resolves.toStrictEqual({
            ingested: 1,
        });
    });

    it("writes no group of a log batch when one group names another project's script", async () => {
        expect.assertions(2);

        const { ctx, ops } = await store();
        const groups = [
            { lines: [line], scriptName: "web-a" },
            { lines: [line], scriptName: "web-b" },
        ];

        await expect(ingestLogGroups.handler(ctx, { deployKey: KEY, groups, organizationId: "org_1" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(ops.filter((op) => op.kind === "insert" && op.table === "tenantLogs")).toStrictEqual([]);
    });

    it("refuses a log batch naming more than 20 scripts", async () => {
        expect.assertions(1);

        const { ctx } = await store();
        const groups = Array.from({ length: 21 }, (_unused, index) => {
            return { lines: [line], scriptName: `svc-${String(index)}` };
        });

        await expect(ingestLogGroups.handler(ctx, { deployKey: KEY, groups, organizationId: "org_1" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("lets an organization-wide key reach every project", async () => {
        expect.assertions(1);

        const { ctx } = await store(null);

        await expect(
            ingestMetrics.handler(ctx, { deployKey: KEY, deploymentId: "dep_b", organizationId: "org_1", points: [point] } as never),
        ).resolves.toStrictEqual({ ingested: 1 });
    });
});
