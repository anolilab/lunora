import { describe, expect, it } from "vitest";

import { constantTimeEqual } from "../../../shared/constant-time-equal";

describe("constantTimeEqual", () => {
    it("returns true only for identical strings", () => {
        expect.assertions(2);

        expect(constantTimeEqual("deadbeef", "deadbeef")).toBe(true);
        expect(constantTimeEqual("deadbeef", "deadbeff")).toBe(false);
    });

    it("returns false for unequal-length inputs (length is folded in, not short-circuited)", () => {
        expect.assertions(3);

        // Regression: the relay-hub copy returned early on a length mismatch,
        // diverging from the DO copies. The consolidated helper folds the
        // length delta into the accumulator so a shorter candidate that is a
        // prefix of the expected value still compares unequal.
        expect(constantTimeEqual("deadbeef", "dead")).toBe(false);
        expect(constantTimeEqual("dead", "deadbeef")).toBe(false);
        expect(constantTimeEqual("", "x")).toBe(false);
    });

    it("treats two empty strings as equal", () => {
        expect.assertions(1);

        expect(constantTimeEqual("", "")).toBe(true);
    });
});
