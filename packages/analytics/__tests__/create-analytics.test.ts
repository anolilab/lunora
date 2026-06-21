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

        const fillString = (): string => "x";
        const twentyOneBlobs: string[] = Array.from<string, string>({ length: 21 }, fillString);

        expect(() => {
            analytics.writeDataPoint({ blobs: twentyOneBlobs });
        }).toThrow(/at most 20 blobs/);

        const fillZero = (): number => 0;
        const twentyOneDoubles: number[] = Array.from<number, number>({ length: 21 }, fillZero);

        expect(() => {
            analytics.writeDataPoint({ doubles: twentyOneDoubles });
        }).toThrow(/at most 20 doubles/);
        expect(() => {
            analytics.writeDataPoint({ indexes: ["a", "b"] });
        }).toThrow(/at most 1 indexes/);
    });

    it("rejects blobs whose combined UTF-8 bytes exceed AE's 16 KiB budget", () => {
        expect.assertions(3);

        const { binding, points } = fakeDataset();
        const analytics = createAnalytics(binding);

        // Two blobs of 8 KiB each = 16 KiB total = exactly the limit (allowed).
        const eightKiB = "a".repeat(8 * 1024);

        expect(() => {
            analytics.writeDataPoint({ blobs: [eightKiB, eightKiB] });
        }).not.toThrow();

        // One more byte tips it over the 16384-byte budget.
        expect(() => {
            analytics.writeDataPoint({ blobs: [eightKiB, eightKiB, "x"] });
        }).toThrow(/blobs may total at most 16384 bytes/);

        // The under-budget point wrote; the over-budget one did not.
        expect(points).toHaveLength(1);
    });

    it("rejects an index whose UTF-8 byte length exceeds 96 bytes", () => {
        expect.assertions(2);

        const { binding } = fakeDataset();
        const analytics = createAnalytics(binding);

        expect(() => {
            analytics.writeDataPoint({ indexes: ["a".repeat(96)] });
        }).not.toThrow();

        expect(() => {
            analytics.writeDataPoint({ indexes: ["a".repeat(97)] });
        }).toThrow(/index may total at most 96 bytes/);
    });

    it("measures multibyte (non-ASCII) payloads by UTF-8 byte length, not char length", () => {
        expect.assertions(2);

        const { binding } = fakeDataset();
        const analytics = createAnalytics(binding);

        // "💡" is 1 string char but 4 UTF-8 bytes; 25 of them = 100 bytes > 96.
        const emoji = "💡".repeat(25);

        expect(emoji).toHaveLength(50); // surrogate pairs: 2 UTF-16 code units each

        expect(() => {
            analytics.writeDataPoint({ indexes: [emoji] });
        }).toThrow(/index may total at most 96 bytes \(got 100\)/);
    });

    it("counts ArrayBuffer blobs by byteLength toward the budget", () => {
        expect.assertions(1);

        const { binding } = fakeDataset();
        const analytics = createAnalytics(binding);

        const oversized = new ArrayBuffer(16 * 1024 + 1);

        expect(() => {
            analytics.writeDataPoint({ blobs: [oversized] });
        }).toThrow(/blobs may total at most 16384 bytes/);
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

    it("writes only the event name (blob1) and a null index for an event-less track()", () => {
        expect.assertions(2);

        const { binding, points } = fakeDataset();
        const analytics = createAnalytics(binding);

        const schema = analytics.track("ping");

        expect(points[0]).toStrictEqual({ blobs: ["ping"], doubles: [], indexes: [] });
        expect(schema).toStrictEqual({ dimensions: [], index: null, metrics: [], name: "ping" });
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
