/**
 * A dedup key is spent verbatim as a workflow instance id and a mutation id header, so the check
 * has to hold for the whole string: the engine's grammar from the first character to the last, and
 * its 100-character ceiling.
 */
import { describe, expect, it } from "vitest";

import assertDedupKey from "../src/validate-dedup-key";

describe("assertDedupKey", () => {
    it("passes an absent key and one at the 100-character ceiling", () => {
        expect.assertions(2);

        expect(assertDedupKey(undefined)).toBeUndefined();
        expect(assertDedupKey(`a${"-".repeat(99)}`)).toBe(`a${"-".repeat(99)}`);
    });

    it.each([
        ["a trailing newline", "job-1\n"],
        ["a newline after 100 permitted characters", `${"a".repeat(100)}\n`],
        ["101 characters", "a".repeat(101)],
        ["a leading dash", "-job-1"],
        ["an empty string", ""],
    ])("refuses %s", (_label, key) => {
        expect.assertions(1);

        expect(() => assertDedupKey(key)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    });
});
