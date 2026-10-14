import { describe, expect, it } from "vitest";

import { AGGREGATE_SQL_FUNCTION, aggregateSqlFunction, matchesStaticWhere, normalizeCountArgument } from "../src/aggregate-sql";

describe("aggregateSqlFunction", () => {
    it("maps every allowlisted op to its uppercase SQL function", () => {
        expect.assertions(5);

        expect(aggregateSqlFunction("avg")).toBe("AVG");
        expect(aggregateSqlFunction("count")).toBe("COUNT");
        expect(aggregateSqlFunction("max")).toBe("MAX");
        expect(aggregateSqlFunction("min")).toBe("MIN");
        expect(aggregateSqlFunction("sum")).toBe("SUM");
    });

    it("every key in AGGREGATE_SQL_FUNCTION round-trips through aggregateSqlFunction", () => {
        // AGGREGATE_SQL_FUNCTION has exactly 5 entries: avg, count, max, min, sum.
        expect.assertions(5);

        for (const [op, expected] of Object.entries(AGGREGATE_SQL_FUNCTION)) {
            expect(aggregateSqlFunction(op)).toBe(expected);
        }
    });

    it("throws for an off-allowlist op, naming the allowed ops in the message (injection guard)", () => {
        expect.assertions(2);

        expect(() => aggregateSqlFunction("drop table users")).toThrow(/unknown aggregate op/);
        expect(() => aggregateSqlFunction("drop table users")).toThrow(/avg, count, max, min, sum/);
    });

    it("throws for an empty string op", () => {
        expect.assertions(1);

        expect(() => aggregateSqlFunction("")).toThrow(/unknown aggregate op/);
    });
});

describe("matchesStaticWhere", () => {
    it("returns true when the row satisfies all predicates with literal equality", () => {
        expect.assertions(1);

        expect(matchesStaticWhere({ age: 30, name: "alice" }, { name: "alice" })).toBe(true);
    });

    it("returns false when a literal equality predicate does not match", () => {
        expect.assertions(1);

        expect(matchesStaticWhere({ name: "bob" }, { name: "alice" })).toBe(false);
    });

    it("returns true when the row satisfies an { eq } operator predicate", () => {
        expect.assertions(1);

        expect(matchesStaticWhere({ status: "active" }, { status: { eq: "active" } })).toBe(true);
    });

    it("returns false when the { eq } operator predicate does not match", () => {
        expect.assertions(1);

        expect(matchesStaticWhere({ status: "inactive" }, { status: { eq: "active" } })).toBe(false);
    });

    it("returns false for an unsupported operator (not 'eq')", () => {
        expect.assertions(1);

        expect(matchesStaticWhere({ count: 5 }, { count: { gt: 3 } })).toBe(false);
    });

    it("returns true when the predicate is empty (no conditions)", () => {
        expect.assertions(1);

        expect(matchesStaticWhere({ x: 1 }, {})).toBe(true);
    });

    it("returns false when a required field is missing from the document", () => {
        expect.assertions(1);

        expect(matchesStaticWhere({}, { name: "alice" })).toBe(false);
    });
});

describe("normalizeCountArgument", () => {
    it("returns {} for undefined", () => {
        expect.assertions(1);

        expect(normalizeCountArgument(undefined)).toEqual({});
    });

    it("returns {} for an empty object", () => {
        expect.assertions(1);

        expect(normalizeCountArgument({})).toEqual({});
    });

    it("wraps a non-object (string) as a where literal", () => {
        expect.assertions(1);

        // Cast needed because the type union doesn't include primitives directly;
        // this exercises the runtime path for callers passing legacy positional args.
        expect(normalizeCountArgument("some-value" as never)).toEqual({ where: "some-value" });
    });

    it("returns a RestrictableQueryOptions as-is when all keys are marker keys", () => {
        expect.assertions(1);

        const opts = { baseWhere: { status: "active" }, where: { type: "doc" } };

        expect(normalizeCountArgument(opts)).toBe(opts);
    });

    it("wraps an object with non-marker keys as a where literal", () => {
        expect.assertions(1);

        const whereTree = { name: "alice" };

        expect(normalizeCountArgument(whereTree)).toEqual({ where: whereTree });
    });

    it("wraps an array as a where literal (arrays are not treated as options)", () => {
        expect.assertions(1);

        const arr = [1, 2, 3];

        expect(normalizeCountArgument(arr as never)).toEqual({ where: arr });
    });
});
