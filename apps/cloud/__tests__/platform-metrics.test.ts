import { LunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import { handlePlatformMetricsRoute } from "../src/deploy/routes/platform-metrics";
import { createDeployRouter } from "../src/deploy/router";
import type { RouterEnv } from "../src/deploy/routes/shared";
import dispatcher from "../src/dispatcher/worker";
import type { ControlPlaneDatabase } from "../src/store";
import type { AnalyticsEngineDatasetLike } from "../src/targets/cloudflare-wfp/analytics";
import { failureReason, readQueueDepth, recordDispatch, recordProvisionFailure, recordQueueDepth } from "../src/telemetry/platform-metrics";
import { buildPlatformMetricsQueries, foldPlatformMetrics } from "../src/telemetry/platform-metrics-read";

const dataset = (): AnalyticsEngineDatasetLike & { writeDataPoint: ReturnType<typeof vi.fn<AnalyticsEngineDatasetLike["writeDataPoint"]>> } => {
    return { writeDataPoint: vi.fn<AnalyticsEngineDatasetLike["writeDataPoint"]>() };
};

describe("platform metric data points", () => {
    /**
     * The layouts the read SQL depends on. A shifted position would silently
     * read latency as a queue depth; `index1` is the kind so AE samples each
     * kind on its own and a dispatch flood cannot sample away the queue rows.
     */
    it("pins every row kind's blob/double/index positions", () => {
        const sink = dataset();

        recordDispatch(sink, { cell: "eu-1", durationMs: 42, outcome: "2xx" });
        recordQueueDepth(sink, { buildsPending: 3, buildsRunning: 2, cell: "eu-1", deploysInFlight: 1 });
        recordProvisionFailure(sink, { cell: "eu-1", reason: "TimeoutError", step: "converge" });

        expect(sink.writeDataPoint.mock.calls.map(([point]) => point)).toStrictEqual([
            { blobs: ["dispatch", "eu-1", "2xx"], doubles: [42], indexes: ["dispatch"] },
            { blobs: ["queue", "eu-1"], doubles: [3, 2, 1], indexes: ["queue"] },
            { blobs: ["provision_failure", "eu-1", "converge", "TimeoutError"], doubles: [1], indexes: ["provision_failure"] },
        ]);
    });

    it("is a no-op without the binding and never throws when the binding does", () => {
        expect(() => {
            recordDispatch(undefined, { cell: "c", durationMs: 1, outcome: "2xx" });
        }).not.toThrow();
        expect(() => {
            recordQueueDepth(
                {
                    writeDataPoint: () => {
                        throw new Error("binding unavailable");
                    },
                },
                { buildsPending: 0, buildsRunning: 0, cell: "c", deploysInFlight: 0 },
            );
        }).not.toThrow();
    });
});

describe(failureReason, () => {
    it("keeps a catalogued Lunora code, an error class name, or unknown — never the message", () => {
        expect(failureReason(new LunoraError("NOT_FOUND", "acme.example.com is missing"))).toBe("NOT_FOUND");
        expect(failureReason(new TypeError("fetch failed for https://acme.example.com"))).toBe("TypeError");
        expect(failureReason(new Error("token sk_live_123 rejected"))).toBe("unknown");
        expect(failureReason("a string")).toBe("unknown");

        const odd = new Error("x");

        odd.name = "acme.example.com";

        expect(failureReason(odd)).toBe("unknown");
    });
});

describe(readQueueDepth, () => {
    it("counts pending/running builds and sums every in-flight deploy status", async () => {
        const sizes: Record<string, number> = {
            "builds:building": 1,
            "builds:pending": 4,
            "deployments:building": 0,
            "deployments:provisioning": 2,
            "deployments:queued": 1,
            "deployments:verifying": 3,
        };
        const findMany = vi.fn<ControlPlaneDatabase["findMany"]>(async (table, args) => {
            return { page: Array.from({ length: sizes[`${table}:${String(args?.where?.status)}`] ?? 99 }) };
        });

        await expect(readQueueDepth({ findMany })).resolves.toStrictEqual({ buildsPending: 4, buildsRunning: 1, deploysInFlight: 6 });
        expect(findMany).toHaveBeenCalledTimes(6);
    });
});

describe("dispatcher platform metrics", () => {
    const env = (fetchImpl: () => Promise<Response>, metrics?: AnalyticsEngineDatasetLike): Record<string, unknown> => {
        return {
            DISPATCHER: {
                get: () => {
                    return { fetch: fetchImpl };
                },
            },
            LUNORA_APP_DOMAIN: "lunora.app",
            LUNORA_CELL: "eu-1",
            ...(metrics ? { PLATFORM_METRICS: metrics } : {}),
        };
    };
    const request = (): Request => new Request("https://acme-app.lunora.app/api/orders");

    it("records latency and status class per cell, with no tenant dimension", async () => {
        const sink = dataset();

        await dispatcher.fetch(request(), env(async () => new Response("ok", { status: 201 }), sink) as never);

        const point = sink.writeDataPoint.mock.calls[0]?.[0];

        expect(point).toMatchObject({ blobs: ["dispatch", "eu-1", "2xx"], indexes: ["dispatch"] });
        expect(JSON.stringify(point)).not.toContain("acme");
    });

    it("records a thrown dispatch as `exception` and still rethrows", async () => {
        const sink = dataset();

        await expect(
            dispatcher.fetch(
                request(),
                env(async () => {
                    throw new Error("boom");
                }, sink) as never,
            ),
        ).rejects.toThrow("boom");
        expect(sink.writeDataPoint.mock.calls[0]?.[0]).toMatchObject({ blobs: ["dispatch", "eu-1", "exception"] });
    });

    it("serves exactly as before without the binding", async () => {
        const response = await dispatcher.fetch(request(), env(async () => new Response("ok")) as never);

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe("ok");
    });
});

describe(buildPlatformMetricsQueries, () => {
    const DATASET = "lunora_platform_metrics";
    const queries = buildPlatformMetricsQueries(DATASET, 1_700_000_000, 1_700_086_400);

    it("pins the read SQL", () => {
        const where = `FROM events.analyticsEngine."${DATASET}" WHERE index1 = $kind AND timestamp > $since AND timestamp <= $to`;

        expect(queries.dispatchLatency.query).toBe(
            `SELECT blob2 AS cell, COUNT(*) AS requests, quantileWeighted(0.50, double1, sampleInterval) AS p50, quantileWeighted(0.95, double1, sampleInterval) AS p95 ${where} GROUP BY cell ORDER BY cell`,
        );
        expect(queries.dispatchOutcomes.query).toBe(
            `SELECT blob2 AS cell, blob3 AS outcome, COUNT(*) AS requests ${where} GROUP BY cell, outcome ORDER BY cell, outcome`,
        );
        expect(queries.provisionFailures.query).toBe(
            `SELECT blob2 AS cell, blob3 AS step, blob4 AS reason, COUNT(*) AS failures ${where} GROUP BY cell, step, reason ORDER BY failures DESC LIMIT 50`,
        );
        expect(queries.queueDepth.query).toBe(
            `SELECT toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '900' SECOND)) AS bucket, blob2 AS cell, MAX(double1) AS buildsPending, MAX(double2) AS buildsRunning, MAX(double3) AS deploysInFlight ${where} GROUP BY bucket, cell ORDER BY bucket`,
        );
    });

    it("binds the kind and the window rather than splicing them", () => {
        expect(queries.dispatchLatency.params).toStrictEqual({ kind: "dispatch", since: "2023-11-14T22:13:20Z", to: "2023-11-15T22:13:20Z" });
        expect(queries.queueDepth.params.kind).toBe("queue");
        expect(queries.provisionFailures.params.kind).toBe("provision_failure");
    });
});

describe(foldPlatformMetrics, () => {
    it("nests outcomes under their cell and coerces numeric strings", () => {
        expect(
            foldPlatformMetrics({
                dispatchLatency: [{ cell: "eu-1", p50: "12", p95: 80.5, requests: "1000" }],
                dispatchOutcomes: [
                    { cell: "eu-1", outcome: "2xx", requests: "990" },
                    { cell: "eu-1", outcome: "5xx", requests: 10 },
                ],
                provisionFailures: [{ cell: "eu-1", failures: "2", reason: "health_check", step: "verify" }],
                queueDepth: [{ bucket: "1700000000", buildsPending: 3, buildsRunning: 1, cell: "eu-1", deploysInFlight: 0 }],
            }),
        ).toStrictEqual({
            dispatch: [{ cell: "eu-1", outcomes: { "2xx": 990, "5xx": 10 }, p50Ms: 12, p95Ms: 80.5, requests: 1000 }],
            provisionFailures: [{ cell: "eu-1", failures: 2, reason: "health_check", step: "verify" }],
            queue: [{ buildsPending: 3, buildsRunning: 1, cell: "eu-1", deploysInFlight: 0, t: 1_700_000_000_000 }],
        });
    });
});

describe(handlePlatformMetricsRoute, () => {
    const get = (token?: string): Request =>
        new Request("https://cp.example/v1/platform/metrics?hours=2", token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });

    it("refuses anyone without the admin token", async () => {
        const environment: RouterEnv = { LUNORA_ADMIN_TOKEN: "admin" };

        // The router's admin table gates it; the handler itself trusts its caller.
        const router = createDeployRouter();

        await expect(router.fetch(get(), environment)).resolves.toHaveProperty("status", 401);
        await expect(router.fetch(get("nope"), environment)).resolves.toHaveProperty("status", 401);
    });

    it("answers 501 when the cell has no Analytics Engine read credentials", async () => {
        const response = await handlePlatformMetricsRoute(get("admin"), { LUNORA_ADMIN_TOKEN: "admin" });

        expect(response.status).toBe(501);
    });

    it("reads the configured dataset over the window and returns the snapshot", async () => {
        const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ data: [] }));

        vi.stubGlobal("fetch", fetchMock);

        try {
            const response = await handlePlatformMetricsRoute(get("admin"), {
                CLOUDFLARE_ACCOUNT_ID: "acc",
                CLOUDFLARE_API_TOKEN: "tok",
                LUNORA_ADMIN_TOKEN: "admin",
                PLATFORM_METRICS_DATASET: "lunora_platform_metrics_staging",
            });
            const body: { dispatch: unknown[]; from: number; to: number } = await response.json();

            expect(response.status).toBe(200);
            expect(body.to - body.from).toBe(2 * 60 * 60 * 1000);
            expect(body.dispatch).toStrictEqual([]);
            expect(fetchMock).toHaveBeenCalledTimes(4);

            const sent = JSON.parse((fetchMock.mock.calls[0]?.[1] as undefined | { body?: string })?.body ?? "{}") as { query: string };

            expect(sent.query).toContain('"lunora_platform_metrics_staging"');
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
