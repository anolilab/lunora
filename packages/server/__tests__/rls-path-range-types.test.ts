import { describe, expect, it } from "vitest";

import { matchesWhere } from "../src/rls/where-match";

/**
 * A range over a path matches the leaves of the operand's own type, as the SQL stores do (`@lunora/shard-engine`'s
 * `ctx-db.range-types.test.ts` holds the SQL side): a write gated in memory must not allow what a read would hide.
 * JS would otherwise coerce `"30" > 5` to true.
 */
const matches = (leaf: unknown, where: Record<string, unknown>): boolean => matchesWhere({ profile: { mix: leaf } }, where);

describe("a range over a path in the rls evaluator", () => {
    it.each([
        ["a number leaf above a number", 50, { gt: 5 }, true],
        ["a text leaf of digits is no number", "50", { gt: 5 }, false],
        ["a text leaf above a string", "abc", { gt: "7" }, true],
        ["a number leaf is no string", 50, { gt: "7" }, false],
        ["a boolean leaf is no number", true, { gt: 0 }, false],
        ["an array leaf is no number", [1], { gt: 0 }, false],
    ])("%s", (_label, leaf, operators, expected) => {
        expect.assertions(1);
        expect(matches(leaf, { "profile.mix": operators })).toBe(expected);
    });

    it("leaves a plain column compared as before", () => {
        expect.assertions(1);
        expect(matchesWhere({ mix: "50" }, { mix: { gt: 5 } })).toBe(true);
    });
});
