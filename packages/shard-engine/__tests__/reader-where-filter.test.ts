import { describe, expect, it } from "vitest";

import { isPushableWhere, whereFilter } from "../src/reader-where-filter";
import type { ValidatorLike } from "../src/schema-types";

const kind = (name: string): ValidatorLike => {
    return { kind: name };
};

const shape: Record<string, ValidatorLike> = {
    active: kind("boolean"),
    code: kind("string"),
    level: kind("bigint"),
    meta: kind("any"),
    orgId: kind("id"),
    parentId: kind("union"),
    score: kind("number"),
    title: { _meta: { inner: kind("string") }, kind: "optional" },
    userId: kind("string"),
};

/**
 * Which `where` trees the shard reader ANDs into its SQL (#822). A refused tree
 * still filters every row in memory; only an accepted one may keep a LIMIT, so
 * accepting one SQL answers differently from the JS matcher would hide rows.
 */
describe(isPushableWhere, () => {
    it.each([
        [{ userId: "u1" }],
        [{ userId: null }],
        [{ _id: "d1" }],
        [{ _creationTime: 5 }],
        [{ active: false, orgId: "o1" }],
        [{ title: "t" }],
        [{ userId: { in: ["a", "b", null] } }],
        [{ userId: { ne: "a" }, score: { notIn: [1, 2] } }],
        [{ title: { isNull: true } }],
        [{ OR: [{ userId: "u1" }, { active: true }] }],
        [{ AND: [{ userId: "u1" }, { OR: [{ code: "a" }, { code: { notIn: ["b"] } }] }] }],
    ])("pushes %o", (where) => {
        expect.assertions(1);
        expect(isPushableWhere(where as never, shape)).toBe(true);
    });

    it.each([
        // ordered comparisons: JS coerces across types, SQLite orders by storage class
        [{ score: { lt: 10 } }],
        [{ level: { lt: 10 } }],
        [{ code: { gt: 5 } }],
        // case folding differs
        [{ code: { contains: "a" } }],
        // an empty bag constrains nothing in JS and everything in SQL
        [{ userId: {} }],
        [{ NOT: { active: true } }],
        [{ OR: [{ userId: "u1" }, { NOT: { code: "x" } }] }],
        [{ AND: { userId: "u1" } }],
        [{ orgId: { is: { userId: "u1" } } }],
        [{ posts: { some: { published: true } } }],
        // an operand of another type than the column's
        [{ score: "5" }],
        [{ active: 1 }],
        [{ userId: { in: ["a", 1] } }],
        [{ level: 10n }],
        // columns with no single stored type, or unknown to the schema
        [{ level: { eq: "1" } }],
        [{ meta: "x" }],
        [{ parentId: "p" }],
        [{ missing: "x" }],
        [{ id: "d1" }],
        [{ userId: undefined }],
        [{ userId: { eq: undefined } }],
        [{ userId: ["a"] }],
        [{ userId: { key: "value" } }],
        [{ score: Number.NaN }],
        [{ userId: { in: "a" } }],
        [{ title: { isNull: "yes" } }],
    ])("keeps %o in memory", (where) => {
        expect.assertions(1);
        expect(isPushableWhere(where as never, shape)).toBe(false);
    });

    it.each([
        [{ userId: "u1" }, false],
        [{ _id: "d1" }, false],
        [{ orgId: { ne: "o1" } }, false],
        [{ OR: [{ score: 1 }, { code: { in: ["a"] } }] }, false],
        [{ score: 1, active: true }, true],
        [{ _creationTime: { notIn: [5] } }, true],
    ])("with inexact text equality (MySQL), %o pushes: %s", (where, pushed) => {
        expect.assertions(1);
        expect(isPushableWhere(where as never, shape, false)).toBe(pushed);
    });
});

describe(whereFilter, () => {
    it("runs the predicate it wraps", () => {
        expect.assertions(2);

        const filter = whereFilter({ userId: "u1" }, (row) => row["userId"] === "u1");

        expect(filter({ userId: "u1" })).toBe(true);
        expect(filter({ userId: "u2" })).toBe(false);
    });
});
