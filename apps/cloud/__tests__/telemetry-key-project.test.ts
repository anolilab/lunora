import { describe, expect, it } from "vitest";

import { internal } from "../lunora/_generated/internal";
import { ingest as ingestLogs, ingestGroups as ingestLogGroups } from "../lunora/logs";
import { ingest as ingestMetrics } from "../lunora/metrics";
import { ingest as ingestTelemetry, servicesOutsideKeyProject } from "../lunora/telemetry";
import { hashDeployKey } from "../src/deploy/keys";
import { createDeployRouter } from "../src/deploy/router";
import { makeCtx } from "./_helpers/fake-ctx";
import readJson from "./_helpers/read-json";

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

/** One span of `service.name` `service`, the script an OTLP resource reports for. */
const span = (service: string, index: number) => {
    return {
        observation: {
            durationMs: 1,
            endedAt: 2,
            kind: "worker",
            level: "info",
            name: "send",
            serviceName: service,
            spanId: `s${String(index)}`,
            startedAt: 1,
            traceId: "t",
        },
        resource: {
            resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
            scopeSpans: [
                {
                    spans: [
                        {
                            endTimeUnixNano: "1700000000100000000",
                            name: "send",
                            spanId: `s${String(index)}`,
                            startTimeUnixNano: "1700000000000000000",
                            status: { code: 1 },
                            traceId: "t",
                        },
                    ],
                },
            ],
        },
    };
};

describe("spans and metrics of a project-scoped key", () => {
    it("refuses spans and metrics whose service is another project's script", async () => {
        expect.assertions(2);

        const { ctx } = await store();

        await expect(
            ingestTelemetry.handler(ctx, { deployKey: KEY, events: [], observations: [span("web-b", 1).observation], organizationId: "org_1" } as never),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(
            ingestMetrics.handler(ctx, { deployKey: KEY, organizationId: "org_1", points: [{ ...point, serviceName: "web-b" }] } as never),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("accepts its own script's and an unowned service's spans", async () => {
        expect.assertions(1);

        const { ctx } = await store();

        await expect(
            ingestTelemetry.handler(ctx, {
                deployKey: KEY,
                events: [],
                observations: [span("web-a", 1).observation, span("lunora", 2).observation],
                organizationId: "org_1",
            } as never),
        ).resolves.toMatchObject({ issues: 0 });
    });

    it("names the services an organization-wide key may send as none", async () => {
        const { ctx } = await store(null);

        await expect(
            servicesOutsideKeyProject.handler(ctx, { deployKey: KEY, organizationId: "org_1", serviceNames: ["web-b"] } as never),
        ).resolves.toStrictEqual([]);
    });

    /** Through `POST /v1/traces` and `/v1/metrics`: the sibling's resource is dropped and reported, its own kept. */
    it("drops a sibling project's resources from an OTLP batch as a partial success", async () => {
        const { ctx } = await store();
        const sent: { observations?: { serviceName?: string }[]; points?: { serviceName?: string }[] }[] = [];
        const lunoraContext = {
            runAction: () => Promise.resolve({}),
            runMutation: (_reference: unknown, args: (typeof sent)[number]) => {
                sent.push(args);

                return Promise.resolve({ alerts: [], incidents: 0, issues: 0 });
            },
            runQuery: (reference: unknown, args: Record<string, unknown>) =>
                reference === internal.telemetry.servicesOutsideKeyProject
                    ? servicesOutsideKeyProject.handler(ctx, args as never)
                    : Promise.resolve({ organizationId: "org_1" }),
        };
        const post = (path: string, body: unknown) =>
            createDeployRouter().fetch(
                new Request(`https://cloud.test${path}`, {
                    body: JSON.stringify(body),
                    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
                    method: "POST",
                }),
                { __lunoraCtx: lunoraContext },
            );
        const metric = (service: string) => {
            return {
                resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
                scopeMetrics: [{ metrics: [{ gauge: { dataPoints: [{ asDouble: 1, timeUnixNano: "1700000000000000000" }] }, name: "depth" }] }],
            };
        };

        const traces = await post("/v1/traces", { resourceSpans: [span("web-a", 1).resource, span("web-b", 2).resource] });
        const metrics = await post("/v1/metrics", { resourceMetrics: [metric("web-a"), metric("web-b")] });

        await expect(readJson(traces)).resolves.toMatchObject({ partialSuccess: { rejectedSpans: 1 } });
        await expect(readJson(metrics)).resolves.toMatchObject({ partialSuccess: { rejectedDataPoints: 1 } });
        expect(sent[0]?.observations?.map(({ serviceName }) => serviceName)).toStrictEqual(["web-a"]);
        expect(sent[1]?.points?.map(({ serviceName }) => serviceName)).toStrictEqual(["web-a"]);
    });
});
