import { describe, expect, it } from "vitest";

import { assertPresenceInterval } from "../../../shared/presence-interval";

describe(assertPresenceInterval, () => {
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s with the adapters' shared message", (intervalMs) => {
        expect.assertions(1);

        expect(() => {
            assertPresenceInterval(intervalMs);
        }).toThrow(new RangeError(`presence intervalMs must be a positive number, got ${String(intervalMs)}`));
    });

    it("accepts a positive finite interval", () => {
        expect.assertions(1);

        expect(() => {
            assertPresenceInterval(0.5);
        }).not.toThrow();
    });
});
