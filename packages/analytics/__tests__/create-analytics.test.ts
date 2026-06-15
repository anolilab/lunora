import { describe, expect, it } from "vitest";

import { createAnalytics } from "../src/create-analytics";
import type { AnalyticsEngineDataPoint, AnalyticsEngineDatasetLike } from "../src/types";

/** A plain-object stand-in for the AE binding that records every written data point. */
const fakeDataset = (): { binding: AnalyticsEngineDatasetLike; points: AnalyticsEngineDataPoint[] } => {
    const points: AnalyticsEngineDataPoint[] = [];

    return {
        binding: {
            writeDataPoint(event) {
                points.push(event);
            },
        },
        points,
    };
};

describe("createAnalytics", () => {
    it("forwards a raw data point to the binding unchanged", () => {
        expect.assertions(2);

        const { binding, points } = fakeDataset();
        const analytics = createAnalytics(binding);

        analytics.writeDataPoint({ blobs: ["a"], doubles: [1.5], indexes: ["k"] });

        expect(points).toHaveLength(1);
        expect(points[0]).toStrictEqual({ blobs: ["a"], doubles: [1.5], indexes: ["k"] });
    });

    it("rejects overflowing blobs/doubles/indexes (AE per-data-point caps)", () => {
        expect.assertions(3);

        const { binding } = fakeDataset();
        const analytics = createAnalytics(binding);

        expect(() => {
            analytics.writeDataPoint({ blobs: Array.from({length: 21}).fill("x") });
        }).toThrow(/at most 20 blobs/);
        expect(() => {
            analytics.writeDataPoint({ doubles: Array.from({length: 21}).fill(0) });
        }).toThrow(/at most 20 doubles/);
        expect(() => {
            analytics.writeDataPoint({ indexes: ["a", "b"] });
        }).toThrow(/at most 1 indexes/);
    });

    it("maps a named track() event to the positional layout (blob1 = name)", () => {
        expect.assertions(2);

        const { binding, points } = fakeDataset();
        const analytics = createAnalytics(binding);

        analytics.track("function_call", {
            dimensions: { fn: "messages:list", shard: "room-1" },
            index: "messages:list",
            metrics: { durationMs: 12.5, rows: 3 },
        });

        expect(points).toHaveLength(1);
        expect(points[0]).toStrictEqual({
            blobs: ["function_call", "messages:list", "room-1"],
            doubles: [12.5, 3],
            indexes: ["messages:list"],
        });
    });

    it("returns the field→column schema so the read side can name positional columns", () => {
        expect.assertions(1);

        const { binding } = fakeDataset();
        const analytics = createAnalytics(binding);

        const schema = analytics.track("function_call", {
            dimensions: { fn: "messages:list", shard: "room-1" },
            index: "messages:list",
            metrics: { durationMs: 12.5 },
        });

        expect(schema).toStrictEqual({
            dimensions: [
                { column: "blob2", field: "fn" },
                { column: "blob3", field: "shard" },
            ],
            index: { column: "index1", field: "index" },
            metrics: [{ column: "double1", field: "durationMs" }],
            name: "function_call",
        });
    });
});
