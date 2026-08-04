import { v, ValidationError } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { parseValidatorMap } from "../src/functions";
import { clampLimit, defineListArgs } from "../src/list-args";

/** Stand-in for a generated `Doc<"messages">`; binding it is what makes typos compile errors. */
interface Message {
    _creationTime: number;
    authorId: string;
    score: number;
    status: string;
}

const spec = defineListArgs<Message>()({
    filter: { authorId: v.string(), score: v.number(), status: v.string() },
    orderBy: ["_creationTime", "score"],
});

/** Parse a raw argument object through the declared validator map, exactly as a procedure's `.input()` does. */
const parse = (raw: Record<string, unknown>): Record<string, unknown> => parseValidatorMap(spec.args as never, raw, "args");

describe("defineListArgs — Doc binding (compile-time)", () => {
    it("rejects a filter column that isn't on the document", () => {
        expect.assertions(1);

        // @ts-expect-error -- `madeUpColumn` is not a key of Message; before the Doc
        // binding this compiled and produced a filter that could never match.
        const bad = defineListArgs<Message>()({ filter: { madeUpColumn: v.string() }, orderBy: [] });

        expect(bad.args).toBeDefined();
    });

    it("rejects an orderBy field that isn't on the document", () => {
        expect.assertions(1);

        // @ts-expect-error -- "createdAt" does not exist on Message (it is `_creationTime`).
        const bad = defineListArgs<Message>()({ filter: {}, orderBy: ["createdAt"] });

        expect(bad.args).toBeDefined();
    });

    it("rejects a validator whose type contradicts the column", () => {
        expect.assertions(1);

        // @ts-expect-error -- `score` is a number on Message, so a string validator
        // would decode into a predicate the column can never satisfy.
        const bad = defineListArgs<Message>()({ filter: { score: v.string() }, orderBy: [] });

        expect(bad.args).toBeDefined();
    });

    it("accepts the columns the document really has", () => {
        expect.assertions(1);

        const good = defineListArgs<Message>()({ filter: { score: v.number(), status: v.string() }, orderBy: ["_creationTime"] });

        expect(Object.keys(good.args).toSorted((a, b) => a.localeCompare(b))).toEqual(["cursor", "limit", "orderBy", "where"]);
    });
});

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
        expect(defineListArgs<Message>()({ filter: {}, maxLimit: 10, orderBy: [] }).toQueryArgs({ limit: 5000 }).limit).toBe(10);
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
    const fixed = defineListArgs<Message>()({ filter: {}, orderBy: [] });

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

describe("defineListArgs — toQueryArgs hardening", () => {
    it("drops an undeclared field handed straight to toQueryArgs, bypassing the validator", () => {
        expect.assertions(2);

        // `toQueryArgs` is exported, so it cannot assume `.input()` already ran.
        const args = spec.toQueryArgs({ where: { secretFlag: true, status: "open" } as never });

        expect(args.where).toEqual({ status: "open" });
        expect(args.where).not.toHaveProperty("secretFlag");
    });

    it("cannot be used to reach a prototype key", () => {
        expect.assertions(2);

        const hostile = JSON.parse('{"where":{"__proto__":{"polluted":true},"constructor":{"x":1},"status":"open"}}') as { where: never };
        const args = spec.toQueryArgs(hostile);

        expect(args.where).toEqual({ status: "open" });
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("reduces an operator object to recognised operators only", () => {
        expect.assertions(1);

        const args = spec.toQueryArgs({ where: { score: { gte: 10, sqlInjection: "1=1" } } as never });

        expect(args.where).toEqual({ score: { gte: 10 } });
    });

    it("normalizes a nonsensical configured bound rather than emitting an out-of-contract limit", () => {
        expect.assertions(3);

        expect(defineListArgs<Message>()({ filter: {}, maxLimit: 0, orderBy: [] }).toQueryArgs({ limit: 50 }).limit).toBe(1);
        expect(defineListArgs<Message>()({ filter: {}, maxLimit: 10.9, orderBy: [] }).toQueryArgs({ limit: 50 }).limit).toBe(10);
        expect(defineListArgs<Message>()({ filter: {}, defaultLimit: Number.NaN, orderBy: [] }).toQueryArgs({}).limit).toBe(25);
    });
});

describe("defineListArgs — request-cost bounds", () => {
    it("rejects an oversized `in` array, which would become one bound parameter each", () => {
        expect.assertions(2);

        expect(() => parse({ where: { status: { in: Array.from({ length: 100 }).fill("x") } } })).not.toThrow();
        expect(() => parse({ where: { status: { in: Array.from({ length: 101 }).fill("x") } } })).toThrow(ValidationError);
    });

    it("honours a custom maxInValues", () => {
        expect.assertions(1);

        const tight = defineListArgs<Message>()({ filter: { status: v.string() }, maxInValues: 2, orderBy: [] });

        expect(() => parseValidatorMap(tight.args as never, { where: { status: { in: ["a", "b", "c"] } } }, "args")).toThrow(ValidationError);
    });

    it("caps an oversized in-array handed straight to toQueryArgs, not just through the validator", () => {
        expect.assertions(2);

        // This is the path that exists BECAUSE toQueryArgs is reachable without
        // `.input()`, so the cap has to hold here too or it protects nothing.
        // eslint-disable-next-line e18e/prefer-array-fill -- the `.fill("x")` rewrite infers `unknown[]`, so the mapped form is the one that type-checks
        const args = spec.toQueryArgs({ where: { status: { in: Array.from({ length: 5000 }, () => "x") } } });
        const predicate = (args.where as { status: { in: string[] } }).status;

        expect(predicate.in).toHaveLength(100);
        expect(
            defineListArgs<Message>()({ filter: { status: v.string() }, maxInValues: 3, orderBy: [] }).toQueryArgs({
                where: { status: { in: ["a", "b", "c", "d"] } },
            }).where,
        ).toEqual({ status: { in: ["a", "b", "c"] } });
    });

    it("caps how many orderBy entries reach the query", () => {
        expect.assertions(1);

        const wide = defineListArgs<{ a: number; b: number; c: number }>()({ filter: {}, maxOrderBy: 2, orderBy: ["a", "b", "c"] });

        expect(wide.toQueryArgs({ orderBy: [{ field: "a" }, { field: "b" }, { field: "c" }] }).orderBy).toHaveLength(2);
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
