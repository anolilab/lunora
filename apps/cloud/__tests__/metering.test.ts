import { describe, expect, it, vi } from "vitest";

import type { AnalyticsEngineDataset } from "../src/metering/analytics";
import { createHttpAnalyticsReader, recordRequestUsage } from "../src/metering/analytics";

describe(recordRequestUsage, () => {
    it("writes a per-request data point", () => {
        const writeDataPoint = vi.fn();
        const dataset: AnalyticsEngineDataset = { writeDataPoint };

        recordRequestUsage(dataset, { plan: "pro", scriptName: "acme-app" });

        expect(writeDataPoint).toHaveBeenCalledWith({ blobs: ["acme-app", "pro"], doubles: [1], indexes: ["acme-app"] });
    });

    it("no-ops without a dataset binding", () => {
        expect(() => {
            recordRequestUsage(undefined, { plan: "free", scriptName: "x" });
        }).not.toThrow();
    });
});

describe(createHttpAnalyticsReader, () => {
    it("maps the AE SQL response into usage rows", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [{ requests: "42", scriptName: "acme-app" }] }, { status: 200 }));
        const reader = createHttpAnalyticsReader({ accountId: "acc", apiToken: "tok", dataset: "usage", fetch: fetchMock });

        await expect(reader.readRequestUsage(0)).resolves.toStrictEqual([{ requests: 42, scriptName: "acme-app" }]);
    });

    it("throws on a non-ok response", async () => {
        const reader = createHttpAnalyticsReader({
            accountId: "acc",
            apiToken: "tok",
            dataset: "usage",
            fetch: async () => new Response("nope", { status: 500 }),
        });

        await expect(reader.readRequestUsage(0)).rejects.toThrow(/analytics read failed/u);
    });
});
