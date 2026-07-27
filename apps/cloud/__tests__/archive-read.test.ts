import { describe, expect, it } from "vitest";

import { archiveRowToObservation } from "../src/telemetry/archive-read";
import { createCloudflareTelemetryStore, spanArchiveRecord } from "../src/telemetry/store";

describe(archiveRowToObservation, () => {
    it("round-trips a span through the archive record shape", () => {
        const observation = {
            durationMs: 100,
            endedAt: 1100,
            kind: "worker" as const,
            level: "info" as const,
            name: "messages:send",
            spanId: "s1",
            startedAt: 1000,
            traceId: "t1",
        };
        const row = spanArchiveRecord(observation, "org_1");

        expect(archiveRowToObservation(row)).toMatchObject(observation);
    });

    it("coerces numeric strings (Iceberg types) and drops absent generation fields", () => {
        const mapped = archiveRowToObservation({
            durationMs: "50",
            endedAt: "1050",
            kind: "generation",
            level: "info",
            model: "@cf/meta/llama",
            name: "chat",
            promptTokens: "12",
            spanId: "s2",
            startedAt: "1000",
            traceId: "t2",
        });

        expect(mapped).toMatchObject({ durationMs: 50, kind: "generation", model: "@cf/meta/llama", promptTokens: 12 });
        expect("completionTokens" in mapped).toBe(false);
    });
});

describe("TelemetryStore.readArchivedTrace", () => {
    it("no-ops to [] without R2-SQL config", async () => {
        await expect(createCloudflareTelemetryStore({}).readArchivedTrace({ organizationId: "org_1", traceId: "t1" })).resolves.toStrictEqual([]);
    });
});

describe("TelemetryStore.readArchivedSpansInWindow", () => {
    it("no-ops to [] without R2-SQL config", async () => {
        await expect(
            createCloudflareTelemetryStore({}).readArchivedSpansInWindow({ from: 0, limit: 50, organizationId: "org_1", to: 100 }),
        ).resolves.toStrictEqual([]);
    });

    it("maps archived rows in the window when R2 SQL is configured", async () => {
        const row = { durationMs: 5, endedAt: 105, kind: "worker", level: "info", name: "GET /", spanId: "s1", startedAt: 100, traceId: "t9" };
        // The R2-SQL client expects a 2xx `{ success, result: { rows } }` envelope.
        const fetchImpl = (() => Promise.resolve(Response.json({ result: { rows: [row] }, success: true }))) as unknown as typeof globalThis.fetch;

        const store = createCloudflareTelemetryStore({
            CLOUDFLARE_ACCOUNT_ID: "acc_1",
            R2_SQL_TOKEN: "tok",
            TELEMETRY_BUCKET_NAME: "bucket",
            fetch: fetchImpl,
        });

        const spans = await store.readArchivedSpansInWindow({ from: 0, limit: 50, organizationId: "org_1", to: 200 });

        expect(spans).toHaveLength(1);
        expect(spans[0]).toMatchObject({ spanId: "s1", startedAt: 100, traceId: "t9" });
    });

    it("fails open to [] when the R2-SQL read throws", async () => {
        const fetchImpl = (() => Promise.reject(new Error("network"))) as unknown as typeof globalThis.fetch;
        const store = createCloudflareTelemetryStore({
            CLOUDFLARE_ACCOUNT_ID: "acc_1",
            R2_SQL_TOKEN: "tok",
            TELEMETRY_BUCKET_NAME: "bucket",
            fetch: fetchImpl,
        });

        await expect(store.readArchivedSpansInWindow({ from: 0, limit: 50, organizationId: "org_1", to: 200 })).resolves.toStrictEqual([]);
    });
});
