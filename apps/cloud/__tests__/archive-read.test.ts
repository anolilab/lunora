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
