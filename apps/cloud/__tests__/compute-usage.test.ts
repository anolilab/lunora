/* eslint-disable no-secrets/no-secrets -- GraphQL dataset and operation names read as entropy; none is a credential */
import { afterEach, describe, expect, it } from "vitest";

import {
    DURABLE_OBJECTS_DURATION,
    readDurableObjectDurationByScript,
    readDurableObjectRequestsByScript,
    readWorkersCpuByScript,
    WORKERS_CPU,
} from "../src/cloudflare/compute-usage";
import { probeDataset, probeDurableObjectsDataset, resetDurableObjectsProbe } from "../src/cloudflare/storage-usage";
import { UsageUnavailableError } from "../src/metering/unavailable";
import { access, fakeCloudflare, fakeGraphql, HOURLY_FILTER, namespace, NAMESPACES, WINDOW } from "./support/cloudflare-api-fake";

/** The CPU dataset as a cell account describes it: µs by name, and a dispatch-namespace dimension. */
const CPU_DATASET = {
    workersInvocationsAdaptive: {
        dimensions: ["scriptName", "dispatchNamespaceName", "datetimeHour"],
        filter: HOURLY_FILTER,
        sum: ["requests", "cpuTimeUs", "wallTime"],
    },
};

describe(readWorkersCpuByScript, () => {
    afterEach(() => {
        resetDurableObjectsProbe();
    });

    it("reads CPU time in µs by its name, converts to ms, and keeps only this environment's dispatch namespace", async () => {
        const seen: string[] = [];
        const fetch = fakeCloudflare({
            graphql: fakeGraphql(
                CPU_DATASET,
                [
                    { dimensions: { dispatchNamespaceName: "lunora-production", scriptName: "shop" }, sum: { cpuTimeUs: 2_500_000 } },
                    { dimensions: { dispatchNamespaceName: "lunora-production", scriptName: "shop" }, sum: { cpuTimeUs: 500_000 } },
                    // Staging's `shop` in the same account, and the platform's own dispatcher outside any namespace.
                    { dimensions: { dispatchNamespaceName: "lunora-staging", scriptName: "shop" }, sum: { cpuTimeUs: 9_000_000 } },
                    { dimensions: { dispatchNamespaceName: "", scriptName: "lunora-dispatcher" }, sum: { cpuTimeUs: 7_000_000 } },
                    { dimensions: { dispatchNamespaceName: "lunora-production", scriptName: "api" }, sum: { cpuTimeUs: Number.NaN } },
                ],
                seen,
            ),
        });

        const usage = await readWorkersCpuByScript(access(fetch), WINDOW, { dispatchNamespace: "lunora-production" });

        expect(usage).toStrictEqual(new Map([["shop", { cpuMs: 3000 }]]));

        const data = seen.find((query) => query.includes("LunoraWorkerCpu")) ?? "";

        expect(data).toContain("rows: workersInvocationsAdaptive(");
        expect(data).toContain("sum { cpuTimeUs }");
        expect(data).toContain("dimensions { scriptName dispatchNamespaceName }");
        // The closed hours 09:00 and 10:00: `datetimeHour_leq` names the last one.
        expect(data).toContain('datetimeHour_geq: "2026-06-15T09:00:00.000Z", datetimeHour_leq: "2026-06-15T10:00:00.000Z"');
    });

    it("is unavailable on the cell when the dataset cannot say which dispatch namespace a row is from", async () => {
        const fetch = fakeCloudflare({
            graphql: fakeGraphql({ workersInvocationsAdaptive: { dimensions: ["scriptName"], filter: HOURLY_FILTER, sum: ["cpuTimeUs"] } }),
        });

        const failure = await readWorkersCpuByScript(access(fetch), WINDOW, { dispatchNamespace: "lunora-production" }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(UsageUnavailableError);
        expect(String(failure)).toContain("has no dispatch-namespace dimension");
    });

    it("on a connected account, counts plain Workers and drops any dispatch namespace's", async () => {
        const fetch = fakeCloudflare({
            graphql: fakeGraphql(CPU_DATASET, [
                { dimensions: { dispatchNamespaceName: "", scriptName: "web" }, sum: { cpuTimeUs: 1000 } },
                { dimensions: { scriptName: "web" }, sum: { cpuTimeUs: 1000 } },
                { dimensions: { dispatchNamespaceName: "their-platform", scriptName: "web" }, sum: { cpuTimeUs: 50_000 } },
            ]),
        });

        await expect(readWorkersCpuByScript(access(fetch), WINDOW)).resolves.toStrictEqual(new Map([["web", { cpuMs: 2 }]]));
    });

    it("never reads a CPU sum in an unstated unit: a bare cpuTime is unavailable, and says why", async () => {
        const fetch = fakeCloudflare({
            graphql: fakeGraphql({ workersInvocationsAdaptive: { dimensions: ["scriptName"], filter: HOURLY_FILTER, sum: ["requests", "cpuTime"] } }),
        });

        const failure = await readWorkersCpuByScript(access(fetch), WINDOW).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(UsageUnavailableError);
        expect(String(failure)).toContain("cpuTime does not state its unit (no description)");
    });

    it("takes a cpuTime the schema describes in microseconds", async () => {
        const fetch = fakeCloudflare({
            graphql: fakeGraphql(
                {
                    workersInvocationsAdaptive: {
                        dimensions: ["scriptName"],
                        filter: ["datetime_geq", "datetime_leq"],
                        sum: [{ description: "Sum of CPU time, in microseconds", name: "cpuTime" }],
                    },
                },
                [{ dimensions: { scriptName: "web" }, sum: { cpuTime: 4000 } }],
            ),
        });

        await expect(readWorkersCpuByScript(access(fetch), WINDOW)).resolves.toStrictEqual(new Map([["web", { cpuMs: 4 }]]));
        await expect(probeDataset(access(fetch), WORKERS_CPU)).resolves.toStrictEqual({
            by: "scriptName",
            field: "workersInvocationsAdaptive",
            filter: "instant",
            sums: ["cpuTime"],
        });
    });

    it("keeps its own probe answer: the rows probe of the same account is not overwritten", async () => {
        const fetch = fakeCloudflare({
            graphql: fakeGraphql({
                ...CPU_DATASET,
                durableObjectsPeriodicGroups: { dimensions: ["scriptName"], filter: HOURLY_FILTER, sum: ["rowsRead"] },
            }),
        });

        await expect(probeDurableObjectsDataset(access(fetch))).resolves.toMatchObject({ field: "durableObjectsPeriodicGroups" });
        await expect(probeDataset(access(fetch), WORKERS_CPU)).resolves.toMatchObject({
            field: "workersInvocationsAdaptive",
            namespace: "dispatchNamespaceName",
        });

        const calls = fetch.mock.calls.length;

        await expect(probeDurableObjectsDataset(access(fetch))).resolves.toMatchObject({ field: "durableObjectsPeriodicGroups", sums: ["rowsRead"] });
        await expect(probeDataset(access(fetch), WORKERS_CPU)).resolves.toMatchObject({ sums: ["cpuTimeUs"] });
        expect(fetch).toHaveBeenCalledTimes(calls);
    });
});

/** Durable Objects datasets as a cell account might describe them: requests in one, rows and duration in another. */
const DO_DATASETS = {
    durableObjectsInvocationsAdaptiveGroups: { dimensions: ["namespaceId", "datetimeHour"], filter: HOURLY_FILTER, sum: ["requests", "wallTime"] },
    durableObjectsPeriodicGroups: {
        dimensions: ["namespaceId"],
        filter: HOURLY_FILTER,
        sum: ["rowsRead", "rowsWritten", { description: "Sum of duration (GB*s)", name: "duration" }, "activeTime"],
    },
};

const DO_NAMESPACES = {
    [NAMESPACES]: () => {
        return {
            result: [
                namespace("ns_shop", "shop", "lunora-production"),
                namespace("ns_staging", "shop", "lunora-staging"),
                namespace("ns_platform", "lunora-cloud"),
            ],
        };
    },
};

describe(readDurableObjectRequestsByScript, () => {
    afterEach(() => {
        resetDurableObjectsProbe();
    });

    it("reads requests from the dataset that has them, placed through the namespace list", async () => {
        const seen: string[] = [];
        const fetch = fakeCloudflare({
            graphql: fakeGraphql(
                DO_DATASETS,
                [
                    { dimensions: { namespaceId: "ns_shop" }, sum: { requests: 1200 } },
                    { dimensions: { namespaceId: "ns_staging" }, sum: { requests: 99 } },
                    { dimensions: { namespaceId: "ns_platform" }, sum: { requests: 5 } },
                    { dimensions: { namespaceId: "ns_gone" }, sum: { requests: 7 } },
                ],
                seen,
            ),
            rest: DO_NAMESPACES,
        });

        const usage = await readDurableObjectRequestsByScript(access(fetch), WINDOW, { dispatchNamespace: "lunora-production" });

        // Another environment's and the platform's own are dropped; an unknown namespace is kept unattributed, never billed.
        expect(usage).toStrictEqual(
            new Map([
                ["shop", { doRequests: 1200 }],
                ["unattributed:namespace:ns_gone", { doRequests: 7 }],
            ]),
        );
        expect(seen.find((query) => query.includes("LunoraDurableObjectRequests"))).toContain("rows: durableObjectsInvocationsAdaptiveGroups(");
    });

    it("is unavailable, naming what the schema has, when no dataset reports Durable Object requests", async () => {
        const fetch = fakeCloudflare({
            graphql: fakeGraphql({ durableObjectsPeriodicGroups: { dimensions: ["namespaceId"], filter: HOURLY_FILTER, sum: ["rowsRead"] } }),
            rest: DO_NAMESPACES,
        });

        const failure = await readDurableObjectRequestsByScript(access(fetch), WINDOW).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(UsageUnavailableError);
        expect(String(failure)).toContain("no Durable Objects dataset reports requests with a scriptName or namespaceId dimension");
        expect(String(failure)).toContain("durableObjectsPeriodicGroups (sum: rowsRead; dimensions: namespaceId)");
    });
});

describe(readDurableObjectDurationByScript, () => {
    afterEach(() => {
        resetDurableObjectsProbe();
    });

    it("reads duration only where the schema says it is GB-seconds, the unit the rate card prices", async () => {
        const fetch = fakeCloudflare({
            graphql: fakeGraphql(DO_DATASETS, [
                { dimensions: { namespaceId: "ns_shop" }, sum: { duration: 412.5 } },
                { dimensions: { namespaceId: "ns_staging" }, sum: { duration: 1e6 } },
            ]),
            rest: DO_NAMESPACES,
        });

        await expect(readDurableObjectDurationByScript(access(fetch), WINDOW, { dispatchNamespace: "lunora-production" })).resolves.toStrictEqual(
            new Map([["shop", { doDurationGbS: 412.5 }]]),
        );
        await expect(probeDataset(access(fetch), DURABLE_OBJECTS_DURATION)).resolves.toMatchObject({
            field: "durableObjectsPeriodicGroups",
            sums: ["duration"],
        });
    });

    it("never converts active time at an assumed memory size, nor reads a duration of unstated unit", async () => {
        const fetch = fakeCloudflare({
            graphql: fakeGraphql({
                durableObjectsPeriodicGroups: {
                    dimensions: ["namespaceId"],
                    filter: HOURLY_FILTER,
                    sum: ["rowsRead", "activeTime", { description: "Sum of duration", name: "duration" }],
                },
            }),
            rest: DO_NAMESPACES,
        });

        const failure = await readDurableObjectDurationByScript(access(fetch), WINDOW).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(UsageUnavailableError);
        expect(String(failure)).toContain('duration does not state its unit ("Sum of duration")');
    });
});
