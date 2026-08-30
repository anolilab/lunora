import { describe, expect, it, vi } from "vitest";

import type { AnalyticsEngineDatasetLike } from "../src/metering/analytics";
import { createHttpAnalyticsReader, normalizeHostname, normalizeRoutePath, recordRequestUsage, statusClass } from "../src/metering/analytics";

describe(recordRequestUsage, () => {
    it("writes a per-request data point carrying the full traffic dimension set", () => {
        const writeDataPoint = vi.fn<AnalyticsEngineDatasetLike["writeDataPoint"]>();
        const dataset: AnalyticsEngineDatasetLike = { writeDataPoint };

        recordRequestUsage(dataset, {
            bytes: 2048,
            country: "BR",
            durationMs: 37,
            hostname: "app.acme.com",
            outcome: "5xx",
            plan: "pro",
            route: "/orders/:id",
            scriptName: "acme-app",
            status: 503,
        });

        expect(writeDataPoint).toHaveBeenCalledWith({
            blobs: ["acme-app", "pro", "5xx", "/orders/:id", "BR", "app.acme.com", "503"],
            doubles: [1, 37, 2048],
            indexes: ["acme-app"],
        });
    });

    /**
     * The regression this pins is a BILLING one, and it is silent.
     *
     * The usage rollup's SQL reads `blob1 AS scriptName` and the ledger derives
     * each org's charges from that column; `double1` is likewise the request
     * count the meter sums. So a widening that inserts a dimension anywhere
     * before them — rather than appending — keeps every type check and every
     * other test green while quietly re-attributing one tenant's traffic to
     * another's invoice. Nothing else in the repo would notice.
     */
    it("pins script, plan and count to the positions the billing rollup reads", () => {
        const writeDataPoint = vi.fn<AnalyticsEngineDatasetLike["writeDataPoint"]>();
        const dataset: AnalyticsEngineDatasetLike = { writeDataPoint };

        recordRequestUsage(dataset, { country: "DE", plan: "pro", scriptName: "acme-app", status: 200 });

        const point = writeDataPoint.mock.calls[0]?.[0];

        expect(point?.blobs?.[0]).toBe("acme-app");
        expect(point?.blobs?.[1]).toBe("pro");
        expect(point?.doubles?.[0]).toBe(1);
        expect(point?.indexes).toStrictEqual(["acme-app"]);
    });

    it("writes a well-formed point when a caller reports no optional dimension", () => {
        const writeDataPoint = vi.fn<AnalyticsEngineDatasetLike["writeDataPoint"]>();
        const dataset: AnalyticsEngineDatasetLike = { writeDataPoint };

        recordRequestUsage(dataset, { plan: "pro", scriptName: "acme-app" });

        expect(writeDataPoint).toHaveBeenCalledWith({
            blobs: ["acme-app", "pro", "unknown", "unknown", "unknown", "unknown", "unknown"],
            doubles: [1, 0, 0],
            indexes: ["acme-app"],
        });
    });

    it("no-ops without a dataset binding", () => {
        expect(() => {
            recordRequestUsage(undefined, { plan: "free", scriptName: "x" });
        }).not.toThrow();
    });
});

describe(normalizeRoutePath, () => {
    it("collapses identifier segments so a route names an endpoint, not a record", () => {
        expect(normalizeRoutePath("/orders/12345/items")).toBe("/orders/:id/items");
        expect(normalizeRoutePath("/users/3f9a8b7c6d5e4f3a2b1c0d9e")).toBe("/users/:id");
        expect(normalizeRoutePath("/users/0b7e5c9a-1f2d-4e3b-8a7c-6d5e4f3a2b1c")).toBe("/users/:id");
    });

    it("maps every record of one endpoint onto a single label", () => {
        // The property that makes the dimension groupable at all.
        expect(normalizeRoutePath("/orders/1")).toBe(normalizeRoutePath("/orders/999999"));
    });

    it("normalises the root and bounds pathological depth", () => {
        expect(normalizeRoutePath("/")).toBe("/");
        expect(normalizeRoutePath("")).toBe("/");
        expect(normalizeRoutePath("/a/b/c/d/e/f/g")).toBe("/a/b/c/d/…");
    });

    it("lower-cases so casing variants do not split a route", () => {
        expect(normalizeRoutePath("/API/Orders")).toBe("/api/orders");
    });
});

describe(statusClass, () => {
    it("reduces a status code to its class", () => {
        expect(statusClass(200)).toBe("2xx");
        expect(statusClass(404)).toBe("4xx");
        expect(statusClass(503)).toBe("5xx");
    });
});

describe(normalizeHostname, () => {
    it("lower-cases and strips the port so casing and ports do not split a domain", () => {
        expect(normalizeHostname("App.Acme.COM")).toBe("app.acme.com");
        expect(normalizeHostname("app.acme.com:8787")).toBe("app.acme.com");
    });

    /**
     * Unlike route and status class, hostname is not bounded by construction —
     * anything that resolves to the dispatcher lands here, scanner traffic
     * included. The cap is what stops a probe run minting unbounded dimension
     * values in the dataset.
     */
    it("caps length so probe traffic cannot mint an unbounded dimension", () => {
        expect(normalizeHostname(`${"a".repeat(500)}.com`)).toHaveLength(100);
    });
});

describe(createHttpAnalyticsReader, () => {
    it("maps the AE SQL response into usage rows", async () => {
        const fetchMock = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValue(Response.json({ data: [{ requests: "42", scriptName: "acme-app" }] }, { status: 200 }));
        const reader = createHttpAnalyticsReader({ accountId: "acc", apiToken: "tok", dataset: "usage", fetch: fetchMock });

        await expect(reader.readRequestUsage(0)).resolves.toStrictEqual([{ requests: 42, scriptName: "acme-app" }]);
    });

    /**
     * The regression this pins: Analytics Engine samples at high write rates,
     * and `SUM(double1)` counts retained rows rather than the requests they
     * stand in for. Since sampling engages exactly when a tenant's traffic
     * spikes, an unsampled sum under-counts hardest in the runaway case the
     * spend cap downstream exists to catch — so the query must aggregate the
     * sample interval over the per-tenant index.
     */
    it("aggregates the sample interval over the per-tenant index, not the raw double", async () => {
        const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ data: [] }, { status: 200 }));
        const reader = createHttpAnalyticsReader({ accountId: "acc", apiToken: "tok", dataset: "usage", fetch: fetchMock });

        await reader.readRequestUsage(1_700_000_000_000);

        const body = (fetchMock.mock.calls[0]?.[1] as undefined | { body?: string })?.body ?? "";

        expect(body).toContain("SUM(_sample_interval)");
        expect(body).toContain("index1 AS scriptName");
        expect(body).not.toContain("SUM(double1)");
    });

    it("throws on a non-ok response", async () => {
        const reader = createHttpAnalyticsReader({
            accountId: "acc",
            apiToken: "tok",
            dataset: "usage",
            fetch: async () => new Response("nope", { status: 500 }),
        });

        // @lunora/bindings' analytics SQL client throws AnalyticsSqlError on a non-2xx.
        await expect(reader.readRequestUsage(0)).rejects.toThrow(Error);
    });
});
