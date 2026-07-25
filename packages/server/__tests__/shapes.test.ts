import { describe, expect, it } from "vitest";

import type { QueryCtx } from "../src/index";
import { allowAll, defineShape, deny, isDeny, v } from "../src/index";

/**
 * `defineShape` is a thin shape constructor: it brands the declaration with
 * `__lunoraShape` (so codegen discovers it through the type checker), validates
 * `table`/`columns` at module load, and otherwise passes the predicate through
 * untouched so the DO can run `where(ctx, args)` and AND-compose it with RLS.
 */
describe("defineShape", () => {
    it("brands the declaration and preserves every field", () => {
        expect.assertions(4);

        const shape = defineShape({
            args: { channelId: v.string() },
            columns: ["text", "authorId"],
            table: "messages",
            where: (_ctx, args) => {
                return { channelId: args.channelId };
            },
        });

        expect((shape as unknown as Record<string, unknown>)["__lunoraShape"]).toBe(true);
        expect(shape.table).toBe("messages");
        expect(shape.columns).toStrictEqual(["text", "authorId"]);
        // The predicate runs server-side with the trusted ctx + validated args.
        expect(shape.where?.({} as QueryCtx, { channelId: "c1" })).toStrictEqual({ channelId: "c1" });
    });

    it("keeps optional fields absent when not supplied", () => {
        expect.assertions(2);

        const shape = defineShape({
            table: "messages",
            where: () => {
                return {};
            },
        });

        expect(shape.args).toBeUndefined();
        expect(shape.columns).toBeUndefined();
    });

    it("throws when the table is empty or whitespace", () => {
        expect.assertions(2);

        expect(() =>
            defineShape({
                table: "",
                where: () => {
                    return {};
                },
            }),
        ).toThrow("`table` must be a non-empty string");
        expect(() =>
            defineShape({
                table: "   ",
                where: () => {
                    return {};
                },
            }),
        ).toThrow("`table` must be a non-empty string");
    });

    it("throws when columns is an empty array (replicates no data)", () => {
        expect.assertions(1);

        expect(() =>
            defineShape({
                columns: [],
                table: "messages",
                where: () => {
                    return {};
                },
            }),
        ).toThrow("`columns` must list at least one column");
    });

    it("throws when neither a predicate nor an owner is declared", () => {
        expect.assertions(1);

        // A shape with no restriction at all would replicate the whole table —
        // never the intent, and silent if allowed through.
        expect(() => defineShape({ table: "messages" })).toThrow("needs a `where` predicate or an `owner`");
    });
});

/**
 * The boolean sugar and the deny sentinel. `{ OR: [] }` is a disjunction over zero
 * branches (matches nothing); the plausible-looking `{}` is its exact opposite and
 * replicates the whole table, which is why `false`/`deny()` exist at all.
 */
describe("defineShape where sugar", () => {
    it("compiles `false` to the vacuously-false deny predicate", () => {
        expect.assertions(1);

        const shape = defineShape({
            table: "messages",
            where: () => false,
        });

        expect(shape.compileWhere({}, {})).toStrictEqual(deny());
    });

    it("compiles `true` to an unrestricted predicate", () => {
        expect.assertions(1);

        const shape = defineShape({
            table: "messages",
            where: () => true,
        });

        expect(shape.compileWhere({}, {})).toStrictEqual(allowAll());
    });

    it("names the deny sentinel so a call site never writes the literal", () => {
        expect.assertions(3);

        expect(deny()).toStrictEqual({ OR: [] });
        expect(isDeny(deny())).toBe(true);
        // The dangerous near-miss: `{}` matches EVERY row.
        expect(isDeny(allowAll())).toBe(false);
    });
});

/**
 * `owner` derives the ownership predicate from the socket's verified identity, so
 * the check is declared once (on the table, via `.ownedBy`) instead of restated in
 * every shape — and a client can't request another user's partition even by lying
 * about `args`.
 */
describe("defineShape owner", () => {
    it("derives the predicate from the table's ownedBy field", () => {
        expect.assertions(1);

        const shape = defineShape({ owner: true, table: "nodes" });

        expect(shape.compileWhere({ auth: { userId: "u1" } }, {}, { ownerField: "userId" })).toStrictEqual({ userId: "u1" });
    });

    it("accepts an explicit owner column for a table without ownedBy", () => {
        expect.assertions(1);

        const shape = defineShape({ owner: "authorId", table: "posts" });

        expect(shape.compileWhere({ auth: { userId: "u1" } }, {})).toStrictEqual({ authorId: "u1" });
    });

    it("aND-composes the owner predicate with the shape's own where", () => {
        expect.assertions(1);

        const shape = defineShape({
            args: { archived: v.boolean() },
            owner: "userId",
            table: "nodes",
            where: (_ctx, args) => {
                return { archived: args.archived };
            },
        });

        expect(shape.compileWhere({ auth: { userId: "u1" } }, { archived: false })).toStrictEqual({
            AND: [{ userId: "u1" }, { archived: false }],
        });
    });

    it("denies an anonymous subscriber instead of filtering on null", () => {
        expect.assertions(2);

        const shape = defineShape({ owner: "userId", table: "nodes" });

        // A nullable owner column would MATCH `{ userId: null }`, so the anonymous
        // case has to deny outright rather than fall through to a predicate.
        expect(shape.compileWhere({ auth: { userId: null } }, {})).toStrictEqual(deny());
        expect(shape.compileWhere({}, {})).toStrictEqual(deny());
    });

    it("throws when `owner: true` has no ownedBy field to resolve", () => {
        expect.assertions(1);

        const shape = defineShape({ owner: true, table: "nodes" });

        expect(() => shape.compileWhere({ auth: { userId: "u1" } }, {})).toThrow("declares `owner: true` but the table has no `.ownedBy(field)`");
    });

    it("ignores a client-supplied userId arg — the filter comes from the verified identity", () => {
        expect.assertions(1);

        const shape = defineShape({
            args: { userId: v.string() },
            owner: "userId",
            table: "nodes",
        });

        // The client asks for someone else's partition; the derived predicate still
        // scopes to the socket's own identity.
        expect(shape.compileWhere({ auth: { userId: "u1" } }, { userId: "victim" })).toStrictEqual({ userId: "u1" });
    });
});
