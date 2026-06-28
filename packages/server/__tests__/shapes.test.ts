import { describe, expect, it } from "vitest";

import type { QueryCtx } from "../src/index";
import { defineShape, v } from "../src/index";

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
        expect(shape.where({} as QueryCtx, { channelId: "c1" })).toStrictEqual({ channelId: "c1" });
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
});
