import { v,ValidationError } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { parseValidatorMap } from "../src/functions";
import { clampLimit, defineListArgs } from "../src/list-args";

const spec = defineListArgs({
    filter: { authorId: v.string(), score: v.number(), status: v.string() },
    orderBy: ["_creationTime", "score"],
});

/** Parse a raw argument object through the declared validator map, exactly as a procedure's `.input()` does. */
const parse = (raw: Record<string, unknown>): Record<string, unknown> => parseValidatorMap(spec.args as never, raw, "args");

describe("defineListArgs — argument shape", () => {
    it("accepts a bare value as an equality predicate", () => {
        expect.assertions(1);

        expect(parse({ where: { status: "open" } }).where).toEqual({ status: "open" });
    });

    it("accepts the operator object mirroring the ctx.db where DSL", () => {
        expect.assertions(1);

        const parsed = parse({ where: { score: { gte: 10, lt: 100 }, status: { in: ["open", "closed"] } } });

        expect(parsed.where).toEqual({ score: { gte: 10, lt: 100 }, status: { in: ["open", "closed"] } });
    });

    it("drops a predicate over an undeclared column, so a caller cannot filter on unpublished data", () => {
        expect.assertions(2);

        const parsed = parse({ where: { secretInternalFlag: true, status: "open" } }) as { where: Record<string, unknown> };

        expect(parsed.where.status).toBe("open");
        expect(parsed.where).not.toHaveProperty("secretInternalFlag");
    });

    it("rejects a value of the wrong type for a declared column", () => {
        expect.assertions(1);

        expect(() => parse({ where: { score: "not-a-number" } })).toThrow(ValidationError);
    });

    it("rejects an orderBy field outside the declared allow-list", () => {
        expect.assertions(2);

        expect(() => parse({ orderBy: [{ field: "score" }] })).not.toThrow();
        expect(() => parse({ orderBy: [{ field: "passwordHash" }] })).toThrow(ValidationError);
    });

    it("has no offset-paging arguments — paging is keyset only", () => {
        expect.assertions(3);

        expect(Object.keys(spec.args).toSorted((a, b) => a.localeCompare(b))).toEqual(["cursor", "limit", "orderBy", "where"]);
        expect(spec.args).not.toHaveProperty("page");
        expect(spec.args).not.toHaveProperty("offset");
    });
});

describe("defineListArgs — toQueryArgs", () => {
    it("applies the default limit when the caller omits one", () => {
        expect.assertions(1);

        expect(spec.toQueryArgs({}).limit).toBe(25);
    });

    it("clamps an oversized limit down to maxLimit rather than rejecting the request", () => {
        expect.assertions(2);

        expect(spec.toQueryArgs({ limit: 5000 }).limit).toBe(100);
        expect(defineListArgs({ filter: {}, maxLimit: 10, orderBy: [] }).toQueryArgs({ limit: 5000 }).limit).toBe(10);
    });

    it("floors a fractional limit and lifts a non-positive one to 1", () => {
        expect.assertions(3);

        expect(spec.toQueryArgs({ limit: 7.9 }).limit).toBe(7);
        expect(spec.toQueryArgs({ limit: 0 }).limit).toBe(1);
        expect(spec.toQueryArgs({ limit: -20 }).limit).toBe(1);
    });

    it("reshapes orderBy entries into the ctx.db `{ column: direction }[]` form, defaulting to asc", () => {
        expect.assertions(1);

        const args = spec.toQueryArgs({ orderBy: [{ direction: "desc", field: "score" }, { field: "_creationTime" }] });

        expect(args.orderBy).toEqual([{ score: "desc" }, { _creationTime: "asc" }]);
    });

    it("passes cursor and where straight through — the validator already constrained them", () => {
        expect.assertions(2);

        const args = spec.toQueryArgs({ cursor: "abc", where: { status: "open" } });

        expect(args.cursor).toBe("abc");
        expect(args.where).toEqual({ status: "open" });
    });

    it("omits absent keys instead of emitting undefined values", () => {
        expect.assertions(3);

        const args = spec.toQueryArgs({});

        expect(args).not.toHaveProperty("cursor");
        expect(args).not.toHaveProperty("where");
        expect(args).not.toHaveProperty("orderBy");
    });

    it("omits orderBy when the caller sends an empty list", () => {
        expect.assertions(1);

        expect(spec.toQueryArgs({ orderBy: [] })).not.toHaveProperty("orderBy");
    });
});

describe("defineListArgs — no sortable columns declared", () => {
    const fixed = defineListArgs({ filter: {}, orderBy: [] });

    it("refuses every orderBy field, including any sentinel-looking value", () => {
        expect.assertions(2);

        expect(() => parseValidatorMap(fixed.args as never, { orderBy: [{ field: "anything" }] }, "args")).toThrow(ValidationError);
        expect(() => parseValidatorMap(fixed.args as never, { orderBy: [{ field: "__never__" }] }, "args")).toThrow(ValidationError);
    });

    it("drops an unlisted orderBy field in toQueryArgs even when handed an unparsed object", () => {
        expect.assertions(2);

        // `toQueryArgs` is exported, so it re-checks the allow-list itself rather
        // than assuming the validator already ran.
        expect(fixed.toQueryArgs({ orderBy: [{ field: "passwordHash" as never }] })).not.toHaveProperty("orderBy");
        expect(spec.toQueryArgs({ orderBy: [{ field: "passwordHash" as never }, { field: "score" }] }).orderBy).toEqual([{ score: "asc" }]);
    });
});

describe("clampLimit", () => {
    it("falls back to the default when the value is absent or non-finite", () => {
        expect.assertions(3);

        expect(clampLimit(undefined, 25, 100)).toBe(25);
        expect(clampLimit(Number.NaN, 25, 100)).toBe(25);
        // A default above the ceiling is itself clamped — the ceiling always wins.
        expect(clampLimit(undefined, 500, 100)).toBe(100);
    });
});
