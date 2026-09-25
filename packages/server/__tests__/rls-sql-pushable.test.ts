import { describe, expect, it } from "vitest";

import { isSqlPushable } from "../src/rls/where-match";

/**
 * Which read policies the legacy `ctx.db.query()` reader pushes into SQL (#822).
 * The JS matcher still runs over every row either way; this only decides whether
 * SQL may pre-narrow the read, so a refused shape costs rows, never rows shown.
 */
describe(isSqlPushable, () => {
    it.each([
        [{ userId: "u1" }],
        [{ userId: null }],
        [{ archived: false, orgId: "o1" }],
        [{ role: { in: ["admin", "member"] } }],
        [{ role: { ne: "admin" }, score: { gte: 3, lt: 10 } }],
        [{ deletedAt: { isNull: true } }],
        [{ name: { contains: "ab" } }],
        [{ OR: [{ userId: "u1" }, { public: true }] }],
        [{ AND: [{ userId: "u1" }, { OR: [{ status: "a" }, { status: { notIn: ["b"] } }] }] }],
    ])("pushes %o", (where) => {
        expect.assertions(1);
        expect(isSqlPushable(where as never)).toBe(true);
    });

    it.each([
        [{ NOT: { hidden: true } }],
        [{ OR: [{ userId: "u1" }, { NOT: { status: "x" } }] }],
        [{ AND: { userId: "u1" } }],
        [{ author: { is: { userId: "u1" } } }],
        [{ posts: { some: { published: true } } }],
        [{ userId: undefined }],
        [{ userId: { eq: undefined } }],
        [{ tags: ["a"] }],
        [{ meta: { key: "value" } }],
        [{ createdAt: new Date(0) }],
        [{ amount: 10n }],
        [{ score: { gt: Number.NaN } }],
        [{ role: { in: "admin" } }],
        [{ role: { in: [undefined] } }],
    ])("keeps %o in memory", (where) => {
        expect.assertions(1);
        expect(isSqlPushable(where as never)).toBe(false);
    });
});
