import { describe, expect, it } from "vitest";

import { readEpochMs, secondsToMs } from "../src/json";

describe("readEpochMs", () => {
    it("reads a Date, an epoch-ms number, or an ISO string from the first key that parses", () => {
        expect.assertions(5);

        const iso = "2026-01-02T03:04:05Z";
        const ms = Date.parse(iso);

        expect(readEpochMs({ at: new Date(iso) }, "at")).toBe(ms);
        expect(readEpochMs({ at: ms }, "at")).toBe(ms);
        expect(readEpochMs({ at: iso }, "at")).toBe(ms);
        // An unparseable or null earlier key falls through to the next one.
        expect(readEpochMs({ a: "not a date", b: null, c: iso }, "a", "b", "c")).toBe(ms);
        expect(readEpochMs({ at: new Date(Number.NaN) }, "at")).toBeUndefined();
    });
});

describe("secondsToMs", () => {
    it("scales Unix seconds and passes undefined through", () => {
        expect.assertions(2);

        expect(secondsToMs(1_700_000_000)).toBe(1_700_000_000_000);
        expect(secondsToMs(undefined)).toBeUndefined();
    });
});
