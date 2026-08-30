import { describe, expect, it, vi } from "vitest";

import dispatcher from "../src/dispatcher/worker";
import type { AnalyticsEngineDatasetLike } from "../src/metering/analytics";

/**
 * A dispatch that never returns a response must still be metered.
 *
 * This was the metering stream's blind spot and the worst possible one. The meter
 * ran only after `userWorker.fetch(request)` RESOLVED, so every path where the
 * dispatch itself rejects — the tenant's own `fetch` throwing, a script missing
 * from the namespace, a plan limit exceeded — wrote no data point at all.
 *
 * A candidate release that throws on every request is the single most common way
 * a canary goes bad, and it produced no rows; one that throws intermittently
 * produced a sample containing only the requests it survived, which reads
 * HEALTHIER than the release it was replacing. Everything downstream inherited
 * that: the Traffic tab's error rate, per-deployment health, and the rollout
 * guard, whose entire job is to catch exactly this.
 */

type DispatchNamespaceGet = (
    name: string,
    args?: unknown,
    options?: { limits?: { cpuMs?: number; subRequests?: number }; outbound?: unknown },
) => { fetch: (request: Request) => Promise<Response> };

const makeEnv = (fetchImpl: (request: Request) => Promise<Response>, analytics: AnalyticsEngineDatasetLike): Record<string, unknown> => {
    return {
        DISPATCHER: { get: vi.fn<DispatchNamespaceGet>().mockReturnValue({ fetch: fetchImpl }) },
        LUNORA_APP_DOMAIN: "lunora.app",
        USAGE_ANALYTICS: analytics,
    };
};

const request = (): Request => new Request("https://acme-app.lunora.app/api/orders");

describe("dispatcher metering on a failed dispatch", () => {
    it("writes a 5xx data point when the tenant worker throws", async () => {
        const writeDataPoint = vi.fn<AnalyticsEngineDatasetLike["writeDataPoint"]>();
        const env = makeEnv(() => Promise.reject(new Error("tenant exploded")), { writeDataPoint });

        await expect(dispatcher.fetch(request(), env as never)).rejects.toThrow("tenant exploded");

        expect(writeDataPoint).toHaveBeenCalledTimes(1);

        const point = writeDataPoint.mock.calls[0]?.[0] as { blobs: string[]; indexes: string[] };

        // blob3 is the outcome class the rollout guard reads. Without this the
        // candidate simply had no rows, and "no rows" reads as "nothing wrong".
        expect(point.blobs[2]).toBe("5xx");
        expect(point.indexes[0]).toBe("acme-app");
    });

    it("writes a data point when the script is missing from the namespace", async () => {
        const writeDataPoint = vi.fn<AnalyticsEngineDatasetLike["writeDataPoint"]>();
        const env = makeEnv(() => Promise.reject(new Error("Worker not found: acme-app")), { writeDataPoint });

        const response = await dispatcher.fetch(request(), env as never);

        expect(response.status).toBe(404);
        expect(writeDataPoint).toHaveBeenCalledTimes(1);
        expect((writeDataPoint.mock.calls[0]?.[0] as { blobs: string[] }).blobs[2]).toBe("5xx");
    });

    it("still meters exactly once on the ordinary success path", async () => {
        const writeDataPoint = vi.fn<AnalyticsEngineDatasetLike["writeDataPoint"]>();
        const env = makeEnv(() => Promise.resolve(new Response("ok", { status: 200 })), { writeDataPoint });

        await dispatcher.fetch(request(), env as never);

        expect(writeDataPoint).toHaveBeenCalledTimes(1);
        expect((writeDataPoint.mock.calls[0]?.[0] as { blobs: string[] }).blobs[2]).toBe("2xx");
    });

    it("does not fail the request when metering itself throws", async () => {
        const env = makeEnv(() => Promise.resolve(new Response("ok")), {
            writeDataPoint: () => {
                throw new Error("analytics binding unavailable");
            },
        });

        await expect(dispatcher.fetch(request(), env as never)).resolves.toMatchObject({ status: 200 });
    });
});
